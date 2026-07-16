/**
 * Boundary sync — one-directional per-turn patch-apply into the operator's REAL checkout
 * (plans/daily-onramp/03-boundary-sync.md).
 *
 * A `glance here` session runs in an isolated worktree (OMPSQ-40 stays law), but its edits should
 * show up in the directory the operator launched `here` from — without ever racing the operator or
 * discarding their own uncommitted work. Each finished turn applies its own patch to the real tree
 * IFF the real tree provably has not moved since the turn started; on any divergence — or on any
 * failure to even establish that precondition — the daemon holds the patch (durable, in the state
 * dir) and raises a visible attention item instead. Absence of proof that the tree is safe is
 * always treated as proof it is unsafe:
 *
 *   - A failed fingerprint capture is a FAILURE, never an empty-string fingerprint — it can never
 *     compare equal to anything, so it can never authorize an apply (the concern's fail-closed core).
 *   - The ONLY git-write this module ever runs against the real directory is the single,
 *     precondition-gated `git apply` (preceded by `git apply --check`, so a conflicting patch
 *     aborts before touching a single file). Fingerprinting is read-only by construction: no
 *     `git add`, no stash, no index writes — the same pattern `adopt()` uses (squad-manager.ts).
 *   - A held backlog blocks later auto-applies: turn N+1's patch can depend on turn N's hunks, so
 *     once anything is held, everything after it holds too and the explicit apply replays in order.
 *
 * Per-turn scoping: the turn patch is diff(turn-start worktree tree, turn-end worktree tree) — NOT
 * `worktreeDiffSinceFork` (explore.ts), which spans the worktree's whole history since it forked
 * and would re-apply already-applied hunks every turn. The worktree tree snapshot uses a private
 * temp GIT_INDEX_FILE (`read-tree HEAD` → `add -A` → `write-tree`, the `git stash create`
 * technique): it writes loose objects into the repo's shared object DB (gc-able, invisible to both
 * checkouts) but never touches the worktree's files or its real index. The three-command
 * fingerprint alone cannot express a start→end DELTA — only equality — which is why the worktree
 * side snapshots trees while the real-tree side only fingerprints.
 *
 * Race notes — three windows, two defended, one residual and named honestly:
 *   1. Capture windows (turn start / turn end): the real-tree fingerprint is captured a few
 *      git-calls after turn start and re-captured at turn end — an operator edit inside either
 *      window lands on the safe side (mismatch → hold). The turn-start WORKTREE baseline reuses the
 *      previous turn's end tree when available (the worktree does not change between turns), so the
 *      agent's first mid-capture edit cannot be silently excluded from the patch; only the very
 *      first turn of a daemon's tenure captures live, under the model's multi-second first-token
 *      floor.
 *   2. Fingerprint→apply window: the end fingerprint proves stability only at capture time, and
 *      `git apply` runs AFTER it. `applyPatchToRealTree` therefore re-fingerprints once more after
 *      `git apply --check` passes, immediately before the write (`expectedFingerprint`), shrinking
 *      the exposure from "compare + temp-file + check + apply" to the final `git apply` spawn alone.
 *   3. RESIDUAL (not defendable from this side of the filesystem): an operator edit — e.g. an
 *      editor save — landing anywhere between the START of the last re-fingerprint and the end of
 *      the `git apply` spawn. Note the re-fingerprint is itself FOUR sequential git spawns, not an
 *      atomic observation: an edit interleaving its sub-commands can assemble a stale-but-matching
 *      fingerprint (e.g. a tracked-file save landing after `git diff` ran but before `ls-files`
 *      goes unseen), so the honest exposure is the whole recheck PLUS the apply — tens of
 *      milliseconds — not the apply spawn alone. git's context validation still aborts the whole
 *      patch when such an edit overlaps a hunk (→ hold); a DISJOINT same-file edit can interleave
 *      with apply's in-place rewrite of that file. Closing this fully needs an OS-level file lock
 *      the operator's editor also honors, which does not exist. Daemon-side writers ARE serialized:
 *      squad-manager keys the sync/apply promise chain by the REAL DIRECTORY (realpath + literal
 *      path), so two `here` sessions on one checkout can never fingerprint/apply concurrently (one
 *      daemon per state dir is the standing topology; multiple daemons on one checkout are out of
 *      scope).
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseNulList } from "./adopt.ts";
import { hardenedGit as rawHardenedGit } from "./git-harden.ts";

/** hardenedGit, but spawn-safe: `Bun.spawn` THROWS synchronously when the cwd no longer exists
 *  (ENOENT), and this module's contract is that every git failure — including "the directory is
 *  gone" — comes back as a non-zero result that fails the capture, never as an exception that
 *  bypasses the fail-closed result plumbing. */
async function hardenedGit(...args: Parameters<typeof rawHardenedGit>): ReturnType<typeof rawHardenedGit> {
	try {
		return await rawHardenedGit(...args);
	} catch (e) {
		return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
	}
}

/** Cap a held patch (DoS parity with adopt's MAX_PATCH_BYTES). */
export const MAX_SYNC_PATCH_BYTES = 64 * 1024 * 1024;

export type CaptureResult = { ok: true; fingerprint: string } | { ok: false; reason: string };
export type TreeResult = { ok: true; tree: string } | { ok: false; reason: string };
export type PatchResult = { ok: true; patch: string } | { ok: false; reason: string };
export type ApplyResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const gitErr = (what: string, r: { code: number; stderr: string }): string => `${what} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300) || "no stderr"}`;

/**
 * Read-only tree-state fingerprint of the REAL checkout (fail-closed by construction — see module
 * doc). sha256 over: HEAD sha + tracked diff vs HEAD (`--binary`, textconv/ext-diff neutralized) +
 * untracked path list + untracked CONTENT hashes. The content hashes go beyond the concern's
 * three-command sketch deliberately: path-only hashing would let a mid-turn edit to an untracked
 * file slip past the divergence check and be clobbered by the apply's own file writes.
 * Any sub-command failing fails the whole capture — never an empty or partial fingerprint.
 */
export async function captureRealTreeState(realDir: string): Promise<CaptureResult> {
	const head = await hardenedGit(["rev-parse", "HEAD"], { cwd: realDir });
	if (head.code !== 0) return fail(gitErr("git rev-parse HEAD", head));
	const diff = await hardenedGit(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"], { cwd: realDir });
	if (diff.code !== 0) return fail(gitErr("git diff", diff));
	const others = await hardenedGit(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: realDir });
	if (others.code !== 0) return fail(gitErr("git ls-files", others));
	const untracked = parseNulList(others.stdout);
	let untrackedHashes = "";
	if (untracked.length > 0) {
		// `hash-object --stdin-paths` reads newline-separated paths, so a path CONTAINING a newline
		// can't be expressed — fail the capture (fail-closed) rather than hash the wrong file set.
		if (untracked.some((p) => p.includes("\n"))) return fail("an untracked path contains a newline — cannot fingerprint safely");
		const hashed = await hardenedGit(["hash-object", "--stdin-paths"], { cwd: realDir, stdin: `${untracked.join("\n")}\n` });
		if (hashed.code !== 0) return fail(gitErr("git hash-object (untracked content)", hashed));
		untrackedHashes = hashed.stdout;
	}
	const fingerprint = createHash("sha256")
		.update(head.stdout)
		.update("\0")
		.update(diff.stdout)
		.update("\0")
		.update(others.stdout)
		.update("\0")
		.update(untrackedHashes)
		.digest("hex");
	return { ok: true, fingerprint };
}

/**
 * Snapshot the worktree's exact current state (tracked changes + untracked files, excludes
 * respected) as a git TREE object, via a private temp GIT_INDEX_FILE — never the worktree's real
 * index, never its files. Objects land in the shared object DB (unreachable → gc'd), which is the
 * one deliberate deviation from the pure three-command read (see module doc: a fingerprint can
 * prove equality but cannot produce the start→end patch this concern exists to apply).
 */
export async function captureWorktreeTree(worktree: string): Promise<TreeResult> {
	let tmpDir: string;
	try {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glance-bsync-"));
	} catch (e) {
		return fail(`temp index dir: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		const env = { GIT_INDEX_FILE: path.join(tmpDir, "index") };
		const read = await hardenedGit(["read-tree", "HEAD"], { cwd: worktree, env });
		if (read.code !== 0) return fail(gitErr("git read-tree", read));
		const add = await hardenedGit(["add", "-A"], { cwd: worktree, env });
		if (add.code !== 0) return fail(gitErr("git add -A (temp index)", add));
		const write = await hardenedGit(["write-tree"], { cwd: worktree, env });
		if (write.code !== 0) return fail(gitErr("git write-tree", write));
		const tree = write.stdout.trim();
		if (!/^[0-9a-f]{40,64}$/.test(tree)) return fail(`git write-tree returned a non-sha: ${tree.slice(0, 80)}`);
		return { ok: true, tree };
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** The turn's own delta: diff(startTree, endTree), binary-safe, driver-neutralized. */
export async function computeTurnPatch(worktree: string, startTree: string, endTree: string): Promise<PatchResult> {
	if (startTree === endTree) return { ok: true, patch: "" };
	const diff = await hardenedGit(["diff-tree", "-r", "-p", "--binary", "--no-ext-diff", "--no-textconv", startTree, endTree], { cwd: worktree });
	if (diff.code !== 0) return fail(gitErr("git diff-tree", diff));
	return { ok: true, patch: diff.stdout };
}

/**
 * The single git-write against the real directory: `git apply --check` first (whole-patch dry run),
 * then the apply. `git apply` is itself atomic (it verifies every hunk before writing anything and
 * refuses repo-escaping paths), so a conflicting patch leaves the real tree byte-identical. It
 * writes working-tree files only — never the operator's index, never a ref.
 *
 * `expectedFingerprint` (the auto path passes it; the explicit operator-click path deliberately
 * does not — see `applyHeldNow`): after `--check` passes and immediately before the write, the real
 * tree is fingerprinted ONE more time and compared. This closes race window 2 in the module doc —
 * without it, an operator edit between the turn-end fingerprint and the apply would be written into
 * even though the precondition no longer holds. A mismatch (or a failed capture) fails the apply
 * with nothing written; only the final `git apply` spawn itself remains exposed (window 3).
 */
export async function applyPatchToRealTree(realDir: string, patch: string, expectedFingerprint?: string): Promise<ApplyResult> {
	if (patch.trim().length === 0) return { ok: true };
	let tmpDir: string;
	try {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glance-bsync-apply-"));
	} catch (e) {
		return fail(`temp patch dir: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		const patchFile = path.join(tmpDir, "turn.patch");
		await fs.writeFile(patchFile, patch);
		const check = await hardenedGit(["apply", "--check", "--whitespace=nowarn", patchFile], { cwd: realDir });
		if (check.code !== 0) return fail(gitErr("git apply --check", check));
		if (expectedFingerprint !== undefined) {
			const recheck = await captureRealTreeState(realDir);
			if (!recheck.ok) return fail(`pre-apply re-fingerprint failed: ${recheck.reason}`);
			if (recheck.fingerprint !== expectedFingerprint) return fail("your checkout changed between the safety check and the apply");
		}
		const applied = await hardenedGit(["apply", "--whitespace=nowarn", patchFile], { cwd: realDir });
		if (applied.code !== 0) return fail(gitErr("git apply", applied));
		return { ok: true };
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

// ── Turn lifecycle ───────────────────────────────────────────────────────────────────────────────

/** What turn start managed to establish. Either side may have failed — failures are RECORDED, not
 *  defaulted, so turn end can hold with the precise reason instead of comparing against nothing. */
export interface BoundaryTurnStart {
	/** Real-tree fingerprint at turn start; absent ⇔ capture failed (see realFailure). */
	realFingerprint?: string;
	/** Worktree tree sha at turn start; absent ⇔ capture failed (see treeFailure). */
	startTree?: string;
	realFailure?: string;
	treeFailure?: string;
}

/** Capture both turn-start baselines. Never throws; failures ride the returned record. When the
 *  previous turn's end tree is known, reuse it as this turn's start baseline — the worktree does
 *  not change between turns, and reusing it closes the capture-races-first-edit window.
 *
 *  `earlyTree`: a worktree snapshot the CALLER started at the actual turn boundary, before this
 *  call was scheduled. beginTurn runs on the per-checkout serialization chain, which can be parked
 *  behind another session's long replay — a live worktree capture taken only THEN would include
 *  the agent's first edits in the baseline and silently EXCLUDE them from the turn patch (a lost
 *  update, not a hold). Only consulted when there is no priorEndTree (a session's first turn). */
export async function beginTurn(realDir: string, worktree: string, priorEndTree?: string, earlyTree?: Promise<TreeResult>): Promise<BoundaryTurnStart> {
	const start: BoundaryTurnStart = {};
	const real = await captureRealTreeState(realDir);
	if (real.ok) start.realFingerprint = real.fingerprint;
	else start.realFailure = real.reason;
	if (priorEndTree) {
		start.startTree = priorEndTree;
	} else {
		const tree = await (earlyTree ?? captureWorktreeTree(worktree));
		if (tree.ok) start.startTree = tree.tree;
		else start.treeFailure = tree.reason;
	}
	return start;
}

export type SyncOutcome =
	| { kind: "noop"; endTree?: string }
	| { kind: "applied"; endTree: string; patchBytes: number }
	| { kind: "held"; endTree?: string; reason: string; held?: HeldSync }
	/** The turn's changes exist but could not even be captured as a patch — nothing to hold, the
	 *  operator is pointed at the existing worktree diff view instead. Still a hold, never an apply. */
	| { kind: "uncapturable"; reason: string };

/**
 * The turn-end decision, in one auditable place. Every branch that is not the single
 * fingerprints-match branch ends in hold/uncapturable — there is no path where a failure mode
 * touches the real tree.
 */
export async function syncTurnEnd(args: {
	realDir: string;
	worktree: string;
	start: BoundaryTurnStart;
	store: HeldSyncStore;
	agentId: string;
	turn: number;
}): Promise<SyncOutcome> {
	const { realDir, worktree, start, store, agentId, turn } = args;

	// 1. The turn's own patch. Without a start baseline or an end tree there is no patch to apply
	//    OR hold — surface that as its own outcome (attention, no held entry).
	if (!start.startTree) return { kind: "uncapturable", reason: `turn-start worktree snapshot failed: ${start.treeFailure ?? "unknown"}` };
	const end = await captureWorktreeTree(worktree);
	if (!end.ok) return { kind: "uncapturable", reason: `turn-end worktree snapshot failed: ${end.reason}` };
	const patch = await computeTurnPatch(worktree, start.startTree, end.tree);
	if (!patch.ok) return { kind: "uncapturable", reason: `turn patch: ${patch.reason}` };
	if (patch.patch.trim().length === 0) return { kind: "noop", endTree: end.tree };

	const hold = async (reason: string): Promise<SyncOutcome> => {
		const held = await store.hold({ agentId, turn, realDir, reason, patch: patch.patch });
		return { kind: "held", endTree: end.tree, reason, held };
	};

	// 2. Ordering: anything already held means this patch may depend on unapplied hunks — hold it
	//    behind the backlog rather than auto-applying out of order.
	const backlog = await store.listHeld(agentId);
	if (backlog.length > 0) return hold(`${backlog.length} earlier turn(s) are already held — applying in order needs your go-ahead`);

	// 3. The precondition. A capture failure at either end is the SAME code path as a genuine
	//    divergence: hold + attention, never an apply.
	if (!start.realFingerprint) return hold(`couldn't fingerprint your checkout at turn start: ${start.realFailure ?? "unknown"}`);
	const now = await captureRealTreeState(realDir);
	if (!now.ok) return hold(`couldn't re-fingerprint your checkout at turn end: ${now.reason}`);
	if (now.fingerprint !== start.realFingerprint) return hold("your checkout changed during this turn");

	// 4. Unchanged and provably so — apply, with one last-instant re-fingerprint inside the apply
	//    (after `--check`, before the write) so an operator edit in the fingerprint→apply window
	//    fails the apply into a hold instead of being written into (module doc, race window 2).
	//    A conflicting patch (e.g. the real tree carried uncommitted WIP in the same files since
	//    before the session) still aborts atomically.
	const applied = await applyPatchToRealTree(realDir, patch.patch, now.fingerprint);
	if (!applied.ok) return hold(`the turn's patch did not apply cleanly: ${applied.reason}`);
	return { kind: "applied", endTree: end.tree, patchBytes: patch.patch.length };
}

// ── Held-patch store (durable, state dir) ────────────────────────────────────────────────────────

export interface HeldSync {
	/** Stable identity across restarts (file name + resolve key) — the per-process turn counter
	 *  resets on daemon restart, so (agentId, turn) alone is NOT unique. */
	id: string;
	agentId: string;
	turn: number;
	realDir: string;
	reason: string;
	/** Absolute path of the patch body (kept out of the JSONL line — patches can be MBs). */
	patchFile: string;
	patchBytes: number;
	createdAt: number;
}

type LedgerLine = ({ kind: "held" } & HeldSync) | { kind: "resolved"; id: string; outcome: "applied" | "discarded"; at: number };

/**
 * Durable held-patch ledger: an append-only JSONL (one small line per event) with patch bodies as
 * sibling files. Append-only means a crash mid-resolve loses at worst the RESOLUTION marker (the
 * patch is retried, `git apply --check` makes a re-apply of an already-applied patch fail closed
 * into "still divergent" rather than double-applying silently) — never the held patch itself.
 */
export class HeldSyncStore {
	private readonly ledger: string;

	constructor(private readonly dir: string) {
		this.ledger = path.join(dir, "held.jsonl");
	}

	/** Where holds live on disk — surfaced in operator-facing messages. */
	get root(): string {
		return this.dir;
	}

	/** Append one ledger line, guaranteeing it STARTS on a fresh line: a crash mid-append can leave
	 *  a torn tail with no trailing newline, and appending directly after it would weld the next
	 *  (perfectly valid) event onto the garbage — losing the NEW event too, not just the torn one.
	 *  Costs one open+stat+1-byte read per event; events are rare. */
	private async appendLine(json: string): Promise<void> {
		let prefix = "";
		try {
			const fh = await fs.open(this.ledger, "r");
			try {
				const { size } = await fh.stat();
				if (size > 0) {
					const tail = Buffer.alloc(1);
					await fh.read(tail, 0, 1, size - 1);
					if (tail[0] !== 0x0a) prefix = "\n";
				}
			} finally {
				await fh.close();
			}
		} catch {
			// No ledger yet, or unreadable — the append below surfaces any real failure itself.
		}
		await fs.appendFile(this.ledger, `${prefix}${json}\n`);
	}

	async hold(e: { agentId: string; turn: number; realDir: string; reason: string; patch: string }): Promise<HeldSync> {
		if (e.patch.length > MAX_SYNC_PATCH_BYTES) throw new Error(`held patch too large (${e.patch.length} bytes)`);
		await fs.mkdir(this.dir, { recursive: true });
		const id = randomUUID();
		const patchFile = path.join(this.dir, `${id}.patch`);
		// Patch body FIRST, ledger line second — a ledger entry must never point at a missing body.
		await fs.writeFile(patchFile, e.patch);
		const held: HeldSync = { id, agentId: e.agentId, turn: e.turn, realDir: e.realDir, reason: e.reason, patchFile, patchBytes: e.patch.length, createdAt: Date.now() };
		await this.appendLine(JSON.stringify({ kind: "held", ...held } satisfies LedgerLine));
		return held;
	}

	/** All unresolved holds, oldest-first in append order (= application order). Throws when the
	 *  ledger EXISTS but cannot be read: an unreadable ledger is NOT an empty backlog — reading it
	 *  as one would let the next turn auto-apply ahead of an older held dependency, and let an
	 *  explicit Apply report ok/0 and clear a row that still has patches behind it (fail-open).
	 *  Only ENOENT (no ledger was ever written) is genuinely empty. */
	async listAllHeld(): Promise<HeldSync[]> {
		let raw: string;
		try {
			raw = await fs.readFile(this.ledger, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
			throw new Error(`held-sync ledger unreadable (${this.ledger}): ${e instanceof Error ? e.message : String(e)}`);
		}
		const held = new Map<string, HeldSync>();
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let parsed: LedgerLine;
			try {
				parsed = JSON.parse(line) as LedgerLine;
			} catch {
				continue; // a torn tail line (crash mid-append) — ignore; complete lines are one-per-write
			}
			if (parsed.kind === "held") held.set(parsed.id, parsed);
			else held.delete(parsed.id);
		}
		return [...held.values()];
	}

	async listHeld(agentId: string): Promise<HeldSync[]> {
		return (await this.listAllHeld()).filter((h) => h.agentId === agentId);
	}

	async resolve(id: string, outcome: "applied" | "discarded"): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true });
		await this.appendLine(JSON.stringify({ kind: "resolved", id, outcome, at: Date.now() } satisfies LedgerLine));
		// Body cleanup is best-effort — the ledger line is the truth; an orphaned body is inert.
		const body = path.join(this.dir, `${id}.patch`);
		await fs.rm(body, { force: true }).catch(() => {});
	}
}

export interface ApplyHeldResult {
	ok: boolean;
	applied: number;
	remaining: number;
	reason?: string;
}

/**
 * The explicit "apply now" affordance (POST /api/agents/:id/apply-held-sync). Re-runs the
 * fail-closed precondition with a FRESH capture — a tree we cannot even fingerprint is never
 * written to, exactly like the auto path. The DIVERGENCE check differs by design: the turn-start
 * baseline is meaningless once the tree has already diverged (that's why the patch is held), and
 * the operator's click IS the authorization — so cleanliness is judged at patch level, per patch,
 * by `git apply --check`. That authorization covers the tree AS IT STANDS at the click, not
 * whatever it becomes mid-replay: each patch's write is PINNED to a fingerprint captured right
 * before it (`expectedFingerprint`, same last-instant recheck as the auto path), so a checkout
 * that moves under the replay — a branch switch, an editor save — stops the run instead of being
 * written into. Held patches replay strictly in append order; the first conflict stops the run
 * with everything after it still held ("still divergent"), nothing half-applied.
 */
export async function applyHeldNow(store: HeldSyncStore, agentId: string, realDir: string): Promise<ApplyHeldResult> {
	const cap = await captureRealTreeState(realDir);
	if (!cap.ok) return { ok: false, applied: 0, remaining: (await store.listHeld(agentId)).length, reason: `couldn't verify your checkout: ${cap.reason}` };
	const held = await store.listHeld(agentId);
	if (held.length === 0) return { ok: true, applied: 0, remaining: 0 };
	let applied = 0;
	let pin = cap.fingerprint;
	for (const h of held) {
		const patch = await fs.readFile(h.patchFile, "utf8").catch(() => undefined);
		if (patch === undefined) {
			return { ok: false, applied, remaining: held.length - applied, reason: `held patch body is missing (${path.basename(h.patchFile)}) — inspect ${store.root}` };
		}
		const res = await applyPatchToRealTree(realDir, patch, pin);
		if (!res.ok) return { ok: false, applied, remaining: held.length - applied, reason: `turn ${h.turn} is still divergent: ${res.reason}` };
		// The write happened. From here every outcome must COUNT it — reporting "0 applied" after a
		// successful `git apply` would tell the operator nothing changed when their checkout did.
		applied++;
		try {
			await store.resolve(h.id, "applied");
		} catch (e) {
			return {
				ok: false,
				applied,
				remaining: held.length - applied,
				reason: `turn ${h.turn} WAS applied but recording that failed (${e instanceof Error ? e.message : String(e)}) — a re-apply will report it still divergent (crash semantics); inspect ${store.root}`,
			};
		}
		// Re-pin for the next patch: each apply legitimately changes the tree, so the next write is
		// gated on the state THIS apply produced — a third-party edit between patches breaks the pin.
		if (applied < held.length) {
			const next = await captureRealTreeState(realDir);
			if (!next.ok) return { ok: false, applied, remaining: held.length - applied, reason: `couldn't re-verify your checkout after turn ${h.turn}: ${next.reason}` };
			pin = next.fingerprint;
		}
	}
	return { ok: true, applied, remaining: 0 };
}

export interface DiscardHeldResult {
	ok: boolean;
	discarded: number;
	remaining: number;
	reason?: string;
}

/**
 * The explicit "drop it" affordance (POST /api/agents/:id/discard-held-sync) — the recovery path a
 * held backlog otherwise lacks. A patch that can never apply cleanly (the operator already fixed
 * the divergence by hand, or a crash between a successful apply and its `resolve` marker makes the
 * replay's `--check` fail forever) would wedge the backlog, and the backlog-ordering rule then
 * auto-holds EVERY later turn — auto-sync bricked for the session with no in-product way out.
 * Discarding resolves the ledger entries as "discarded" and touches the real tree not at all; the
 * session's worktree still contains every edit (diff view / promote), so nothing is lost — only the
 * pending write to the operator's checkout is dropped. `patchId` discards one specific hold;
 * omitted, the whole backlog for this agent goes.
 */
export async function discardHeldNow(store: HeldSyncStore, agentId: string, patchId?: string): Promise<DiscardHeldResult> {
	const held = await store.listHeld(agentId);
	if (held.length === 0) return { ok: true, discarded: 0, remaining: 0 };
	const targets = patchId === undefined ? held : held.filter((h) => h.id === patchId);
	if (targets.length === 0) return { ok: false, discarded: 0, remaining: held.length, reason: `no held patch ${patchId} for this session` };
	let discarded = 0;
	for (const h of targets) {
		try {
			await store.resolve(h.id, "discarded");
		} catch (e) {
			// Report the PARTIAL count honestly — a mid-loop failure must not read as "nothing
			// happened" when earlier entries were already resolved.
			return { ok: false, discarded, remaining: held.length - discarded, reason: `recording the discard failed (${e instanceof Error ? e.message : String(e)}) — inspect ${store.root}` };
		}
		discarded++;
	}
	return { ok: true, discarded, remaining: held.length - discarded };
}
