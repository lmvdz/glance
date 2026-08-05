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
 * explicit parameter rather than inferring it from the caller's landed repo. BECAUSE it is a single
 * daemon-global path, more than one daemon PROCESS (not just one process's concurrent calls) can
 * genuinely race to project into it — `withRepoLandLock` alone only serializes work inside ONE process;
 * see finding #4's interprocess lock below for the cross-process half of that guarantee.
 *
 * ROUND 3 (glance#356, both lineages adjudicated across 3 rounds — the fix that has fooled 3 prior
 * single-gauntlet passes, each time reintroducing a NARROWER variant): round 2's transaction was still
 * built on the wrong foundation. Every fix below closes one specific way that foundation was wrong.
 *
 *   #1 (CRITICAL, the actual root cause): idempotency/durability keyed off the WORKING-TREE ledger
 *      file's content, not HEAD's. A crash between `atomicWrite`'s rename and the commit below left the
 *      file dirty-but-uncommitted; the retry's `readCurrentLedgerText` read that dirty content, saw
 *      every pending finding already "present," and cleared the queue via the `toAppend.length === 0`
 *      branch WITHOUT EVER COMMITTING — the dirty-main check on the next land refused, and a rollback
 *      (or a plain `git reset --hard`) then silently lost the finding forever. Fix: for a git target,
 *      idempotency/durability now consult ONLY `git show HEAD:<rel>` — never the working file directly.
 *      Before that read is trusted, `reconcileWorkingTreeWithHead` closes any drift between the working
 *      tree and HEAD at that one path (committing the dirty content forward — the append is always
 *      monotonic, so finishing a half-done prior attempt is safe — or, if that commit itself fails,
 *      discarding back to HEAD via a CHECKED `git checkout HEAD -- <path>`). The pending queue is never
 *      cleared unless HEAD (after that reconciliation) genuinely contains the key. For a non-git target
 *      there is no HEAD — the atomic file write remains the sole durability criterion, as before.
 *   #2: `semanticKey` computed directly on a PENDING (never round-tripped through `parseReviewerLedger`)
 *      entry used a DIFFERENT normalization than the file parser's — an untrimmed `severity` (e.g.
 *      `" high "`, plausible straight off an LLM-authored verdict) produced a key invisible to the
 *      `seen` set built from the parser's (trimmed) output, so it double-appended. Fix: every pending
 *      entry is run through `normalizeReviewerLedgerEntry` (the SAME normalization the file parser uses,
 *      exported from `memory/reviewer-weights.ts` for exactly this) before its key is ever computed.
 *   #3: a git-probe or checkout-HEAD failure (an `.git/index.lock` left by another process, or an
 *      ambient `GIT_DIR` pointing somewhere bogus) was either silently misread as "not a git repository"
 *      (downgrading a REAL git target to the non-git write-only path — the write lands but is NEVER
 *      committed, and the queue is cleared anyway) or its result was simply never checked (the restore
 *      `git checkout HEAD -- <path>` call after a failed commit ran but its own exit code was ignored,
 *      so a restore that itself failed — e.g. because of that same lock — was reported as a clean
 *      revert). Fix: every git call in this module strips `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/
 *      `GIT_CEILING_DIRECTORIES` from its environment first (an ambient value can never misclassify a
 *      real checkout), the repo-vs-not-git classification only treats a literal "not a git repository"
 *      stderr as "not git" (anything else THROWS rather than guessing), and the restore checkout's exit
 *      code is checked — a failed restore throws instead of returning as if the tree were clean.
 *   #4: `withRepoLandLock` (in `src/land.ts`) now canonicalizes its lock key via `realpath` (`/repo` vs
 *      `/repo/.` used to be two different `Map` keys, bypassing the lock entirely) — see that module's
 *      doc. That fixes the IN-PROCESS half. This module ALSO layers a real INTERPROCESS lock
 *      (`acquireInterprocessLock` below, an `mkdir`-based advisory lock under `<ledgerRepo>/.git/`) on
 *      top, scoped to just this projection lane, since the reviewer ledger repo is the one daemon-global
 *      target genuinely shared across separate daemon processes (see the module doc's opening note).
 *   #7: `readCurrentLedgerText` used to degrade ANY read error (permission denied, a FIFO, a symlink
 *      loop) to `""` — indistinguishable from a genuinely absent file. An unreadable EXISTING ledger
 *      would then get silently REPLACED by a file containing only the new batch, discarding every prior
 *      row (the T3/T8 honesty rule: a read fault is not an empty file). Fix: only `ENOENT` normalizes to
 *      `""`; every other error throws.
 *
 * (finding #5 — the single-flight coalescing key — and #6 — hermetic-cwd bidirectional containment
 * against the complete managed-repo set — live in `panel.ts`/`panel-spawn.ts` respectively; this module
 * only carries #1/#2/#3/#4/#7.)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_REVIEWER_LEDGER_PATH, normalizeReviewerLedgerEntry, parseReviewerLedger, semanticKey, type ReviewerLedgerEntry } from "../memory/index.ts";
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
 *  write is already best-effort (a disk fault degrades silently rather than breaking the panel).
 *
 *  T5 gauntlet round 3 (glance#356, finding #2): the entry is schema-normalized (`normalizeReviewerLedgerEntry`
 *  — the SAME normalization `parseReviewerLedger` applies to a file row) BEFORE it ever enters the
 *  queue, so the pending queue's own on-disk schema can never drift from the tracked ledger's — a
 *  finding with an untrimmed `severity` (e.g. straight off an LLM-authored verdict JSON) is normalized
 *  here, not just at projection time, so anything that reads the queue directly (tests, observability)
 *  also sees the canonical form. */
export function recordPendingPanelFinding(stateDir: string, entry: ReviewerLedgerEntry): void {
	const store = pendingStore(stateDir);
	const all = store.read();
	const queue = [...(all[PENDING_KEY] ?? []), normalizeReviewerLedgerEntry(entry)];
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

/** T5 gauntlet round 3 (finding #3): stripped from every git call's env so an AMBIENT value (a hostile
 *  or simply misconfigured deployment environment) can never redirect a probe/checkout away from the
 *  `cwd` we explicitly pass — e.g. `GIT_DIR=/nonexistent` makes `rev-parse --is-inside-work-tree` fail
 *  with the EXACT SAME "fatal: not a git repository" message a genuinely non-git `cwd` produces,
 *  misclassifying a real checkout as "not git" and silently downgrading it to the non-git write-only
 *  path (write lands, never committed, queue cleared anyway — the durability bug this whole file
 *  exists to prevent, one layer over). Stripping these means that message can only legitimately appear
 *  when `cwd` truly has no `.git` — which is exactly the case the classification below needs it for. */
const GIT_ENV_STRIP_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"] as const;

function hardenedGitEnv(): Record<string, string> {
	const env: Record<string, string | undefined> = { ...process.env, ...GIT_HARDEN_ENV, ...gitNoSignEnv() };
	for (const k of GIT_ENV_STRIP_KEYS) delete env[k];
	return env as Record<string, string>;
}

/** Status-only git call: stdout/stderr TRIMMED (safe for exit-code/porcelain-flag checks — rev-parse,
 *  add, commit, checkout). Never throws (a spawn fault degrades to `code:1`). */
async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: hardenedGitEnv(), stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (err) {
		return { code: 1, stdout: "", stderr: errText(err) };
	}
}

/** Content-reading git call: stdout returned VERBATIM (never trimmed) — used only for `git show
 *  HEAD:<path>`, where a trailing-newline difference IS a real content difference, not incidental
 *  whitespace, and trimming it would corrupt the byte-exact comparison `reconcileWorkingTreeWithHead`
 *  depends on. */
async function gitContent(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: hardenedGitEnv(), stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr: stderr.trim() };
	} catch (err) {
		return { code: 1, stdout: "", stderr: errText(err) };
	}
}

/** A definitely-absent-`.git` message — matched ONLY after `GIT_ENV_STRIP_KEYS` neutralizes ambient
 *  `GIT_DIR`-family poisoning (finding #3), so this can now only fire for a genuinely non-git `cwd`. */
const NOT_A_GIT_REPO_RE = /not a git repository/i;

/**
 * Classify `repo` as a real git working tree or a genuinely non-git target — THROWS (never silently
 * guesses) on any OTHER probe failure (finding #3): an `.git/index.lock` left by a concurrent process
 * doesn't actually affect `rev-parse --is-inside-work-tree` itself, but a permission fault, a vanished
 * directory, or any other unexpected git error must never be misread as "not a git repository" and
 * silently downgrade a real git target to the non-git (uncommitted) write path.
 */
async function classifyGitTarget(repo: string): Promise<"git" | "not-git"> {
	const r = await git(["rev-parse", "--is-inside-work-tree"], repo);
	if (r.code === 0 && r.stdout === "true") return "git";
	if (NOT_A_GIT_REPO_RE.test(r.stderr)) return "not-git";
	throw new Error(`gauntlet-panel ledger projection: could not determine whether ${repo} is a git repository (probe failed ambiguously — refusing to guess and silently downgrade to the non-git write path): ${r.stderr || r.stdout || `exit ${r.code}`}`);
}

/** A path that genuinely doesn't exist at HEAD yet (no commits at all, or this path was never
 *  committed) — the git-analogue of `readCurrentLedgerText`'s ENOENT case: a legitimate "empty ledger,"
 *  never a probe fault to swallow. */
const HEAD_PATH_ABSENT_RE = /does not exist in ['"]?HEAD['"]?|invalid object name 'HEAD'|bad revision ['"]?HEAD['"]?|unknown revision or path not in the working tree/i;

/**
 * Read `rel`'s content AT HEAD (never the working tree) — T5 gauntlet round 3, finding #1: durability
 * and idempotency for a git target consult ONLY this, never `readCurrentLedgerText`'s working-file
 * read. A path absent at HEAD (fresh ledger, or a repo with zero commits yet) reads as `""`; ANY OTHER
 * git failure throws (finding #3 — never silently treated as "empty").
 */
async function readLedgerTextAtHead(ledgerRepo: string, rel: string): Promise<string> {
	const r = await gitContent(["show", `HEAD:${rel}`], ledgerRepo);
	if (r.code === 0) return r.stdout;
	if (HEAD_PATH_ABSENT_RE.test(r.stderr)) return "";
	throw new Error(`gauntlet-panel ledger projection: could not read ${rel} at HEAD in ${ledgerRepo} (git-probe failure, refusing to guess): ${r.stderr}`);
}

/** Read the ledger's current WORKING-TREE text. A genuinely absent file reads as empty (a fresh
 *  ledger); ANY OTHER read fault (finding #7 — permission denied, a FIFO, a symlink loop) THROWS rather
 *  than degrading to `""` — an unreadable EXISTING file is not the same fact as an absent one, and
 *  conflating them would silently REPLACE a file this function couldn't even read with just the new
 *  batch, discarding every prior row it never actually saw. */
async function readCurrentLedgerText(ledgerPath: string): Promise<string> {
	try {
		return await fs.readFile(ledgerPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw new Error(`gauntlet-panel ledger projection: read fault on ${ledgerPath} (NOT the same fact as an absent file — refusing to treat a genuine I/O fault as an empty ledger and silently replace its contents): ${errText(err)}`);
	}
}

/**
 * Stage-then-commit `rel`, scoped to exactly that path. `git add -- <rel>` first (verified empirically:
 * a WHOLLY UNTRACKED path is rejected by `git commit -- <path>` alone with "pathspec did not match any
 * file(s) known to git" — the module's prior claim that no `add` step was ever needed held only for an
 * ALREADY-tracked, merely-modified file; `git add -- <rel>` is a harmless no-op for that case and the
 * one thing that makes a brand-new path committable). The commit itself remains path-scoped (`-- rel`)
 * so it can NEVER sweep in some OTHER staged/unstaged operator change, `add` included: `git add -- rel`
 * only ever stages `rel`, regardless of what else is dirty in the tree.
 */
async function stageAndCommit(ledgerRepo: string, rel: string, message: string): Promise<{ code: number; stderr: string }> {
	const add = await git(["add", "--", rel], ledgerRepo);
	if (add.code !== 0) return { code: add.code, stderr: add.stderr };
	return git(["commit", "-m", message, "--", rel], ledgerRepo);
}

/**
 * T5 gauntlet round 3, finding #1 (the root cause): reconcile any drift between the WORKING TREE and
 * HEAD at `rel` BEFORE either is ever trusted for idempotency. The dirty case this exists for: a crash
 * between a prior `atomicWrite`'s rename and its commit leaves the working file holding content HEAD
 * doesn't have yet. Since every append this module ever performs is monotonic (current content + new
 * rows, never a removal), finishing that interrupted commit is always safe — so the PRIMARY recovery is
 * to commit the dirty working content forward. Only if that commit itself fails (a genuine git fault,
 * not merely "nothing to commit" — an actual dirty-vs-HEAD difference was already confirmed above) does
 * this fall back to discarding the dirty content via a CHECKED `git checkout HEAD -- <rel>` (finding
 * #3 — an unchecked restore is exactly how round 2 silently left the tree staged-dirty while reporting
 * success). Either path is verified by re-reading the working file afterward and asserting it now
 * matches HEAD; anything else throws rather than proceeding against an unverified tree state.
 */
interface ReconcileResult {
	text: string;
	/** `true` when this call itself performed a repair commit (the crash-recovery path). Surfaced so the
	 *  caller's own `committed` result can honestly reflect it even on a call whose OWN batch had nothing
	 *  new to append (T3/T8 honesty rule: a real commit happened this call, so `committed:false` would
	 *  underreport it). */
	committedRepair: boolean;
}

async function reconcileWorkingTreeWithHead(ledgerRepo: string, ledgerPath: string, rel: string, headText: string): Promise<ReconcileResult> {
	const workingText = await readCurrentLedgerText(ledgerPath);
	if (workingText === headText) return { text: headText, committedRepair: false }; // already clean — the common case, zero extra git calls

	const commit = await stageAndCommit(ledgerRepo, rel, "chore(rail): reconcile dirty gauntlet-panel ledger before projection (crash recovery)");
	if (commit.code === 0) return { text: await readLedgerTextAtHead(ledgerRepo, rel), committedRepair: true };

	const restore = await git(["checkout", "HEAD", "--", rel], ledgerRepo);
	if (restore.code !== 0) {
		throw new Error(`gauntlet-panel ledger projection: could not reconcile a dirty working tree at ${ledgerPath} against HEAD — neither committing it forward (${commit.stderr}) nor restoring it to HEAD (${restore.stderr}) succeeded; the tree may still be dirty, refusing to guess`);
	}
	const afterRestore = await readCurrentLedgerText(ledgerPath);
	if (afterRestore !== headText) {
		throw new Error(`gauntlet-panel ledger projection: restoring ${ledgerPath} to HEAD reported success but its content still does not match HEAD — refusing to proceed against an unverified tree state`);
	}
	return { text: headText, committedRepair: false };
}

// ── finding #4 (companion): an interprocess lock on top of withRepoLandLock's in-process one ────────
// The reviewer ledger repo is a DAEMON-GLOBAL constant (see the module doc) — more than one daemon
// PROCESS can genuinely target it concurrently, which `withRepoLandLock`'s in-process `Map` cannot see
// at all. An `mkdir`-based lock directory is atomic across processes on every filesystem this codebase
// targets (POSIX `mkdir` fails EEXIST if another process already holds it) and needs no new dependency.
// Scoped to `<ledgerRepo>/.git/` — for a non-git `ledgerRepo` (no `.git` to place it under) `mkdir` fails
// ENOENT and this degrades to a no-op release, which is correct: a non-git target's only durability
// criterion is the atomic file write, already inherently single-writer-safe at the filesystem level.

const INTERPROCESS_LOCK_DIRNAME = "panel-ledger-projection.lock";
const INTERPROCESS_LOCK_STALE_MS = 5 * 60_000; // long enough for any real commit; short enough to reclaim after a genuine crash
const INTERPROCESS_LOCK_RETRY_MS = 50;
const INTERPROCESS_LOCK_MAX_WAIT_MS = 30_000;

async function acquireInterprocessLock(ledgerRepo: string): Promise<() => Promise<void>> {
	const dir = path.join(ledgerRepo, ".git", INTERPROCESS_LOCK_DIRNAME);
	const deadline = Date.now() + INTERPROCESS_LOCK_MAX_WAIT_MS;
	for (;;) {
		try {
			await fs.mkdir(dir);
			return async () => {
				await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
			};
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") return async () => {}; // no `.git` here (non-git target) — nothing to lock
			try {
				const st = await fs.stat(dir);
				if (Date.now() - st.mtimeMs > INTERPROCESS_LOCK_STALE_MS) {
					await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
					continue; // reclaim a lock a crashed process never released
				}
			} catch {
				/* the lock vanished between our failed mkdir and this stat — the holder just released it; retry */
			}
			if (Date.now() > deadline) {
				throw new Error(`gauntlet-panel ledger projection: could not acquire the interprocess lock ${dir} after ${INTERPROCESS_LOCK_MAX_WAIT_MS}ms (another process holds it) — aborting rather than racing a concurrent writer`);
			}
			await new Promise((r) => setTimeout(r, INTERPROCESS_LOCK_RETRY_MS));
		}
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
	/** `true` when a git commit happened THIS call — either the batch's own append commit, OR (T5 round 3,
	 *  finding #1) a crash-recovery REPAIR commit that reconciled a dirty working tree left by a prior
	 *  interrupted attempt (honestly reported even when `projected` is 0, since a real commit still
	 *  happened). `false` covers the remaining cases, distinguishable only by reading the queue/tree
	 *  afterward: a non-git `ledgerRepo` (the durable file write still happened; nothing to commit);
	 *  nothing NEW to write AND no reconciliation was needed (every pending finding was already durable —
	 *  idempotency, not a failure); or a genuine commit failure (fully reverted, every finding re-queued —
	 *  see the module doc's finding #1d). */
	committed: boolean;
}

/**
 * Move every currently-queued panel finding into the tracked reviewer ledger, guarded by
 * `withRepoLandLock(ledgerRepo, ...)` — the SAME per-repo serialization a live land uses — AND (finding
 * #4) an interprocess lock on top, since this ledger repo is a daemon-global target. Intended to run OUT
 * of the land path: `SquadManager.land()` calls this fire-and-forget AFTER a merge has settled, never
 * from inside `runValidatorGate`/`landBranch`'s own critical section. A no-op when the queue is empty —
 * never touches the filesystem or git for nothing.
 *
 * See the module doc for the full transactional contract: HEAD (never the working file) is the sole
 * durability/idempotency criterion for a git target, reconciled BEFORE it's trusted; schema-normalized
 * pending entries; checked (never swallowed) git probes/restores; the interprocess lock; and a read
 * fault that is never conflated with an absent file.
 */
export async function projectPendingPanelFindings(stateDir: string, ledgerRepo: string, ledgerPath: string = DEFAULT_REVIEWER_LEDGER_PATH): Promise<PanelLedgerProjection> {
	return withRepoLandLock(ledgerRepo, async () => {
		const releaseInterprocessLock = await acquireInterprocessLock(ledgerRepo); // finding #4 companion
		try {
			// Durability-first (finding #1a): read, but do NOT clear, the queue yet. Nothing is removed
			// until the write this function is about to attempt is confirmed durable (committed, or — for
			// a non-git target — atomically written).
			const pending = readPendingPanelFindings(stateDir);
			if (pending.length === 0) return { projected: 0, committed: false };

			const kind = await classifyGitTarget(ledgerRepo); // finding #3: throws rather than guessing
			const rel = ledgerPath.startsWith(ledgerRepo) ? ledgerPath.slice(ledgerRepo.length).replace(/^[/\\]+/, "") : ledgerPath;

			// Finding #1 (the root cause): for a git target, the ONLY thing idempotency/durability ever
			// consults is HEAD — never the working file directly. Any drift between the two at this path is
			// reconciled (committed forward, or restored to HEAD) BEFORE that read is trusted, so a crash
			// left over from a PRIOR interrupted attempt can never be mistaken for "already durable."
			let committedRepair = false;
			let currentText: string;
			if (kind === "git") {
				const reconciled = await reconcileWorkingTreeWithHead(ledgerRepo, ledgerPath, rel, await readLedgerTextAtHead(ledgerRepo, rel));
				currentText = reconciled.text;
				committedRepair = reconciled.committedRepair;
			} else {
				currentText = await readCurrentLedgerText(ledgerPath);
			}

			const { entries: existingEntries } = parseReviewerLedger(currentText);
			const seen = new Set(existingEntries.map(semanticKey));

			// Finding #2: every pending entry is normalized THE SAME WAY the file parser normalizes a row
			// (trim + severity-enum-check) before its key is computed — otherwise an untrimmed severity
			// (e.g. `" high "`) produces a key invisible to `seen` (built from the parser's trimmed output)
			// and double-appends on a retry.
			const normalizedPending = pending.map(normalizeReviewerLedgerEntry);

			// Idempotency (finding #1b): a pending finding whose semantic key is ALREADY present in HEAD (a
			// prior attempt committed it but crashed before clearing the queue) is treated as
			// already-projected — accounted for (removed from the queue below) but never re-appended, and
			// never counted in `projected`. Two content-identical findings WITHIN this same batch also
			// collapse to one write, matching `parseReviewerLedger`'s reader-side behavior exactly.
			const toAppend: ReviewerLedgerEntry[] = [];
			for (const entry of normalizedPending) {
				const key = semanticKey(entry);
				if (seen.has(key)) continue;
				seen.add(key);
				toAppend.push(entry);
			}

			if (toAppend.length === 0) {
				// Every pending finding is ALREADY durably present in HEAD (never merely in a dirty working
				// file — the reconciliation above guarantees `currentText` reflects HEAD for a git target) —
				// safe to clear without touching git any further. `committed` honestly reflects whether
				// reconciliation itself performed a repair commit THIS call (T3/T8 honesty rule) — a crash
				// recovered right here is still a commit that happened during this call, not a no-op.
				removeProcessedFromQueue(stateDir, pending);
				return { projected: 0, committed: committedRepair };
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

			if (kind === "not-git") {
				// Not a git checkout at all (a bare fixture directory, or a non-git deployment) — the durable
				// file write above IS the "projection" here; there is nothing to commit or revert. Mirrors the
				// contract this module has always had for a non-git `ledgerRepo`.
				removeProcessedFromQueue(stateDir, pending);
				return { projected: toAppend.length, committed: false };
			}

			// Path-scoped stage+commit (finding #1c, refined): `git add -- rel` then `git commit -m <msg>
			// -- rel` — the `add` is REQUIRED for a wholly new (never-tracked) path (verified empirically:
			// `commit -- <path>` alone rejects it with "pathspec did not match"), and is a harmless no-op
			// for an already-tracked, merely-modified file. Both are scoped to exactly `rel`, so neither
			// step can ever sweep in some OTHER staged/unstaged operator change.
			const commit = await stageAndCommit(ledgerRepo, rel, `chore(rail): record ${toAppend.length} gauntlet-panel finding${toAppend.length === 1 ? "" : "s"}`);
			if (commit.code === 0) {
				// Durability-first (finding #1a): clear ONLY now, after the commit has genuinely succeeded.
				removeProcessedFromQueue(stateDir, pending);
				return { projected: toAppend.length, committed: true };
			}

			// FULL RESTORE (finding #1d, CHECKED per finding #3): `git checkout HEAD -- <path>` resets BOTH
			// the index and the working tree for this one path back to HEAD — verified empirically to be a
			// complete revert, unlike `git checkout -- <path>` alone (which restores the working tree from
			// the INDEX, not from HEAD). Round 2's bug: this call's OWN result was never checked — a
			// restore that itself failed (e.g. an `.git/index.lock` left by a concurrent process) was
			// reported as a clean revert regardless. Now it THROWS instead, since a failed restore means
			// the tree may genuinely still be dirty and this function cannot honestly claim otherwise. Every
			// pending finding stays queued (the whole batch — there is no partial subset to distinguish,
			// since the append itself was atomic).
			const restore = await git(["checkout", "HEAD", "--", rel], ledgerRepo);
			if (restore.code !== 0) {
				throw new Error(`gauntlet-panel ledger projection: commit to ${rel} in ${ledgerRepo} failed (${commit.stderr}) AND restoring it to HEAD also failed (${restore.stderr}) — the tree may be left dirty; refusing to report a clean revert that didn't happen`);
			}
			return { projected: 0, committed: false };
		} finally {
			await releaseInterprocessLock();
		}
	});
}
