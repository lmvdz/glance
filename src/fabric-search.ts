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

import type { FabricSnapshot } from "./fabric.ts";

export type KbDocType = "agent" | "digest" | "hot-area" | "scout" | "lease" | "decision";

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
}

export interface FabricSearchResult {
	type: KbDocType;
	id: string;
	title: string;
	snippet: string;
	score: number;
	repo?: string;
	ref?: string;
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
		docs.push({ type: "agent", id: `agent:${g.id}`, title: `${g.name} · ${g.status}`, text: bits.join(" "), repo: g.repo, ref: g.id });
	}

	for (const d of snapshot.digests) {
		docs.push({ type: "digest", id: `digest:${d.source.agentId ?? d.source.runId ?? docs.length}`, title: `Session memory · ${d.source.agentId ?? "agent"}`, text: d.digest, repo: d.source.repo, ref: d.source.agentId });
	}

	for (const h of snapshot.hotAreas) {
		docs.push({ type: "hot-area", id: `hot:${h.repo}:${h.file}`, title: h.file, text: `${h.file} ${h.repo}`, repo: h.repo, ref: h.file, weight: h.score });
	}

	for (const s of snapshot.scout) {
		docs.push({ type: "scout", id: `scout:${s.issue.identifier ?? s.issue.id}`, title: s.title, text: `${s.title} ${s.issue.identifier ?? ""}`, repo: s.source.repo, ref: s.issue.url ?? s.issue.identifier });
	}

	for (const l of snapshot.leases) {
		docs.push({ type: "lease", id: `lease:${l.lease.repo}:${l.lease.file}`, title: `${l.lease.file} (held by ${l.lease.session})`, text: `${l.lease.file} ${l.lease.session} ${l.lease.repo}`, repo: l.lease.repo, ref: l.lease.file });
	}

	for (const [i, dec] of snapshot.decisions.entries()) {
		docs.push({ type: "decision", id: `decision:${dec.source.featureId ?? i}:${i}`, title: `Decision · ${dec.featureTitle}`, text: `${dec.text} ${dec.featureTitle}`, repo: dec.source.repo, ref: dec.source.featureId });
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
 * BM25-rank the snapshot's documents against `query`. A small log-scaled
 * hot-area weight is folded in so a hot file beats a cold one on an equal text
 * match. Returns the top `topK` (default 20), optionally filtered to one type.
 */
export function searchFabric(
	snapshot: FabricSnapshot,
	query: string,
	opts: { topK?: number; type?: KbDocType } = {},
): FabricSearchResult[] {
	const terms = [...new Set(tokenize(query))];
	let docs = fabricDocuments(snapshot);
	if (opts.type) docs = docs.filter((d) => d.type === opts.type);
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
		.map(({ doc, score }) => ({ type: doc.type, id: doc.id, title: doc.title, snippet: snippetFor(doc, terms), score, repo: doc.repo, ref: doc.ref }));
}

// ───────────────────────────── agent cold-start primer ─────────────────────────────

const PRIMER_LABEL: Record<KbDocType, string> = {
	decision: "Decision",
	"hot-area": "Hot file",
	digest: "Prior session",
	agent: "Active agent",
	scout: "Latent work",
	lease: "Being edited",
};

/**
 * Distill the top KB hits for `query` into a compact, fenced markdown primer for
 * a freshly-spawned agent — so it inherits prior decisions, hot files, and peer
 * context with ZERO cold-start turn cost. Returns "" when nothing is relevant
 * (callers should then inject nothing). Caller is responsible for fencing as
 * untrusted, same as the resume-digest path.
 */
export function buildContextPrimer(snapshot: FabricSnapshot, query: string, opts: { topK?: number } = {}): string {
	const results = searchFabric(snapshot, query, { topK: opts.topK ?? 6 });
	if (results.length === 0) return "";
	const lines = results.map((r) => `- **${PRIMER_LABEL[r.type]}** — ${trim(`${r.title}: ${r.snippet}`.replace(/\s+/g, " ").trim(), 200)}`);
	return ["### Related context from prior work (read-only, may be stale):", ...lines].join("\n");
}
