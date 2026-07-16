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

	for (const [i, dec] of snapshot.decisions.entries()) {
		docs.push({ type: "decision", id: `decision:${dec.source.featureId ?? i}:${i}`, title: `Decision · ${dec.featureTitle}`, text: `${dec.text} ${dec.featureTitle}`, repo: dec.source.repo, ref: dec.source.featureId, source: dec.decisionSource ? `${dec.decisionSource} decision` : "decision", ts: dec.createdAt });
	}

	// Recurring-failure memory (concern 05, OMP_SQUAD_FAILURE_MEMORY): warn the next agent it's about
	// to retry a KNOWN-recurring failure. Flag off (default) ⇒ no failure docs surface even if some
	// were annotated while the flag was previously on (consistent with reward-boost's off-means-off).
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
 */
export function buildContextPrimer(snapshot: FabricSnapshot, query: string, opts: { topK?: number; now?: number } = {}): string {
	const results = searchFabric(snapshot, query, { topK: opts.topK ?? 6 });
	if (results.length === 0) return "";
	const now = opts.now ?? Date.now();
	const topScore = results[0]!.score;
	const lines = results.map((r) => {
		const provenance: string[] = [];
		if (r.source) provenance.push(`src: ${r.source}`);
		const ago = agoLabel(r.ranAt, now);
		if (ago) provenance.push(ago);
		if (topScore > 0 && r.score < topScore * 0.4) provenance.push("weak match");
		const suffix = provenance.length ? ` (${provenance.join(", ")})` : "";
		return `- **${PRIMER_LABEL[r.type]}** — ${trim(`${r.title}: ${r.snippet}`.replace(/\s+/g, " ").trim(), 200)}${suffix}`;
	});
	const body = ["### Related context from prior work (read-only, may be stale):", ...lines].join("\n");
	return fenceUntrusted("context primer", body);
}
