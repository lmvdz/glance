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
 * Race notes (documented, not defended beyond fail-closed): the real-tree fingerprint is captured
 * a few git-calls after turn start and re-captured at turn end — an operator edit inside either
 * capture window lands on the safe side (mismatch → hold). The turn-start WORKTREE baseline reuses
 * the previous turn's end tree when available (the worktree does not change between turns), so the
 * agent's first mid-capture edit cannot be silently excluded from the patch; only the very first
 * turn of a daemon's tenure captures live, under the model's own multi-second first-token floor.
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
 */
export async function applyPatchToRealTree(realDir: string, patch: string): Promise<ApplyResult> {
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
 *  not change between turns, and reusing it closes the capture-races-first-edit window. */
export async function beginTurn(realDir: string, worktree: string, priorEndTree?: string): Promise<BoundaryTurnStart> {
	const start: BoundaryTurnStart = {};
	const real = await captureRealTreeState(realDir);
	if (real.ok) start.realFingerprint = real.fingerprint;
	else start.realFailure = real.reason;
	if (priorEndTree) {
		start.startTree = priorEndTree;
	} else {
		const tree = await captureWorktreeTree(worktree);
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

	// 4. Unchanged and provably so — apply. A conflicting patch (e.g. the real tree carried
	//    uncommitted WIP in the same files since before the session) still aborts atomically.
	const applied = await applyPatchToRealTree(realDir, patch.patch);
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

	async hold(e: { agentId: string; turn: number; realDir: string; reason: string; patch: string }): Promise<HeldSync> {
		if (e.patch.length > MAX_SYNC_PATCH_BYTES) throw new Error(`held patch too large (${e.patch.length} bytes)`);
		await fs.mkdir(this.dir, { recursive: true });
		const id = randomUUID();
		const patchFile = path.join(this.dir, `${id}.patch`);
		// Patch body FIRST, ledger line second — a ledger entry must never point at a missing body.
		await fs.writeFile(patchFile, e.patch);
		const held: HeldSync = { id, agentId: e.agentId, turn: e.turn, realDir: e.realDir, reason: e.reason, patchFile, patchBytes: e.patch.length, createdAt: Date.now() };
		await fs.appendFile(this.ledger, `${JSON.stringify({ kind: "held", ...held } satisfies LedgerLine)}\n`);
		return held;
	}

	/** All unresolved holds, oldest-first in append order (= application order). */
	async listAllHeld(): Promise<HeldSync[]> {
		const raw = await fs.readFile(this.ledger, "utf8").catch(() => "");
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
		await fs.appendFile(this.ledger, `${JSON.stringify({ kind: "resolved", id, outcome, at: Date.now() } satisfies LedgerLine)}\n`);
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
 * by `git apply --check`. Held patches replay strictly in append order; the first conflict stops
 * the run with everything after it still held ("still divergent"), nothing half-applied.
 */
export async function applyHeldNow(store: HeldSyncStore, agentId: string, realDir: string): Promise<ApplyHeldResult> {
	const cap = await captureRealTreeState(realDir);
	if (!cap.ok) return { ok: false, applied: 0, remaining: (await store.listHeld(agentId)).length, reason: `couldn't verify your checkout: ${cap.reason}` };
	const held = await store.listHeld(agentId);
	if (held.length === 0) return { ok: true, applied: 0, remaining: 0 };
	let applied = 0;
	for (const h of held) {
		const patch = await fs.readFile(h.patchFile, "utf8").catch(() => undefined);
		if (patch === undefined) {
			return { ok: false, applied, remaining: held.length - applied, reason: `held patch body is missing (${path.basename(h.patchFile)}) — inspect ${store.root}` };
		}
		const res = await applyPatchToRealTree(realDir, patch);
		if (!res.ok) return { ok: false, applied, remaining: held.length - applied, reason: `turn ${h.turn} is still divergent: ${res.reason}` };
		await store.resolve(h.id, "applied");
		applied++;
	}
	return { ok: true, applied, remaining: 0 };
}
