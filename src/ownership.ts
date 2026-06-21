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

/** Strip surrounding slashes/whitespace; "" means "no claim". */
function norm(p: string): string {
	return p.trim().replace(/^\/+|\/+$/g, "");
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

/** A live agent's ownership claim, as seen by the partition check. */
export interface Owner {
	repo: string;
	name: string;
	status: AgentStatus;
	owns?: string[];
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
