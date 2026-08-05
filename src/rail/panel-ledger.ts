/**
 * Gauntlet-panel ledger projection (T5 gauntlet round 1, glance#333, finding A1 — CRITICAL, both
 * lineages independently converged).
 *
 * THE BUG: `runReviewPanel` used to append directly to the git-TRACKED
 * `plans/.reviews/reviewer-ledger.jsonl` inside `landAgent`'s repo checkout, DURING the pre-land
 * advisory panel — i.e. BEFORE `landAgentLocked`'s dirty-main check (`src/land.ts` ~553-565). A clean
 * branch that PASSED the validator could therefore get BLOCKED by the panel's own successful write:
 * the panel dirtied the very tree the land gate was about to inspect, turning "visibility only" into
 * an accidental new refusal path — a verdict by side effect, never intended. It was also not
 * land-race-safe (the append happened outside `withRepoLandLock`) and not rollback-safe (a failed-gate
 * `git reset --hard` would silently erase the row it just wrote).
 *
 * THE FIX: a runtime panel finding is queued under `<stateDir>` (untracked, NEVER inside a managed
 * repo's working tree — mirrors `src/rail/land-ledger.ts`'s ForcedLand/ValidatorOverride audit trails)
 * during the panel run itself, so the land path's own git tree is NEVER touched. A SEPARATE,
 * `withRepoLandLock`-guarded, transactional PROJECTION lane — `projectPendingPanelFindings`, called by
 * `SquadManager.land()` only AFTER a merge has actually settled (`result.ok && result.merged`), never
 * from inside the land's own critical section — takes the queue, appends each entry to the tracked
 * ledger file, and commits that ONE file (a scoped `git add <path>` + `git commit`, never `-A`) so the
 * tree returns to a clean, committed state before the lock releases. The committed ledger stays the
 * moat's data (T4's `reviewerPrecisionFromLedger` reads it exactly as before); the runtime write just
 * stops being able to dirty a land gate's tree ever again.
 *
 * The ledger's OWNING repo is a DAEMON-GLOBAL constant (`DEFAULT_REVIEWER_LEDGER_REPO`,
 * `src/memory/reviewer-weights.ts`) — wherever THIS glance checkout is installed — independent of
 * which tenant repo a given land operates on. Locking/committing against the LANDED repo would be
 * wrong in a multi-tenant daemon whose managed repos differ from the daemon's own install directory;
 * `projectPendingPanelFindings` therefore takes `ledgerRepo` as an explicit parameter rather than
 * inferring it from the caller's landed repo.
 */

import { appendReviewerLedgerEntry, DEFAULT_REVIEWER_LEDGER_PATH, type ReviewerLedgerEntry } from "../memory/index.ts";
import { errText } from "../err-text.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV, gitNoSignEnv } from "../git-harden.ts";
import { listFile, mapFile } from "../ledger.ts";
import { withRepoLandLock } from "../land.ts";

const PENDING_FILE = "rail-panel-findings-pending.json";
const PENDING_KEY = "queue";

const pendingStore = (stateDir: string) => mapFile<ReviewerLedgerEntry[]>(stateDir, PENDING_FILE);

/** Queue one panel finding for later projection into the tracked ledger — a plain, synchronous,
 *  stateDir-scoped write (never touches a managed repo's working tree). Read-modify-write with no
 *  `await` between them, so it is atomic w.r.t. the event loop even under concurrent panel runs on
 *  the same tick (mirrors `land-ledger.ts`'s `recordLandOutcome` idiom). Best-effort: `mapFile`'s own
 *  write is already best-effort (a disk fault degrades silently rather than breaking the panel). */
export function recordPendingPanelFinding(stateDir: string, entry: ReviewerLedgerEntry): void {
	const store = pendingStore(stateDir);
	const all = store.read();
	const queue = [...(all[PENDING_KEY] ?? []), entry];
	store.write({ ...all, [PENDING_KEY]: queue });
}

/** Every finding queued but not yet projected — for observability/tests. Never mutates the queue. */
export function readPendingPanelFindings(stateDir: string): ReviewerLedgerEntry[] {
	return pendingStore(stateDir).read()[PENDING_KEY] ?? [];
}

/** Atomically READ-AND-CLEAR the pending queue (sync read + sync write, no `await` between — the same
 *  atomicity argument as `recordPendingPanelFinding` above) so a projection in flight can never lose a
 *  finding queued by a panel run that starts DURING the projection's own (awaited) git calls: anything
 *  queued after this call belongs to the NEXT projection cycle, never silently dropped. */
function takePendingPanelFindings(stateDir: string): ReviewerLedgerEntry[] {
	const store = pendingStore(stateDir);
	const all = store.read();
	const queue = all[PENDING_KEY] ?? [];
	if (queue.length > 0) store.write({ ...all, [PENDING_KEY]: [] });
	return queue;
}

/** Re-queue findings a projection attempt could not durably commit — prepended so an already-queued
 *  newer finding (added while this projection ran) is not reordered behind a retried older one, though
 *  order has no semantic meaning here (each row is independent). Best-effort, same discipline as
 *  `recordPendingPanelFinding`. */
function requeuePendingPanelFindings(stateDir: string, entries: ReviewerLedgerEntry[]): void {
	if (entries.length === 0) return;
	const store = pendingStore(stateDir);
	const all = store.read();
	store.write({ ...all, [PENDING_KEY]: [...entries, ...(all[PENDING_KEY] ?? [])] });
}

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV, ...gitNoSignEnv() }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (err) {
		return { code: 1, stdout: "", stderr: errText(err) };
	}
}

export interface PanelLedgerProjection {
	/** Findings actually appended to the tracked ledger file this call. */
	projected: number;
	/** `true` when a git commit for those rows was created; `false` when `ledgerRepo` is not a usable
	 *  git checkout (test fixtures, or a non-git ledger location) — the rows are still durably in the
	 *  tracked file, just not (yet) committed; a later projection run over the same repo will commit
	 *  them alongside whatever accumulates next. */
	committed: boolean;
}

/**
 * Move every currently-queued panel finding into the tracked reviewer ledger, guarded by
 * `withRepoLandLock(ledgerRepo, ...)` — the SAME per-repo serialization a live land uses, so this can
 * never observe (or create) a half-merged/mid-rollback tree. Intended to run OUT of the land path:
 * `SquadManager.land()` calls this fire-and-forget AFTER a merge has settled, never from inside
 * `runValidatorGate`/`landBranch`'s own critical section. A no-op (returns `{projected:0,
 * committed:false}`) when the queue is empty — never touches git for nothing.
 *
 * On any failure partway through (a write fault, a git fault), the entries that did NOT make it into
 * the tracked file are RE-QUEUED (never dropped) for the next projection attempt — this is durable
 * audit data, not a cache.
 */
export async function projectPendingPanelFindings(stateDir: string, ledgerRepo: string, ledgerPath: string = DEFAULT_REVIEWER_LEDGER_PATH): Promise<PanelLedgerProjection> {
	return withRepoLandLock(ledgerRepo, async () => {
		const toProject = takePendingPanelFindings(stateDir);
		if (toProject.length === 0) return { projected: 0, committed: false };

		const remaining = [...toProject];
		let projected = 0;
		try {
			for (const entry of toProject) {
				appendReviewerLedgerEntry(entry, ledgerPath);
				remaining.shift(); // only drop from the retry set once the write actually succeeded
				projected++;
			}
		} catch (err) {
			requeuePendingPanelFindings(stateDir, remaining);
			throw new Error(`gauntlet-panel ledger projection: failed writing to ${ledgerPath} after ${projected}/${toProject.length} row(s) (re-queued the rest): ${errText(err)}`);
		}

		// Commit the ONE file — a scoped pathspec, never `-A`, so an operator's unrelated WIP in the
		// same checkout is never swept into this commit. Best-effort: if `ledgerRepo` is not a git
		// checkout at all (e.g. a bare fixture directory in tests), `git add` itself fails harmlessly —
		// the rows are still durably on disk; only the "committed" half of the contract degrades.
		const rel = ledgerPath.startsWith(ledgerRepo) ? ledgerPath.slice(ledgerRepo.length).replace(/^[/\\]+/, "") : ledgerPath;
		const add = await git(["add", "--", rel], ledgerRepo);
		if (add.code !== 0) return { projected, committed: false };
		const commit = await git(["commit", "-m", `chore(rail): record ${projected} gauntlet-panel finding${projected === 1 ? "" : "s"}`], ledgerRepo);
		if (commit.code === 0) return { projected, committed: true };
		// The commit failed AFTER staging (e.g. no git identity configured in `ledgerRepo`) — never
		// leave the tree dirty for the NEXT land to trip over (that is exactly the bug this module
		// exists to close). Discard the working-tree change and re-queue the rows for the next attempt,
		// rather than silently losing them. Narrow residual risk, accepted: if a human had unrelated
		// uncommitted WIP on this SAME file at this exact moment, the checkout also reverts that — the
		// same trade-off `landAgentLocked`'s own dirty-main refusal already makes elsewhere in this
		// codebase (a tracked-file revert never touches OTHER files).
		await git(["checkout", "--", rel], ledgerRepo);
		requeuePendingPanelFindings(stateDir, toProject);
		return { projected: 0, committed: false };
	});
}
