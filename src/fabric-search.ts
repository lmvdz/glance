/**
 * fabric-search.ts — the queryable layer over the context fabric.
 *
 * The fabric ([[src/fabric.ts]]) already distills everything we know across
 * plans/agents/receipts into a scoped FabricSnapshot. This turns that snapshot
 * into a SEARCHABLE knowledge base: flatten every fact into a document, rank
 * documents against a query with BM25, and (for agents) distill the top hits
 * into a fenced "context primer" injected at cold-start so a fresh agent draws
 * on prior work instead of starting blind.
 *
 * Pure: no fetch, no fs, no React. The snapshot is already built + scoped by the
 * caller, so search never widens visibility — it only ranks what the actor may
 * already see. Trivially unit-testable, mirroring insights.ts / heatmap.ts.
 */

import { fenceUntrusted, parseDigestReward, rewardWeight } from "./digest.ts";
import type { FabricSnapshot } from "./fabric.ts";
import { isOn, learningFlags } from "./metrics.ts";

export type KbDocType = "agent" | "digest" | "hot-area" | "scout" | "lease" | "decision" | "failure" | "symptom" | "episode" | "answer";

/** A flattened, searchable unit of knowledge. */
export interface KbDoc {
	type: KbDocType;
	id: string;
	title: string;
	/** searchable body (title is also indexed, weighted higher). */
	text: string;
	repo?: string;
	/** a human/machine pointer back to the source (file, issue id, agent id, feature id). */
	ref?: string;
	/** intrinsic importance (e.g. hot-area recency score) used as a mild prior. */
	weight?: number;
	/** Retrieval provenance (concern 02): a short human "where this came from" label, e.g. "agent a1",
	 *  "scout", "human decision". Additive/optional — never used for ranking, only surfaced. */
	source?: string;
	/** Retrieval provenance (concern 02): epoch ms the underlying fact was produced, when known
	 *  (a decision's `createdAt`, a scout finding's `filedAt`, a digest's run `endedAt`). Absent when
	 *  no timestamp exists for this fact type — never fabricated. */
	ts?: number;
}

export interface FabricSearchResult {
	type: KbDocType;
	id: string;
	title: string;
	snippet: string;
	score: number;
	repo?: string;
	ref?: string;
	/** Provenance (concern 02) — see `KbDoc.source`/`KbDoc.ts`. Additive; absent is not an error. */
	source?: string;
	ranAt?: number;
}

// ───────────────────────────── tokenization ─────────────────────────────

/** Lowercase, split camelCase, then split on any non-alphanumeric (covers paths, dots, slashes). */
export function tokenize(text: string): string[] {
	if (!text) return [];
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);
}

// ───────────────────────────── flatten ─────────────────────────────

const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Flatten a snapshot into ranked-search documents — one per fact. */
export function fabricDocuments(snapshot: FabricSnapshot): KbDoc[] {
	const docs: KbDoc[] = [];

	for (const a of snapshot.agents) {
		const g = a.agent;
		const bits = [g.name, g.status, g.activity, g.todo?.active, g.issue?.identifier, g.issue?.name, g.repo].filter(Boolean);
		docs.push({ type: "agent", id: `agent:${g.id}`, title: `${g.name} · ${g.status}`, text: bits.join(" "), repo: g.repo, ref: g.id, source: `agent ${g.id}` });
	}

	// Reward-boost (concern 03, OMP_SQUAD_REWARD_BOOST): a digest tagged fresh-checked-green ranks
	// higher in retrieval — boost-only, folded through the SAME KbDoc.weight BM25 prior hot-area
	// already uses (searchFabric), never a new ranking path. Flag off (default) ⇒ every digest keeps
	// its untouched baseline (weight undefined), i.e. today's behaviour exactly.
	const boostDigests = isOn(learningFlags().rewardBoost);
	for (const d of snapshot.digests) {
		const weight = boostDigests ? rewardWeight(parseDigestReward(d.digest)) : undefined;
		docs.push({ type: "digest", id: `digest:${d.source.agentId ?? d.source.runId ?? docs.length}`, title: `Session memory · ${d.source.agentId ?? "agent"}`, text: d.digest, repo: d.source.repo, ref: d.source.agentId, source: `agent ${d.source.agentId ?? "?"}`, ts: d.ts, weight });
	}

	for (const h of snapshot.hotAreas) {
		docs.push({ type: "hot-area", id: `hot:${h.repo}:${h.file}`, title: h.file, text: `${h.file} ${h.repo}`, repo: h.repo, ref: h.file, weight: h.score, source: `repo ${h.repo}` });
	}

	for (const s of snapshot.scout) {
		docs.push({ type: "scout", id: `scout:${s.issue.identifier ?? s.issue.id}`, title: s.title, text: `${s.title} ${s.issue.identifier ?? ""}`, repo: s.source.repo, ref: s.issue.url ?? s.issue.identifier, source: "scout", ts: s.filedAt });
	}

	for (const l of snapshot.leases) {
		docs.push({ type: "lease", id: `lease:${l.lease.repo}:${l.lease.file}`, title: `${l.lease.file} (held by ${l.lease.session})`, text: `${l.lease.file} ${l.lease.session} ${l.lease.repo}`, repo: l.lease.repo, ref: l.lease.file, source: `held by ${l.lease.session}` });
	}

	for (const dec of snapshot.decisions) {
		// Doc id carries the REAL FeatureDecision id (not a positional synthetic): kb-search surfaces
		// it so an agent recording a reversal can pass it as `supersedes` — the id an agent can see
		// must be the id the write path accepts.
		docs.push({ type: "decision", id: `decision:${dec.id}`, title: `Decision · ${dec.featureTitle}`, text: `${dec.text} ${dec.featureTitle}`, repo: dec.source.repo, ref: dec.source.featureId, source: dec.decisionSource ? `${dec.decisionSource} decision` : "decision", ts: dec.createdAt });
	}

	// Recurring-failure memory (concern 05, OMP_SQUAD_FAILURE_MEMORY): warn the next agent it's about
	// to retry a KNOWN-recurring failure. Flag on by default (skills-hardening concern 05) ⇒ failure
	// docs surface unless the operator explicitly sets the env var to "0" (off-means-off either way).
	if (isOn(learningFlags().failureMemory)) {
		for (const fl of snapshot.failures) {
			docs.push({ type: "failure", id: `failure:${fl.fingerprint}`, title: `Recurring failure · ${fl.branch}`, text: `${fl.rootCause} ${fl.branch}`, repo: fl.source.repo, ref: fl.fingerprint, source: "recurring failure", ts: fl.at });
		}
	}

	// Known-symptom cards (comprehension concern 07): searchable via `glance symptom`/⌘K and folded
	// into the cold-start primer for free, alongside decisions/hot-areas — the whole point of a
	// symptom card is that a FUTURE unit (or the doctor) can find it without knowing this happened
	// before. `text` carries whereToLook too, per DESIGN.md's "reuse fabric-search's BM25 over
	// symptom+whereToLook text". `?? []`: a snapshot minted by an older daemon (federation peer, a
	// serialized snapshot from before this field existed) simply has no symptom docs — that must read
	// as "none", never crash the search that's ranking everything else.
	for (const s of snapshot.symptoms ?? []) {
		docs.push({ type: "symptom", id: `symptom:${s.id}`, title: s.symptom, text: `${s.symptom} ${s.whereToLook.join(" ")}`, repo: s.source.repo, ref: s.whereToLook[0], source: "symptom", ts: s.landedAt });
	}

	// Weekly episodes (comprehension concern 09): only the excerpt (first paragraph + top-3 debt
	// files) is ever indexed — DESIGN.md's "full markdown NEVER in the BM25 corpus" — so a hit here
	// points the reader at `GET /api/episodes/:id` for the real brief, never inlines it. `?? []`:
	// same forward/backward-compat reasoning as `snapshot.symptoms` above.
	for (const e of snapshot.episodes ?? []) {
		docs.push({ type: "episode", id: `episode:${e.id}`, title: `Weekly episode · ${e.id}`, text: e.excerpt, repo: e.source.repo, ref: e.id, source: "weekly episode", ts: e.windowEnd });
	}

	// Recorded ask→fabric answers (comprehension concern 10): searchable via ⌘K/fabric and folded
	// into the cold-start primer, alongside every other fact type — `text` is the capped excerpt
	// ONLY (`FabricAnswerFact.answerExcerpt`), never the full untrusted markdown. `?? []`: same
	// forward/backward-compat reasoning as `snapshot.symptoms`/`snapshot.episodes` above.
	for (const a of snapshot.answers ?? []) {
		docs.push({ type: "answer", id: `answer:${a.id}`, title: a.question, text: a.answerExcerpt, repo: a.source.repo, ref: a.id, source: "answer", ts: a.answeredAt });
	}

	return docs;
}

// ───────────────────────────── BM25 ─────────────────────────────

const K1 = 1.5;
const B = 0.75;
/** Title tokens count this many times, so a title hit outranks a body-only hit. */
const TITLE_BOOST = 2;

interface Indexed {
	doc: KbDoc;
	tf: Map<string, number>;
	len: number;
}

function indexDoc(doc: KbDoc): Indexed {
	const tf = new Map<string, number>();
	const add = (text: string, times: number) => {
		for (const tok of tokenize(text)) tf.set(tok, (tf.get(tok) ?? 0) + times);
	};
	add(doc.title, TITLE_BOOST);
	add(doc.text, 1);
	let len = 0;
	for (const n of tf.values()) len += n;
	return { doc, tf, len: len || 1 };
}

function snippetFor(doc: KbDoc, terms: string[]): string {
	const body = doc.text.replace(/\s+/g, " ").trim();
	if (!body) return doc.title;
	const lower = body.toLowerCase();
	let hit = -1;
	for (const t of terms) {
		const idx = lower.indexOf(t);
		if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
	}
	if (hit < 0) return trim(body, 140);
	const start = Math.max(0, hit - 40);
	return `${start > 0 ? "…" : ""}${trim(body.slice(start), 160)}`;
}

/**
 * BM25-rank an arbitrary `KbDoc[]` corpus against `query`. This is the reusable scoring core
 * `searchFabric` (below) drives off a fabric snapshot's flattened docs — but any other caller with
 * its OWN doc set (comprehension concern 07: `GET /api/symptoms` ranking `listSymptoms` entries, and
 * `glance doctor`'s symptom auto-match) reuses this directly instead of forking the BM25 math.
 * Returns the top `topK` (default 20).
 */
export function rankKbDocs(docs: KbDoc[], query: string, opts: { topK?: number } = {}): FabricSearchResult[] {
	const terms = [...new Set(tokenize(query))];
	if (docs.length === 0 || terms.length === 0) return [];

	const indexed = docs.map(indexDoc);
	const N = indexed.length;
	const avgdl = indexed.reduce((sum, d) => sum + d.len, 0) / N;
	const df = new Map<string, number>();
	for (const term of terms) df.set(term, indexed.filter((d) => d.tf.has(term)).length);

	const scored = indexed.map(({ doc, tf, len }) => {
		let score = 0;
		for (const term of terms) {
			const f = tf.get(term);
			if (!f) continue;
			const n = df.get(term) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgdl)));
		}
		if (score > 0 && doc.weight) score *= 1 + Math.log1p(doc.weight) / 10; // mild recency/importance prior
		return { doc, score };
	});

	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
		.slice(0, opts.topK ?? 20)
		.map(({ doc, score }) => ({ type: doc.type, id: doc.id, title: doc.title, snippet: snippetFor(doc, terms), score, repo: doc.repo, ref: doc.ref, source: doc.source, ranAt: doc.ts }));
}

/**
 * BM25-rank the snapshot's documents against `query`. A small log-scaled
 * hot-area weight is folded in so a hot file beats a cold one on an equal text
 * match. Returns the top `topK` (default 20), optionally filtered to one type.
 */
export function searchFabric(
	snapshot: FabricSnapshot,
	query: string,
	opts: { topK?: number; type?: KbDocType } = {},
): FabricSearchResult[] {
	let docs = fabricDocuments(snapshot);
	if (opts.type) docs = docs.filter((d) => d.type === opts.type);
	return rankKbDocs(docs, query, { topK: opts.topK });
}

/**
 * C5 regime classifier (plans/research-long-horizon-agent-memory/VALIDATION.md, refined by the
 * five-corpus retrieval study in arXiv 2607.21503): lexical vs dense retrieval win in different
 * REGIMES — keyword decisively where the query carries specific entities, dense decisively across
 * wide semantic gaps. So every zero-result kb search is logged with its regime, and the
 * add-a-vector-channel question is decided by the SEMANTIC-GAP share alone, never by aggregate
 * miss volume. Heuristic, deliberately cheap: a query is "entity" when any token looks like an
 * opaque identifier — path, hex hash, uuid, CLI flag, issue key, camelCase/snake_case symbol, or
 * SCREAMING_CASE constant. Everything else is "semantic" (natural-language description with no
 * shared vocabulary guarantee). Misclassification is expected and bounded: the calibration step
 * hand-labels a sample and the kill threshold must clear the measured noise floor first.
 */
export function classifyQueryShape(query: string): "entity" | "semantic" {
	const ENTITY = [
		/[a-z0-9_-]+\/[a-z0-9_./-]+/i, // path-like
		/\b[0-9a-f]{7,}\b/i, // hex hash
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // uuid
		/(^|\s)--[a-z][a-z0-9-]+/i, // CLI flag
		/\b[A-Z][A-Z0-9]+-\d+\b/, // issue key (OMPSQ-12)
		/\b[a-z]+[A-Z][a-zA-Z0-9]*\b/, // camelCase
		/\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/, // PascalCase (blind-review: symbol names under-fired)
		/\b[a-z0-9]+_[a-z0-9_]+\b/, // snake_case
		/\b[A-Z][A-Z0-9_]{3,}\b/, // SCREAMING_CASE
		/\.[a-z]{2,4}\b/, // file extension
	];
	return ENTITY.some((re) => re.test(query)) ? "entity" : "semantic";
}

// ───────────────────────────── agent cold-start primer ─────────────────────────────

const PRIMER_LABEL: Record<KbDocType, string> = {
	decision: "Decision",
	"hot-area": "Hot file",
	digest: "Prior session",
	agent: "Active agent",
	scout: "Latent work",
	lease: "Being edited",
	failure: "Recurring failure",
	symptom: "Known symptom",
	episode: "Weekly episode",
	answer: "Answered question",
};

/** Coarse "how long ago" label for a provenance timestamp. Undefined input ⇒ undefined output
 *  (never fabricates an age for a fact with no timestamp). */
function agoLabel(ts: number | undefined, now: number): string | undefined {
	if (!ts) return undefined;
	const mins = Math.round(Math.max(0, now - ts) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * Distill the top KB hits for `query` into a compact markdown primer for a freshly-spawned agent
 * — so it inherits prior decisions, hot files, and peer context with ZERO cold-start turn cost.
 * Returns "" when nothing is relevant (callers inject nothing in that case — never an empty
 * fence). Every non-empty result is wrapped in `fenceUntrusted` INTERNALLY (concern 02): the
 * caller must NOT fence it again — this is the one place that guarantee is enforced, so no future
 * injector of primer content can forget it.
 *
 * Provenance (concern 02, additive only): each line carries its source + rough age when known
 * (`(src: agent a1, 2h ago)`), and a hit scoring well below the top match for this query is
 * labelled `(weak match)` rather than dropped — a novel task with only weak leads must still get
 * a primer; a hard confidence floor would silently empty it exactly when orientation matters most.
 *
 * Rendering (skills-hardening concern 05): a `"failure"`-type hit's body is prefixed with
 * "Do not repeat: " so the injected line reads as an imperative instruction, not a passive
 * description — the label taxonomy (`PRIMER_LABEL`) is untouched, only the body text changes.
 */
/** Render one primer line — shared by pinned docs and ranked hits so both regions read
 *  identically. `weak` is only ever set for ranked hits: a pinned fact is present by STATE, and
 *  labeling it "weak match" would invite the model to discount exactly the line that must hold. */
function primerLine(opts: { type: KbDocType; title: string; body: string; source?: string; ts?: number; now: number; weak?: boolean }): string {
	const provenance: string[] = [];
	if (opts.source) provenance.push(`src: ${opts.source}`);
	const ago = agoLabel(opts.ts, opts.now);
	if (ago) provenance.push(ago);
	if (opts.weak) provenance.push("weak match");
	const suffix = provenance.length ? ` (${provenance.join(", ")})` : "";
	const imperative = opts.type === "failure" ? "Do not repeat: " : "";
	return `- **${PRIMER_LABEL[opts.type]}** — ${imperative}${trim(`${opts.title}: ${opts.body}`.replace(/\s+/g, " ").trim(), 200)}${suffix}`;
}

/** Primer region caps and the deterministic character budget (~800 tokens). Exported for tests. */
export const PRIMER_BUDGET = { failures: 3, decisions: 4, chars: 3200 } as const;

/**
 * The primer is REGION-PARTITIONED, not one relevance ranking (research-memory-eval-harness
 * Rank 1; HARNESS-SPEC G09). The failure this prevents is structural: a constraint like "do not
 * repeat X" has near-zero lexical overlap with the task query that violates it, so any pure
 * ranking eventually evicts exactly the line that mattered, exactly when it matters.
 *
 *   Region 1 — governance: recurring-failure warnings, pinned UNCONDITIONALLY (most recent
 *     first, capped). Never evicted for other content; the budget cannot touch them.
 *   Region 2 — settled state: currently-valid decisions, pinned (superseded decisions never
 *     reach the snapshot — fabric.ts excludes them at projection). Evicted only after Region 3
 *     is empty, oldest first.
 *   Region 3 — episodic: everything else, ranked by relevance as before. First to be evicted
 *     under budget pressure.
 *
 * Consequence, deliberate: an irrelevant query no longer yields an empty primer when pinned
 * facts exist — current decisions and standing warnings are relevant BY STATE, not by query.
 * "" still means "this actor's world holds nothing pinned and nothing relevant".
 */
export function buildContextPrimer(snapshot: FabricSnapshot, query: string, opts: { topK?: number; now?: number; budgetChars?: number } = {}): string {
	const now = opts.now ?? Date.now();
	const budget = opts.budgetChars ?? PRIMER_BUDGET.chars;
	// Recency sort with an id tie-break: Array.sort is spec-stable, but the tie-break makes
	// determinism independent of upstream assembly order rather than reliant on it (I3).
	const byTsDesc = (a: KbDoc, b: KbDoc): number => (b.ts ?? 0) - (a.ts ?? 0) || a.id.localeCompare(b.id);
	const docs = fabricDocuments(snapshot);
	const pinnedFailures = docs.filter((d) => d.type === "failure").sort(byTsDesc).slice(0, PRIMER_BUDGET.failures);
	const pinnedDecisions = docs.filter((d) => d.type === "decision").sort(byTsDesc).slice(0, PRIMER_BUDGET.decisions);
	const pinnedIds = new Set([...pinnedFailures, ...pinnedDecisions].map((d) => d.id));

	// Region 3 excludes the pinned TYPES wholesale, not just the pinned ids (blind-review
	// finding): with an id-only filter, a repo carrying more failures/decisions than the caps
	// could re-enter the overflow through the ranked region — making the caps pin-only fiction
	// and the region boundaries advisory. Pinned types are pinned-or-absent.
	const topK = opts.topK ?? 6;
	const ranked = searchFabric(snapshot, query, { topK: topK + pinnedIds.size })
		.filter((r) => r.type !== "failure" && r.type !== "decision")
		.slice(0, topK);

	if (pinnedIds.size === 0 && ranked.length === 0) return "";
	const topScore = ranked[0]?.score ?? 0;

	const region1 = pinnedFailures.map((d) => primerLine({ type: d.type, title: d.title, body: d.text, source: d.source, ts: d.ts, now }));
	const region2 = pinnedDecisions.map((d) => primerLine({ type: d.type, title: d.title, body: d.text, source: d.source, ts: d.ts, now }));
	const region3 = ranked.map((r) => primerLine({ type: r.type, title: r.title, body: r.snippet, source: r.source, ts: r.ranAt, now, weak: topScore > 0 && r.score < topScore * 0.4 }));

	// Deterministic budget eviction: drop Region 3 from the bottom, then Region 2 from the bottom
	// (oldest — the lists are recency-sorted), NEVER Region 1. If constraints alone exceed the
	// budget, they all stay: a truncated warning is a governance failure, an over-budget primer is
	// a cost. (HARNESS-SPEC G09's kill condition is a constraint losing its slot to episodic chat.)
	const header = "### Related context from prior work (read-only, may be stale):";
	const assemble = (): string => [header, ...region1, ...region2, ...region3].join("\n");
	while (assemble().length > budget && region3.length > 0) region3.pop();
	while (assemble().length > budget && region2.length > 0) region2.pop();
	// Eviction can empty every region (no pinned facts + a budget below the smallest ranked
	// line). A header announcing nothing is not a primer (blind-review finding) — "" keeps the
	// caller's inject-nothing contract.
	if (region1.length + region2.length + region3.length === 0) return "";
	return fenceUntrusted("context primer", assemble());
}
