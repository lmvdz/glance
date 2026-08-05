/**
 * Gauntlet-panel ledger projection (T5, glance#333, finding A1 — CRITICAL both rounds).
 *
 * ROUND 1 BUG: `runReviewPanel` used to append directly to the git-TRACKED
 * `plans/.reviews/reviewer-ledger.jsonl` inside `landAgent`'s repo checkout, DURING the pre-land
 * advisory panel — i.e. BEFORE `landAgentLocked`'s dirty-main check (`src/land.ts` ~553-565). A clean
 * branch that PASSED the validator could therefore get BLOCKED by the panel's own successful write.
 *
 * ROUND 1 FIX (still correct): a runtime panel finding is queued under `<stateDir>` (untracked, NEVER
 * inside a managed repo's working tree) during the panel run, and a SEPARATE, `withRepoLandLock`-guarded
 * projection lane moves the queue into the tracked ledger OUT of the land path, only after a merge has
 * settled.
 *
 * ROUND 2 BUG (both lineages, dual delta-verify on PR #353): the projection lane ITSELF reintroduced
 * A1 one land later. It cleared the queue BEFORE the commit durably succeeded, so:
 *   - a failed `git add` returned `committed:false` with NO revert/requeue — the ledger file was left
 *     modified on disk (dirty) while the queue was already empty, so the data was neither committed
 *     nor recoverable;
 *   - a partial mid-loop append failure only re-queued the UNWRITTEN rows — the rows already appended
 *     to the file (but never committed) were both dirty on disk AND gone from the queue;
 *   - a commit failure ran `git checkout -- <path>`, which restores the WORKING TREE from the INDEX —
 *     but the file had already been `git add`ed, so the INDEX still held the new content: the tree
 *     stayed STAGED-dirty (a different `git status --porcelain` shape, same "dirty tree blocks the next
 *     land" outcome A1 exists to prevent);
 *   - the commit itself committed the WHOLE index, not just the ledger path, so any OTHER pre-staged
 *     operator change got swept in;
 *   - a crash between the queue-clear and the commit succeeding lost the only pending copy entirely,
 *     and (had clearing been moved to AFTER the commit, naively) a crash between commit-success and
 *     queue-clear would have DOUBLE-appended on the retry.
 *
 * ROUND 2 FIX — a PROPER TRANSACTION:
 *   (a) durability first: the pending queue is NEVER cleared until the tracked write is fully durable
 *       (a real commit, or — for a non-git `ledgerRepo` — the atomic file rewrite itself). A crash at
 *       any point before that leaves the queue exactly as it was; nothing is lost.
 *   (b) idempotency: before appending, every pending finding's content-identity (`semanticKey` — the
 *       SAME identity `parseReviewerLedger`'s own de-dup already uses, reused rather than reinvented as
 *       a new wire field) is checked against the CURRENT ledger's already-parsed entries. An entry
 *       already present (e.g. from a prior attempt that committed successfully but crashed before the
 *       queue was cleared) is treated as already-projected and simply dropped from this batch — a retry
 *       can never double-append.
 *   (c) path-scoped commit: `git commit -m <msg> -- <path>` commits ONLY the ledger path's current
 *       working-tree content (verified empirically: it does NOT require the path to be staged, and
 *       does NOT touch any OTHER staged content) — no `git add` step at all, so there is nothing else
 *       for a stray `-A`-shaped mistake to sweep in.
 *   (d) full restore on failure: `git checkout HEAD -- <path>` resets BOTH the index and the working
 *       tree for that one path back to HEAD (verified empirically) — never merely the working tree —
 *       and EVERY pending finding (the whole batch, not just the ones that failed to write) is re-queued.
 *   (e) the append itself is atomic: the new ledger content is built in memory (current file + the
 *       non-duplicate pending findings) and written to a temp file in the SAME directory, then
 *       atomically renamed over the real path — there is no "partially appended" state ever observable
 *       on disk, so a mid-batch failure can no longer leave SOME rows written and unqueued.
 *
 * The ledger's OWNING repo is a DAEMON-GLOBAL constant (`DEFAULT_REVIEWER_LEDGER_REPO`,
 * `src/memory/reviewer-weights.ts`) — wherever THIS glance checkout is installed — independent of
 * which tenant repo a given land operates on; `projectPendingPanelFindings` takes `ledgerRepo` as an
 * explicit parameter rather than inferring it from the caller's landed repo.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_REVIEWER_LEDGER_PATH, parseReviewerLedger, semanticKey, type ReviewerLedgerEntry } from "../memory/index.ts";
import { errText } from "../err-text.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV, gitNoSignEnv } from "../git-harden.ts";
import { mapFile } from "../ledger.ts";
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

/**
 * Remove exactly the given `processed` entries from the CURRENT queue — a value-based multiset
 * removal (one occurrence per match, by deep content equality), NOT a prefix-slice or a full clear.
 * This is what makes "durability first" safe under concurrency (round 2, finding #1a): a panel run can
 * queue a NEW finding at any point, including WHILE a projection's own (awaited) git calls are in
 * flight — re-reading the store here (rather than clearing a snapshot blindly) means any such new
 * arrival is never touched, and only the entries this projection attempt actually accounted for
 * (committed, or recognized as an idempotent duplicate) are ever removed.
 */
function removeProcessedFromQueue(stateDir: string, processed: ReviewerLedgerEntry[]): void {
	if (processed.length === 0) return;
	const store = pendingStore(stateDir);
	const all = store.read();
	const remaining = [...(all[PENDING_KEY] ?? [])];
	for (const p of processed) {
		const idx = remaining.findIndex((c) => JSON.stringify(c) === JSON.stringify(p));
		if (idx >= 0) remaining.splice(idx, 1);
	}
	store.write({ ...all, [PENDING_KEY]: remaining });
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

async function isGitRepo(repo: string): Promise<boolean> {
	const r = await git(["rev-parse", "--is-inside-work-tree"], repo);
	return r.code === 0 && r.stdout === "true";
}

/** Read the ledger's current text; a genuinely absent file reads as empty (a fresh ledger), any other
 *  read fault also degrades to empty (never throws) — the append step below is what actually needs to
 *  succeed durably; a read fault here just means idempotency has nothing to compare against yet. */
async function readCurrentLedgerText(ledgerPath: string): Promise<string> {
	try {
		return await fs.readFile(ledgerPath, "utf8");
	} catch {
		return "";
	}
}

/** Atomic write: a temp file in the SAME directory as `ledgerPath` (guarantees a same-filesystem,
 *  hence atomic, `rename`), so there is never a moment where a partially-written file is observable at
 *  the real path — a crash or fault mid-write leaves the ORIGINAL file completely untouched. */
async function atomicWrite(ledgerPath: string, content: string): Promise<void> {
	const dir = path.dirname(ledgerPath);
	await fs.mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.reviewer-ledger.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.writeFile(tmp, content);
	try {
		await fs.rename(tmp, ledgerPath);
	} catch (err) {
		// `dir` (the ledger's parent directory) is normally a TRACKED, git-managed path — a temp file
		// left behind here would show up as an UNTRACKED file in `git status --porcelain`, i.e. exactly
		// the "dirty tree blocks the next land" failure mode this whole module exists to prevent, just
		// one file over. Clean it up before propagating the real error.
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

export interface PanelLedgerProjection {
	/** Findings NEWLY appended to the tracked ledger file this call (never counts an idempotent
	 *  duplicate that was already present). */
	projected: number;
	/** `true` when a git commit for those rows was created THIS call. `false` covers three cases,
	 *  distinguishable only by reading the queue/tree afterward: a non-git `ledgerRepo` (the durable
	 *  file write still happened; nothing to commit); nothing NEW to write (every pending finding was
	 *  already present — idempotency, not a failure); or a genuine commit failure (fully reverted,
	 *  every finding re-queued — see the module doc's finding #1d). */
	committed: boolean;
}

/**
 * Move every currently-queued panel finding into the tracked reviewer ledger, guarded by
 * `withRepoLandLock(ledgerRepo, ...)` — the SAME per-repo serialization a live land uses. Intended to
 * run OUT of the land path: `SquadManager.land()` calls this fire-and-forget AFTER a merge has settled,
 * never from inside `runValidatorGate`/`landBranch`'s own critical section. A no-op when the queue is
 * empty — never touches the filesystem or git for nothing.
 *
 * See the module doc for the full transactional contract (durability-first ordering, idempotency,
 * path-scoped partial commit, full index+worktree restore on failure, atomic file rewrite).
 */
export async function projectPendingPanelFindings(stateDir: string, ledgerRepo: string, ledgerPath: string = DEFAULT_REVIEWER_LEDGER_PATH): Promise<PanelLedgerProjection> {
	return withRepoLandLock(ledgerRepo, async () => {
		// Durability-first (finding #1a): read, but do NOT clear, the queue yet. Nothing is removed
		// until the write this function is about to attempt is confirmed durable (committed, or — for a
		// non-git target — atomically written).
		const pending = readPendingPanelFindings(stateDir);
		if (pending.length === 0) return { projected: 0, committed: false };

		const currentText = await readCurrentLedgerText(ledgerPath);
		const { entries: existingEntries } = parseReviewerLedger(currentText);
		const seen = new Set(existingEntries.map(semanticKey));

		// Idempotency (finding #1b): a pending finding whose semantic key is ALREADY present in the
		// ledger (a prior attempt committed it but crashed before clearing the queue) is treated as
		// already-projected — accounted for (removed from the queue below) but never re-appended, and
		// never counted in `projected`. Two content-identical findings WITHIN this same batch also
		// collapse to one write (the ledger's own existing de-dup rule — a duplicate is not a distinct
		// adjudication), matching `parseReviewerLedger`'s reader-side behavior exactly.
		const toAppend: ReviewerLedgerEntry[] = [];
		for (const entry of pending) {
			const key = semanticKey(entry);
			if (seen.has(key)) continue;
			seen.add(key);
			toAppend.push(entry);
		}

		if (toAppend.length === 0) {
			// Every pending finding was already durably present — nothing NEW to write, but all of them
			// are accounted for. Safe to clear (durability was already achieved by an earlier, successful
			// attempt) without touching git at all.
			removeProcessedFromQueue(stateDir, pending);
			return { projected: 0, committed: false };
		}

		// Atomic append (finding #1e): build the full new content in memory and rename it into place —
		// there is no partially-appended state ever observable at `ledgerPath`.
		const sep = currentText.length > 0 && !currentText.endsWith("\n") ? "\n" : "";
		const newContent = `${currentText}${sep}${toAppend.map((e) => `${JSON.stringify(e)}\n`).join("")}`;
		try {
			await atomicWrite(ledgerPath, newContent);
		} catch (err) {
			// The write itself never landed — nothing to revert, nothing was queued away. Re-throw so the
			// caller (SquadManager's fire-and-forget wrapper) logs it; the queue is untouched, so the very
			// next projection attempt retries the identical batch.
			throw new Error(`gauntlet-panel ledger projection: durable write to ${ledgerPath} failed (queue untouched, will retry): ${errText(err)}`);
		}

		if (!(await isGitRepo(ledgerRepo))) {
			// Not a git checkout at all (a bare fixture directory, or a non-git deployment) — the durable
			// file write above IS the "projection" here; there is nothing to commit or revert. Mirrors the
			// contract this module has always had for a non-git `ledgerRepo`.
			removeProcessedFromQueue(stateDir, pending);
			return { projected: toAppend.length, committed: false };
		}

		// Path-scoped commit (finding #1c) — verified empirically: `git commit -m <msg> -- <path>` commits
		// ONLY that path's current working-tree content, requires NO prior `git add`, and leaves any OTHER
		// staged/unstaged change in the repo completely untouched.
		const rel = ledgerPath.startsWith(ledgerRepo) ? ledgerPath.slice(ledgerRepo.length).replace(/^[/\\]+/, "") : ledgerPath;
		const commit = await git(["commit", "-m", `chore(rail): record ${toAppend.length} gauntlet-panel finding${toAppend.length === 1 ? "" : "s"}`, "--", rel], ledgerRepo);
		if (commit.code === 0) {
			// Durability-first (finding #1a): clear ONLY now, after the commit has genuinely succeeded.
			removeProcessedFromQueue(stateDir, pending);
			return { projected: toAppend.length, committed: true };
		}

		// FULL RESTORE (finding #1d): `git checkout HEAD -- <path>` resets BOTH the index and the working
		// tree for this one path back to HEAD — verified empirically to be a complete revert, unlike
		// `git checkout -- <path>` alone (which restores the working tree from the INDEX, not from HEAD,
		// and does nothing to unstage an already-`add`ed change — the exact gap round 2 found). Every
		// pending finding is re-queued (the WHOLE batch — there is no "partially appended" subset to
		// distinguish anymore, since the append itself was atomic).
		await git(["checkout", "HEAD", "--", rel], ledgerRepo);
		return { projected: 0, committed: false };
	});
}
