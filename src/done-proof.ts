/**
 * DoneProof ledger — the ONE artifact that can later authorize a Done write (concern 04) or a
 * PR-mode reachability claim (concern 06). This module does not gate anything itself: it only
 * builds the retrievable ledger, the `isAncestor` git primitive both later concerns need, and
 * folds a local land's proof in so it becomes retrievable, not just a JSON file nobody reads back.
 *
 * ponytail: one JSON file per stateDir, sync read-modify-write — the manager is single-writer,
 * single event loop, so no interleave, mirroring land-ledger.ts's pattern exactly. Best-effort
 * (a disk failure must never break a land).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";

export interface DoneProof {
	branch: string;
	repo: string; // repoIdentity() key (src/repo-identity.ts) — NOT the host-local path
	issueId?: string;
	issueIdentifier?: string;
	mode: "local" | "pr";
	method?: "merge" | "squash" | "rebase"; // pr only
	commit: string; // branch tip proven included
	mergeCommit?: string; // pr only
	baseRef: string; // "HEAD" (local) | "origin/main" or similar (pr)
	verified: "green" | "red-baseline" | "unverified";
	detail: string;
	provenAt: number;
	prNumber?: number;
	prUrl?: string;
}

interface DoneProofLedger {
	byBranch: Record<string, DoneProof>;
	byIssue: Record<string /* issueIdentifier, uppercased */, string /* branch */>;
}

function ledgerPath(stateDir: string): string {
	return path.join(stateDir, "done-proofs.json");
}

export function readDoneProofLedger(stateDir: string): DoneProofLedger {
	try {
		const p = ledgerPath(stateDir);
		if (!existsSync(p)) return { byBranch: {}, byIssue: {} };
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		if (!raw || typeof raw !== "object") return { byBranch: {}, byIssue: {} };
		const r = raw as Partial<DoneProofLedger>;
		return {
			byBranch: r.byBranch && typeof r.byBranch === "object" ? r.byBranch : {},
			byIssue: r.byIssue && typeof r.byIssue === "object" ? r.byIssue : {},
		};
	} catch {
		return { byBranch: {}, byIssue: {} }; // corrupt/unreadable ⇒ start fresh
	}
}

function writeDoneProofLedger(stateDir: string, ledger: DoneProofLedger): void {
	try {
		writeFileSync(ledgerPath(stateDir), JSON.stringify(ledger));
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
}

/**
 * Record one DoneProof: read-modify-write, keyed by branch, most-recent-branch-wins on the issue
 * index (a re-dispatched issue's newest land is what "done" should mean).
 */
export function recordDoneProof(stateDir: string, proof: DoneProof): void {
	const ledger = readDoneProofLedger(stateDir);
	ledger.byBranch[proof.branch] = proof;
	if (proof.issueIdentifier) ledger.byIssue[proof.issueIdentifier.toUpperCase()] = proof.branch;
	writeDoneProofLedger(stateDir, ledger);
}

export function getDoneProofByBranch(stateDir: string, branch: string): DoneProof | undefined {
	return readDoneProofLedger(stateDir).byBranch[branch];
}

export function getDoneProofByIssue(stateDir: string, issueIdentifier: string): DoneProof | undefined {
	const ledger = readDoneProofLedger(stateDir);
	const branch = ledger.byIssue[issueIdentifier.toUpperCase()];
	return branch ? ledger.byBranch[branch] : undefined;
}

/** Whether `issueIdentifier` has a recorded land proof — the exact predicate concern 04's `hasProof` injection uses. */
export function hasProof(stateDir: string, issueIdentifier: string): boolean {
	return getDoneProofByIssue(stateDir, issueIdentifier) !== undefined;
}

/**
 * Whether `ref` is an ancestor of `base` (i.e. `ref`'s history is fully contained in `base`) — the
 * ONE new git primitive this concern introduces. Concern 05's mode-probe and concern 06's
 * post-merge reachability assertion both import it from here rather than re-implementing
 * `merge-base --is-ancestor`.
 */
export async function isAncestor(ref: string, base: string, cwd: string): Promise<boolean> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, "merge-base", "--is-ancestor", ref, base], {
		cwd,
		env: { ...process.env, ...GIT_HARDEN_ENV },
		stdout: "ignore",
		stderr: "ignore",
	});
	return (await proc.exited) === 0; // git merge-base --is-ancestor: exit 0 = yes, 1 = no, other = error (treat as false)
}

/**
 * Whether a recorded `proof` still covers `branch`'s CURRENT tip — i.e. no commits have landed on the
 * branch since the proof was taken. A DoneProof only ever speaks to the exact commit it was recorded
 * against (`proof.commit`); a follow-up commit pushed to the SAME branch after a land must not be
 * silently swallowed as "already landed" too — every "is this branch landed" consumer (auditStaleDone,
 * auditLandedSurvivors, agentHasUnlandedWork, persistedHasWork, the worktree reaper) used to treat ANY
 * recorded proof as proof-forever, so a T2 follow-up commit after a T1 land proof was permanently
 * invisible to the whole pipeline.
 *
 * Resolves the branch's tip via `git rev-parse` in `cwd` — callers should pass the REPO path, not a
 * specific worktree: branch refs are shared across worktrees of the same repo (mirrors `aheadOfBase`'s
 * own reasoning in land-mode.ts), so resolving at the repo stays available even after the authoring
 * worktree is gone. If the tip can't be resolved at all (branch deleted, repo path gone), the caller
 * can't PROVE coverage — return false so it falls back to whatever arithmetic path it already had
 * rather than trusting a proof we can't verify against anything.
 */
export async function proofCoversTip(proof: DoneProof | undefined, branch: string, cwd: string): Promise<boolean> {
	if (!proof) return false;
	try {
		const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, "rev-parse", branch], {
			cwd,
			env: { ...process.env, ...GIT_HARDEN_ENV },
			stdout: "pipe",
			stderr: "ignore",
		});
		const tip = (await new Response(proc.stdout).text()).trim();
		const code = await proc.exited;
		if (code !== 0 || !tip) return false; // can't resolve the tip ⇒ can't prove coverage ⇒ fall back to arithmetic
		return proof.commit === tip;
	} catch {
		return false; // cwd gone entirely (e.g. a reaped worktree) ⇒ same fallback
	}
}
