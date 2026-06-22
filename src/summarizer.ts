/**
 * Local extractive summarizer — vendored, zero-token, zero-install.
 *
 * Pure-TS port of recall's TF-IDF + TextRank (the numpy backend is dropped —
 * there is no numpy in JS, and the pure path produces the identical summary):
 *   1. split into stopword-filtered sentences
 *   2. build L2-normalized TF-IDF vectors per sentence
 *   3. cosine-similarity graph between sentences (zero diagonal)
 *   4. TextRank = PageRank power iteration over that graph
 *   5. keep the top-k sentences in their ORIGINAL order
 *
 * Nothing leaves the machine; no dependency required.
 *
 * ponytail: sparse-map TF-IDF + O(n^2) cosine, capped at the last 400 sentences
 * (_MAX_RANK) to bound cost. A dense matrix / blocked similarity only matters if
 * the cap ever rises past a few thousand sentences.
 */

const SENT_SPLIT = /(?<=[.!?])\s+|\n+/;
const TOKEN = /[a-zA-Z][a-zA-Z']+/g;
const MIN_LEN = 24; // drop trivially short fragments
const MAX_RANK = 400; // cap sentences ranked (keep most recent) to bound cost
const DAMPING = 0.85;
const MAX_ITERS = 100;
const TOL = 1e-6;

// Ported verbatim from recall's _STOPWORDS (whitespace-split into a set).
const STOPWORDS = new Set(
	(
		"the a an and or but if then else of to in on at for with from by as is are was " +
		"were be been being this that these those it its i you we they he she them us our " +
		"your their not no do does did so than too very can will just into out up down over " +
		"about which who whom what when where why how all any each more most other some such " +
		"only own same s t don now i'll i've it's we'll let me here there"
	).split(/\s+/),
);

export function splitSentences(text: string): string[] {
	const out: string[] = [];
	for (const raw of (text || "").split(SENT_SPLIT)) {
		const s = raw.split(/\s+/).filter(Boolean).join(" "); // collapse whitespace
		if (s.length >= MIN_LEN) out.push(s);
	}
	return out;
}

function tokenize(sentence: string): string[] {
	const matches = sentence.toLowerCase().match(TOKEN) || [];
	return matches.filter((w) => !STOPWORDS.has(w) && w.length > 2);
}

function idf(tokens: string[][]): Map<string, number> {
	const n = tokens.length;
	const df = new Map<string, number>();
	for (const toks of tokens) {
		for (const w of new Set(toks)) df.set(w, (df.get(w) || 0) + 1);
	}
	const out = new Map<string, number>();
	for (const [w, d] of df) out.set(w, Math.log((1.0 + n) / (1.0 + d)) + 1.0);
	return out;
}

function tfidfSparse(tokens: string[][], idfMap: Map<string, number>): Map<string, number>[] {
	const vecs: Map<string, number>[] = [];
	for (const toks of tokens) {
		const vec = new Map<string, number>();
		if (toks.length === 0) {
			vecs.push(vec);
			continue;
		}
		const tf = new Map<string, number>();
		for (const w of toks) tf.set(w, (tf.get(w) || 0) + 1);
		const length = toks.length;
		let sq = 0;
		for (const [w, c] of tf) {
			const v = (c / length) * (idfMap.get(w) as number);
			vec.set(w, v);
			sq += v * v;
		}
		const norm = Math.sqrt(sq) || 1.0;
		for (const [w, v] of vec) vec.set(w, v / norm);
		vecs.push(vec);
	}
	return vecs;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
	if (a.size > b.size) [a, b] = [b, a];
	let sum = 0;
	for (const [w, val] of a) sum += val * (b.get(w) || 0);
	return sum;
}

function textrank(tokens: string[][], idfMap: Map<string, number>): number[] {
	const vecs = tfidfSparse(tokens, idfMap);
	const n = vecs.length;
	const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const c = cosine(vecs[i], vecs[j]);
			if (c) {
				sim[i][j] = c;
				sim[j][i] = c;
			}
		}
	}
	const rowSum = sim.map((row) => row.reduce((s, v) => s + v, 0));

	let scores = new Array<number>(n).fill(1.0 / n);
	const base = (1.0 - DAMPING) / n;
	for (let iter = 0; iter < MAX_ITERS; iter++) {
		const next = new Array<number>(n).fill(base);
		for (let i = 0; i < n; i++) {
			if (rowSum[i] === 0.0) continue;
			const share = (DAMPING * scores[i]) / rowSum[i];
			const row = sim[i];
			for (let j = 0; j < n; j++) {
				const w = row[j];
				if (w) next[j] += share * w;
			}
		}
		let delta = 0;
		for (let i = 0; i < n; i++) delta += Math.abs(next[i] - scores[i]);
		scores = next;
		if (delta < TOL) break;
	}
	return scores;
}

function select(sentences: string[], scores: number[], k: number): string[] {
	const order = Array.from({ length: sentences.length }, (_, i) => i);
	// round to 10 places (matches recall's round(score, 10)) so sub-epsilon iteration
	// noise never reorders ties; position then breaks the rest, keeping selection stable.
	order.sort((a, b) => {
		const sa = Math.round(scores[a] * 1e10) / 1e10;
		const sb = Math.round(scores[b] * 1e10) / 1e10;
		if (sa !== sb) return sb - sa; // score DESC
		return a - b; // position ASC
	});
	const chosen = order.slice(0, k).sort((a, b) => a - b); // back to original order
	return chosen.map((i) => sentences[i]);
}

export function summarize(text: string, k = 8): string[] {
	let sentences = splitSentences(text);
	if (sentences.length <= k) return sentences;
	if (sentences.length > MAX_RANK) sentences = sentences.slice(-MAX_RANK); // recency-biased

	const tokens = sentences.map(tokenize);
	if (!tokens.some((t) => t.length > 0)) return sentences.slice(0, k);

	const scores = textrank(tokens, idf(tokens));
	return select(sentences, scores, k);
}
