// Adopt an ad-hoc CLI session (fleet-ide-escalation E03) — pure helpers. A developer runs a raw
// `claude` in a terminal; B03 harness-hooks make the daemon aware of it (presence `harness:sessionId`,
// source "other"). "Adopt" captures that session's uncommitted WORK (not its conversation — the
// daemon has no handle on the harness's context) into a FRESH worktree and wraps it in a gated unit,
// leaving the developer's original checkout untouched. The git orchestration lives in SquadManager.adopt;
// these are the pure, testable bits (branch naming, brief text, untracked-path parsing + safety).

import { createHash } from "node:crypto";

/** Branch-name-safe component: keep [A-Za-z0-9._-], collapse the rest to "-". */
export function sanitizeBranchComponent(s: string): string {
	return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

/** Deterministic, collision-resistant branch for an adopted session: `adopt/<harness>-<hash8>` where
 *  the hash folds sessionId + the captured HEAD sha, so re-adopting the SAME state reuses the branch
 *  (and thus fails on the existing-branch guard — no silent double-adopt), while an evolved session
 *  (new HEAD) gets a fresh branch. */
export function adoptBranchName(harness: string, sessionId: string, headSha: string): string {
	const h = createHash("sha256").update(`${sessionId} ${headSha}`).digest("hex").slice(0, 8);
	return `adopt/${sanitizeBranchComponent(harness)}-${h}`;
}

/** The opening task steered into the adopted unit. Adoption recovers WORK, not the ad-hoc agent's
 *  memory — so the brief tells the new unit what it inherited and to continue deliberately. */
export function adoptBrief(harness: string, changedCount: number, newCount: number): string {
	const parts: string[] = [];
	if (changedCount > 0) parts.push(`${changedCount} changed file${changedCount === 1 ? "" : "s"}`);
	if (newCount > 0) parts.push(`${newCount} new file${newCount === 1 ? "" : "s"}`);
	const what = parts.length > 0 ? parts.join(" and ") : "no uncommitted changes";
	return (
		`A developer ran an ad-hoc ${harness} session in this repository and left ${what}, now captured ` +
		`into this worktree. Re-read the current files to see what was done, then continue and complete ` +
		`the work: finish the change, and make sure it builds and the tests pass before it's landed.`
	);
}

/** Split a NUL-delimited git list (`-z` output) into paths. `-z` is load-bearing: without it git
 *  C-quotes unusual filenames and trims spaces, so a valid but odd name would parse to a wrong/missing
 *  path. NUL never appears in a path, so this is lossless. */
export function parseNulList(stdout: string): string[] {
	return stdout.split("\0").filter((p) => p.length > 0);
}

/** Defense-in-depth on untracked paths before they become copy destinations: `git ls-files` only ever
 *  emits repo-relative forward-slash paths, but reject anything absolute or with a `..` segment so a
 *  crafted entry can never write outside the new worktree. */
export function isSafeUntrackedPath(p: string): boolean {
	if (p.length === 0) return false;
	if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false; // absolute (posix or windows)
	return !p.split("/").some((seg) => seg === "..");
}
