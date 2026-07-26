/**
 * Path-ownership partition — refuse to spawn an agent whose declared paths overlap
 * a live agent's, so parallel agents never edit the same files (prevent the collision
 * up front instead of merging it back later). Ownership is a list of repo-relative
 * path prefixes (a dir or a file); two sets overlap when a prefix in one equals or
 * contains a prefix in the other.
 *
 * ponytail: prefix containment, not glob intersection — partition by dir/module, the
 * unit agents actually split on. Add `**`/glob matching only if a task needs fan-in.
 */

import { rankKbDocs, tokenize, type KbDoc } from "./fabric-search.ts";
import type { AgentStatus } from "./types.ts";

/**
 * Canonicalize a claim into a comparable prefix; "" means "no claim".
 * Collapses duplicate slashes, resolves `.`/`..` segments, strips surrounding
 * slashes, and lowercases — so `./Src//web`, `src/x/../web`, and `SRC/web` all
 * compare equal and can't be used to evade the overlap check.
 *
 * ponytail: lowercased unconditionally. Linux is case-sensitive so `Foo` and `foo`
 * are distinct files there, but the safe direction for a spawn guard is to treat
 * lookalikes as overlapping (refuse) rather than let a case flip slip two agents
 * onto the same file on macOS/Windows. Upgrade to per-repo case sensitivity only
 * if a case-sensitive repo hits false conflicts.
 */
function norm(p: string): string {
	const out: string[] = [];
	for (const seg of p.trim().split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") out.pop(); // clamp at root: `..` above root is dropped, never escapes
		else out.push(seg);
	}
	return out.join("/").toLowerCase();
}

/** True if path `a` is the same as, or nested under, path `b` (segment-safe). */
function under(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`);
}

/** Prefixes in `a` that touch the same subtree as some prefix in `b`. */
export function ownershipOverlap(a: readonly string[], b: readonly string[]): string[] {
	const B = b.map(norm).filter(Boolean);
	const hits = new Set<string>();
	for (const raw of a) {
		const x = norm(raw);
		if (!x) continue;
		if (B.some((y) => under(x, y) || under(y, x))) hits.add(x);
	}
	return [...hits];
}

/** True if repo-relative `file` falls within any declared path prefix (segment-safe, normalized). */
export function isWithinAny(file: string, prefixes: readonly string[]): boolean {
	const f = norm(file);
	if (!f) return false;
	return prefixes.some((p) => {
		const b = norm(p);
		return b !== "" && under(f, b);
	});
}

/** Shared files whose write should never trip the produces audit (lockfiles, root config). */
const DEFAULT_PRODUCES_ALLOW = ["package.json", "bun.lock", "bun.lockb", "tsconfig.json", ".gitignore"];

/** The produces-audit allowlist: defaults + `OMP_SQUAD_PRODUCES_ALLOW` (comma-separated), lowercased. */
export function producesAllowlist(extra?: string): Set<string> {
	const all = [...DEFAULT_PRODUCES_ALLOW, ...(extra ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
	return new Set(all.map((s) => norm(s)));
}

/**
 * Files an agent actually changed that fall OUTSIDE its declared `produces` and aren't
 * allowlisted — the produces-audit result. An empty `declared` means "no contract to
 * audit against" ⇒ never flags (you can't exceed a scope you never declared).
 * Allowlist matches either the full normalized path or its basename (lockfiles live at root
 * but the basename match keeps it robust to nested checkouts).
 */
export function outOfScopeWrites(actual: readonly string[], declared: readonly string[], allow: Set<string>): string[] {
	if (!declared.length) return [];
	const out: string[] = [];
	for (const f of actual) {
		const nf = norm(f);
		if (!nf) continue;
		const base = nf.split("/").pop() ?? nf;
		if (allow.has(nf) || allow.has(base)) continue;
		if (!isWithinAny(f, declared)) out.push(nf);
	}
	return out;
}

/** A live agent's scope contract, as seen by spawn partition checks. */
export interface Owner {
	repo: string;
	name: string;
	status: AgentStatus;
	/** Legacy/short-hand write claim. `produces` defaults to this. */
	owns?: string[];
	/** Repo-relative path prefixes this agent reads from. */
	requires?: string[];
	/** Repo-relative path prefixes this agent writes/creates. Defaults to `owns`. */
	produces?: string[];
}

/** The first live agent in `repo` whose ownership overlaps `owns`, with the offending paths. */
export function ownershipConflict(live: readonly Owner[], repo: string, owns: readonly string[]): { agent: string; paths: string[] } | undefined {
	if (owns.length === 0) return undefined;
	for (const o of live) {
		if (o.repo !== repo || o.status === "stopped" || o.status === "error") continue;
		// Resolve the holder's write claim exactly as requiresConflict does: `produces` is the primary
		// field, `owns` the legacy fallback. A holder created produces-first (owns undefined — the modern
		// form the live spawn path stores) would otherwise slip past this write-vs-write guard entirely.
		const writes = o.produces?.length ? o.produces : o.owns;
		if (!writes?.length) continue;
		const hits = ownershipOverlap(owns, writes);
		if (hits.length) return { agent: o.name, paths: hits };
	}
	return undefined;
}

/** The first live agent whose write outputs overlap the requested read dependencies. */
export function requiresConflict(live: readonly Owner[], repo: string, requires: readonly string[]): { agent: string; paths: string[] } | undefined {
	if (requires.length === 0) return undefined;
	for (const o of live) {
		if (o.repo !== repo || o.status === "stopped" || o.status === "error") continue;
		const writes = o.produces?.length ? o.produces : o.owns;
		if (!writes?.length) continue;
		const hits = ownershipOverlap(requires, writes);
		if (hits.length) return { agent: o.name, paths: hits };
	}
	return undefined;
}

/**
 * A goal claim is deliberately separate from a path claim. The detector receives private goals
 * to compare, but its result contains only the fact of overlap and the current owner's name.
 */
export interface GoalOwner extends Owner {
	goal?: string;
	issueRefs?: string[];
	planRefs?: string[];
}

export type GoalConflictStrength = "structural" | "semantic" | "bm25";

/** Safe cross-boundary disclosure: never add a goal, path, issue, or plan reference here. */
export interface GoalConflict {
	agent: string;
	strength: GoalConflictStrength;
}

/** Below this, a goal carries too little to refuse anything on. */
const MIN_GOAL_TERMS = 2;

const GOAL_STOPWORDS = new Set(["a", "an", "and", "build", "for", "implement", "in", "of", "on", "the", "to", "with"]);
const GOAL_CONCEPTS: Readonly<Record<string, string>> = {
	rate: "rate-limit",
	limit: "rate-limit",
	limiting: "rate-limit",
	throttle: "rate-limit",
	throttling: "rate-limit",
	auth: "access-control",
	authentication: "access-control",
	authorization: "access-control",
};


function refsOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (!a?.length || !b?.length) return false;
	const claims = new Set(a.map((ref) => ref.trim()).filter(Boolean));
	return b.some((ref) => claims.has(ref.trim()));
}

/** Meaningful words, before concept folding — this is what "enough to judge on" is measured in. */
function rawGoalTerms(goal: string): Set<string> {
	return new Set(tokenize(goal).filter((term) => !GOAL_STOPWORDS.has(term)));
}

function goalTerms(goal: string): Set<string> {
	return new Set(tokenize(goal).filter((term) => !GOAL_STOPWORDS.has(term)).map((term) => GOAL_CONCEPTS[term] ?? term));
}

/** Concept overlap catches declared aliases such as "rate limiting" and "request throttling". */
function semanticGoalOverlap(a: string, b: string): boolean {
	const left = goalTerms(a);
	const right = goalTerms(b);
	// Two meaningful terms minimum on both sides, counted BEFORE concept folding. Without a floor a
	// one-word goal is a total match after folding — "rate" collapses to "rate-limit", scores 1/1, and
	// refuses a spawn on no evidence at all. Counting after folding instead would be just as wrong in
	// the other direction: "rate limiting" is two real words that fold to one concept, and it is a
	// perfectly good goal. This check BLOCKS creation, so both mistakes are expensive.
	if (rawGoalTerms(a).size < MIN_GOAL_TERMS || rawGoalTerms(b).size < MIN_GOAL_TERMS) return false;
	let shared = 0;
	for (const term of left) if (right.has(term)) shared++;
	return shared / Math.min(left.size, right.size) >= 0.6;
}

/** BM25 remains a lower-confidence lexical fallback after the structural and concept checks. */
function bm25GoalOwners(live: readonly GoalOwner[], goal: string): Map<string, number> {
	const docs: KbDoc[] = live.flatMap((owner) => owner.goal?.trim()
		? [{ type: "agent" as const, id: owner.name, title: "declared work goal", text: owner.goal }]
		: []);
	const rawTerms = new Set(tokenize(goal).filter((term) => !GOAL_STOPWORDS.has(term)));
	if (rawTerms.size < 2) return new Map();
	const scores = new Map<string, number>();
	for (const hit of rankKbDocs(docs, goal, { topK: docs.length })) {
		const owner = live.find((candidate) => candidate.name === hit.id);
		if (!owner?.goal) continue;
		const candidateTerms = new Set(tokenize(owner.goal).filter((term) => !GOAL_STOPWORDS.has(term)));
		let shared = 0;
		for (const term of rawTerms) if (candidateTerms.has(term)) shared++;
		if (shared >= 2 && shared / Math.min(rawTerms.size, candidateTerms.size) >= 0.5) scores.set(hit.id, hit.score);
	}
	return scores;
}

/**
 * Rank all overlapping live goals. Structural declarations always win over semantic and BM25
 * matches. Results are intentionally disclosure-safe: callers learn the owner, never the other
 * goal or the evidence that matched it.
 */
/**
 * @substrate the ranked list behind `goalConflict`, kept exported because concern 05's verify list
 * requires that structural overlap outranks semantic and BM25 in the RESULT ORDER — which is only
 * observable on the full list. The manager discloses the top hit; this is how the ordering is checked.
 */
export function goalConflicts(live: readonly GoalOwner[], request: GoalOwner): GoalConflict[] {
	const candidates = live.filter((owner) => owner.repo === request.repo && owner.status !== "stopped" && owner.status !== "error");
	const bm25 = request.goal?.trim() ? bm25GoalOwners(candidates, request.goal) : new Map<string, number>();
	const ranked = candidates.flatMap((owner, index) => {
		const requestWrites = request.produces?.length ? request.produces : request.owns;
		const ownerWrites = owner.produces?.length ? owner.produces : owner.owns;
		const structural = Boolean(
			(requestWrites?.length && ownerWrites?.length && ownershipOverlap(requestWrites, ownerWrites).length) ||
			refsOverlap(request.issueRefs, owner.issueRefs) ||
			refsOverlap(request.planRefs, owner.planRefs),
		);
		const semantic = !structural && Boolean(request.goal?.trim() && owner.goal?.trim() && semanticGoalOverlap(request.goal, owner.goal));
		const score = bm25.get(owner.name);
		const strength: GoalConflictStrength | undefined = structural ? "structural" : semantic ? "semantic" : score !== undefined ? "bm25" : undefined;
		return strength ? [{ agent: owner.name, strength, score: score ?? 0, index }] : [];
	});
	const priority: Record<GoalConflictStrength, number> = { structural: 0, semantic: 1, bm25: 2 };
	return ranked
		.sort((a, b) => priority[a.strength] - priority[b.strength] || b.score - a.score || a.index - b.index)
		.map(({ agent, strength }) => ({ agent, strength }));
}

/** The highest-priority goal conflict, suitable for the spawn guard. */
export function goalConflict(live: readonly GoalOwner[], request: GoalOwner): GoalConflict | undefined {
	return goalConflicts(live, request)[0];
}
