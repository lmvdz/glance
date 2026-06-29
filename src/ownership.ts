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
		if (o.repo !== repo || o.status === "stopped" || o.status === "error" || !o.owns?.length) continue;
		const hits = ownershipOverlap(owns, o.owns);
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
