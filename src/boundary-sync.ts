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
 *   3. RESIDUAL, but now DETECT-AND-RECOVER, not silent (C1 hardening): an operator edit — e.g. an
 *      editor save — landing anywhere between the START of the last re-fingerprint and the end of
 *      the `git apply` spawn. Note the re-fingerprint is itself FOUR sequential git spawns, not an
 *      atomic observation: an edit interleaving its sub-commands can assemble a stale-but-matching
 *      fingerprint (e.g. a tracked-file save landing after `git diff` ran but before `ls-files`
 *      goes unseen), so the honest exposure is the whole recheck PLUS the apply — tens of
 *      milliseconds — not the apply spawn alone. git's context validation still aborts the whole
 *      patch when such an edit overlaps a hunk (→ hold); a DISJOINT same-file edit can interleave
 *      with apply's in-place rewrite of that file, which `git apply` performs as a read-modify-write
 *      with no OS-level lock the operator's editor also honors — that lock does not exist, so this
 *      window cannot be CLOSED from this side of the filesystem. What `applyPatchToRealTree` does
 *      instead: snapshot every patch-touched path's real-tree content immediately before the write,
 *      then after a successful `git apply`, recompute what the patch alone should have produced (by
 *      replaying it against that same snapshot in a scratch directory) and compare it to what is
 *      actually on disk. A mismatch means something else wrote into one of those exact paths inside
 *      the apply spawn itself — reported as a critical `ApplyResult.divergence` (paths + a durable
 *      on-disk capture of the pre-write content for manual recovery), never silently accepted and
 *      never auto-restored (the operator's own concurrent edit may be the one that should win).
 *      Daemon-side writers ARE serialized: squad-manager keys the sync/apply promise chain by the
 *      REAL DIRECTORY (realpath + literal path), so two `here` sessions on one checkout can never
 *      fingerprint/apply concurrently (one daemon per state dir is the standing topology; multiple
 *      daemons on one checkout are out of scope).
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseNulList } from "./adopt.ts";
import { errText } from "./err-text.ts";
import { hardenedGit as rawHardenedGit } from "./git-harden.ts";

/** hardenedGit, but spawn-safe: `Bun.spawn` THROWS synchronously when the cwd no longer exists
 *  (ENOENT), and this module's contract is that every git failure — including "the directory is
 *  gone" — comes back as a non-zero result that fails the capture, never as an exception that
 *  bypasses the fail-closed result plumbing. */
async function hardenedGit(...args: Parameters<typeof rawHardenedGit>): ReturnType<typeof rawHardenedGit> {
	try {
		return await rawHardenedGit(...args);
	} catch (e) {
		return { code: -1, stdout: "", stderr: errText(e) };
	}
}

/** Cap a held patch (DoS parity with adopt's MAX_PATCH_BYTES). */
export const MAX_SYNC_PATCH_BYTES = 64 * 1024 * 1024;

export type CaptureResult = { ok: true; fingerprint: string } | { ok: false; reason: string };
export type TreeResult = { ok: true; tree: string } | { ok: false; reason: string };
export type PatchResult = { ok: true; patch: string } | { ok: false; reason: string };
/** A successful write can still carry a detected divergence (C1) — the git-write itself happened
 *  (there is nothing to retry), but the post-apply check found that one or more patch-touched paths
 *  don't hold what the patch alone should have produced. `ok: false` is reserved for "nothing was
 *  written" (the fail-closed refusals above the write); a divergence is reported ALONGSIDE `ok: true`
 *  because rolling back is not this module's call to make (module doc, window 3). */
export type ApplyResult = { ok: true; divergence?: DivergenceReport } | { ok: false; reason: string };

/** C1 post-apply divergence: the exact paths whose post-write content didn't match what the patch
 *  alone should have produced, plus where the pre-write capture of those paths was retained on disk
 *  for manual recovery (never auto-restored — the operator's own concurrent edit may be the one that
 *  should win). */
export interface DivergenceReport {
	paths: string[];
	captureDir: string;
}

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const gitErr = (what: string, r: { code: number; stderr: string }): string => `${what} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300) || "no stderr"}`;

/**
 * Per-untracked-path identity for the real-tree fingerprint. Regular, readable files are
 * content-hashed via `git hash-object` (unchanged from the original design — a mid-turn edit to an
 * untracked file must move the fingerprint). Everything else is fingerprinted from `lstat`/
 * `readlink` metadata alone, WITHOUT ever opening the path — this is the fix for a real bricking
 * bug: `git hash-object` always FOLLOWS symlinks (opens the referent), so one dangling symlink, a
 * permission-denied file, or a fifo/socket/device in the untracked set made every capture fail
 * forever (exit 128), which wedged both auto-sync and the explicit Apply recovery path (both call
 * this same function). A broken symlink's referent not existing is not "uncertainty" about the
 * CHECKOUT — the symlink's own (mode, size, mtime, target-string) is fully knowable without
 * touching the referent, and is stable across calls when nothing changed, so it can safely stand
 * in for a content hash. Non-regular, non-symlink paths (fifo/socket/device) are fingerprinted the
 * same way — deliberately never opened, since reading a fifo with no writer can hang forever.
 *
 * Fail-closed is preserved for the cases that are genuinely unknowable: if `lstat` itself fails
 * (the path vanished or a parent directory stopped being searchable between `ls-files` and now) or
 * `readlink` fails on something `lstat` just reported as a symlink, that is real uncertainty about
 * the checkout, not merely "can't read this path's bytes" — the whole capture fails, and the
 * failure reason names the offending path so an operator-facing hold message is actionable instead
 * of a dead end.
 *
 * Mixed-mode compare (S1, blind review): each per-path line is tagged by its own prefix
 * (`content:`/`symlink:`/`stat:`) — a path whose READABILITY changes between two captures (e.g. a
 * permission flip, or a regular file replaced by an unreadable one) therefore switches prefixes and
 * the two lines compare textually UNEQUAL by construction, which is folded into the whole-tree sha256
 * `captureRealTreeState` produces, so `now.fingerprint !== start.realFingerprint` catches it exactly
 * like any other divergence (see `tests/boundary-sync.test.ts`'s "readability flip" case). The
 * genuinely accepted residual is narrower: a path that is `stat:`-mode in BOTH captures (readability
 * never changed — permanently unreadable, or a fifo/socket/device) and whose CONTENT changes in place
 * without moving its (mode, size, mtime) — an mtime-preserving in-place rewrite, or two edits that
 * round-trip through the same size within one mtime tick. This is bounded, not open-ended: the only
 * write this module ever performs against such a path is `git apply`, which refuses to write through
 * a symlink and cannot target a fifo/socket/device at all (they are never patch-touchable paths), so
 * the blind spot can never actually enable a silent clobber — at worst a content-swapped unreadable
 * file's own divergence goes undetected, and that file was never going to be written to regardless.
 *
 * @substrate exported for tests only — tests/boundary-sync.test.ts asserts the lstat/readlink
 * fallback directly (including the fail-closed path for a path that no longer exists); its only
 * in-repo caller is `captureRealTreeState`, in this same file.
 */
export async function fingerprintUntracked(realDir: string, untracked: string[]): Promise<{ ok: true; digest: string } | { ok: false; reason: string }> {
	if (untracked.length === 0) return { ok: true, digest: "" };

	const lines = new Array<string | undefined>(untracked.length);
	const regulars: { index: number; path: string; stat: Awaited<ReturnType<typeof fs.lstat>> }[] = [];

	for (let i = 0; i < untracked.length; i++) {
		const p = untracked[i]!;
		const abs = path.join(realDir, p);
		let st: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			st = await fs.lstat(abs);
		} catch (e) {
			return fail(`couldn't establish identity for the untracked path "${p}": ${errText(e)}`);
		}
		if (st.isSymbolicLink()) {
			let target: string;
			try {
				target = await fs.readlink(abs);
			} catch (e) {
				return fail(`couldn't read the untracked symlink "${p}"'s target: ${errText(e)}`);
			}
			// Identity, not content: a dangling target is fully expressible without ever opening it,
			// and comparing stable-equal when unchanged is the whole point of this fix.
			lines[i] = `symlink:${st.mode.toString(8)}:${st.size}:${st.mtimeMs}:${target}`;
		} else if (st.isFile()) {
			regulars.push({ index: i, path: p, stat: st });
		} else {
			// fifo/socket/device (or anything else `ls-files --others` can name) — never opened.
			lines[i] = `stat:${st.mode.toString(8)}:${st.size}:${st.mtimeMs}`;
		}
	}

	if (regulars.length > 0) {
		// `hash-object --stdin-paths` reads newline-separated paths, so a path CONTAINING a newline
		// can't be expressed — fail the capture (fail-closed) rather than hash the wrong file set.
		const withNewline = regulars.find((r) => r.path.includes("\n"));
		if (withNewline) return fail(`untracked path "${withNewline.path}" contains a newline — cannot fingerprint safely`);

		// Fast path: one batched spawn for the common case (no unreadable regular files).
		const batch = await hardenedGit(["hash-object", "--stdin-paths"], { cwd: realDir, stdin: `${regulars.map((r) => r.path).join("\n")}\n` });
		if (batch.code === 0) {
			const hashes = batch.stdout.split("\n").filter((l) => l.length > 0);
			if (hashes.length !== regulars.length) return fail(`git hash-object (untracked content) returned ${hashes.length} hashes for ${regulars.length} paths`);
			for (let j = 0; j < regulars.length; j++) lines[regulars[j]!.index] = `content:${hashes[j]}`;
		} else {
			// Batch mode aborts entirely at the FIRST unreadable path (verified live: it does not
			// continue to hash the remaining paths, so its partial stdout can't be trusted to tell us
			// which one failed) — fall back to one spawn per path, so a single permission-denied or
			// raced-away file degrades only itself instead of failing the whole capture.
			for (const r of regulars) {
				const single = await hardenedGit(["hash-object", "--", r.path], { cwd: realDir });
				if (single.code === 0) {
					lines[r.index] = `content:${single.stdout.trim()}`;
				} else {
					// Unreadable content (permission denied, or it vanished after our lstat above) — fall
					// back to the identity we already captured, exactly like the symlink/special case.
					lines[r.index] = `stat:${r.stat.mode.toString(8)}:${r.stat.size}:${r.stat.mtimeMs}`;
				}
			}
		}
	}

	return { ok: true, digest: lines.join("\n") };
}

/**
 * Read-only tree-state fingerprint of the REAL checkout (fail-closed by construction — see module
 * doc). sha256 over: HEAD sha + tracked diff vs HEAD (`--binary`, textconv/ext-diff neutralized) +
 * untracked path list + a per-path identity for each untracked entry (content hash for readable
 * regular files, lstat/readlink identity for everything else — see `fingerprintUntracked`). The
 * content hashes go beyond the concern's three-command sketch deliberately: path-only hashing would
 * let a mid-turn edit to an untracked file slip past the divergence check and be clobbered by the
 * apply's own file writes. Any sub-command failing fails the whole capture — never an empty or
 * partial fingerprint.
 *
 * @substrate exported for tests only — tests/boundary-sync.test.ts asserts this fingerprint
 * primitive directly; every other in-repo caller (`beginTurn`, `syncTurnEnd`, `applyHeldNow`,
 * `applyPatchToRealTree`) is a sibling function in this same file.
 */
export async function captureRealTreeState(realDir: string): Promise<CaptureResult> {
	const head = await hardenedGit(["rev-parse", "HEAD"], { cwd: realDir });
	if (head.code !== 0) return fail(gitErr("git rev-parse HEAD", head));
	const diff = await hardenedGit(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"], { cwd: realDir });
	if (diff.code !== 0) return fail(gitErr("git diff", diff));
	const others = await hardenedGit(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: realDir });
	if (others.code !== 0) return fail(gitErr("git ls-files", others));
	const untracked = parseNulList(others.stdout);
	const untrackedFp = await fingerprintUntracked(realDir, untracked);
	if (!untrackedFp.ok) return fail(untrackedFp.reason);
	const fingerprint = createHash("sha256")
		.update(head.stdout)
		.update("\0")
		.update(diff.stdout)
		.update("\0")
		.update(others.stdout)
		.update("\0")
		.update(untrackedFp.digest)
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
		return fail(`temp index dir: ${errText(e)}`);
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

/** The turn's own delta: diff(startTree, endTree), binary-safe, driver-neutralized.
 *
 * @substrate exported for tests only — tests/boundary-sync.test.ts asserts this diff primitive
 * directly; its only in-repo caller is `syncTurnEnd`, in this same file. */
export async function computeTurnPatch(worktree: string, startTree: string, endTree: string): Promise<PatchResult> {
	if (startTree === endTree) return { ok: true, patch: "" };
	// N1: `-c core.quotepath=false` — a repo whose config leaves `core.quotepath` at its git DEFAULT
	// (true) makes this diff C-quote any non-ASCII path into an escaped literal (`"a/na\303\257ve.txt"`)
	// in BOTH the `diff --git` header and the `---`/`+++` lines. `git apply` accepts raw UTF-8 headers
	// fine (verified live), so nothing downstream needs the quoting — but `patchTouchedPaths` reading
	// the escaped literal as if it were the real filename made every C1 post-apply check lstat a path
	// that doesn't exist ("absent"), which can never compare equal to the real post-write file, which
	// raised a CRITICAL "may have been clobbered" divergence row on every legitimate turn touching a
	// pre-existing accented/CJK-named file (live-proven: `error: naïve.txt: No such file or
	// directory`). This is the patch-PRODUCING diff — the one call site whose output both `git apply`
	// and `patchTouchedPaths` consume — so disabling quoting here is the root fix; `patchTouchedPaths`
	// still carries an unquote fallback (defense in depth) for any header that arrives quoted anyway
	// (a caller-supplied patch from a differently-configured git, or a future call site).
	const diff = await hardenedGit(["-c", "core.quotepath=false", "diff-tree", "-r", "-p", "--binary", "--no-ext-diff", "--no-textconv", startTree, endTree], { cwd: worktree });
	if (diff.code !== 0) return fail(gitErr("git diff-tree", diff));
	return { ok: true, patch: diff.stdout };
}

/** Default durable home for C1 divergence captures when a caller doesn't have a more specific
 *  (state-dir-scoped) place to put them — the direct-primitive test callers and any future caller
 *  that skips the `divergenceDir` option. Production callers (`syncTurnEnd`, `applyHeldNow`) always
 *  pass `HeldSyncStore`'s own durable dir, so captures live beside the held patches they relate to. */
const DEFAULT_DIVERGENCE_ROOT = path.join(os.tmpdir(), "glance-bsync-divergence");

/** Reverse git's C-style path quoting (`quote_path()` in git's own `quote.c`): a field that arrives
 *  wrapped in double quotes is octal/backslash-escaped ASCII text (`"na\303\257ve.txt"`), never raw
 *  bytes — safe to walk char-by-char. An unquoted field (the common case once `computeTurnPatch`
 *  passes `-c core.quotepath=false`) passes through untouched. Defense in depth for `patchTouchedPaths`
 *  (N1): a patch that arrives already C-quoted — a differently-configured git, or a future call site
 *  that doesn't disable quotepath — must still resolve to the REAL on-disk path, never the escaped
 *  literal (which `snapshotPaths`/`git apply` would treat as a distinct, nonexistent path). */
function unquoteGitPath(field: string): string {
	if (!(field.length >= 2 && field.startsWith('"') && field.endsWith('"'))) return field;
	const inner = field.slice(1, -1);
	const bytes: number[] = [];
	const simple: Record<string, number> = { "\\": 0x5c, '"': 0x22, n: 0x0a, t: 0x09, a: 0x07, b: 0x08, f: 0x0c, r: 0x0d, v: 0x0b };
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i]!;
		if (c !== "\\") {
			bytes.push(c.charCodeAt(0));
			continue;
		}
		const next = inner[i + 1];
		if (next === undefined) {
			bytes.push(0x5c);
			continue;
		}
		if (next >= "0" && next <= "7") {
			const oct = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0]!;
			bytes.push(Number.parseInt(oct, 8) & 0xff);
			i += oct.length;
			continue;
		}
		if (next in simple) {
			bytes.push(simple[next]!);
			i += 1;
			continue;
		}
		// Unknown escape — keep both characters literally rather than guess at intent.
		bytes.push(0x5c, next.charCodeAt(0));
		i += 1;
	}
	return Buffer.from(bytes).toString("utf8");
}

/** One diff-header path field ("a/foo", "b/foo", a quoted variant, or "/dev/null"), with its
 *  known-fixed `a/`/`b/` prefix stripped and any C-quoting reversed. `undefined` for `/dev/null`
 *  (an add/delete's absent side — never a real touched path). */
function unquoteDiffField(field: string, prefix: "a/" | "b/"): string | undefined {
	if (field === "/dev/null") return undefined;
	const unquoted = unquoteGitPath(field);
	return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

/** Best-effort split of a `diff --git a/X b/Y` header line (prefix "diff --git " already stripped)
 *  when no unambiguous `---`/`+++`/`rename` line is available (N1's rarer case — see caller). This
 *  module's own `computeTurnPatch` never requests rename detection (`-M`/`-C`), so X and Y are always
 *  IDENTICAL for every header this module ever produces; a naive single-regex split is genuinely
 *  ambiguous whenever the path itself contains the literal substring " b/" (e.g. `diff --git a/x b/y
 *  b/x b/y` — reluctant matching finds the FIRST " b/" instead of the true boundary). Exploiting the
 *  old==new invariant here: try every " b/" split point and take the one where both halves agree;
 *  fall back to the first split (historical behavior) only if nothing agrees (a header from some
 *  other caller that genuinely renamed). */
function splitDiffGitHeader(rest: string): [string, string] | undefined {
	if (rest.startsWith('"')) {
		const m = rest.match(/^("(?:\\.|[^"\\])*")\s("(?:\\.|[^"\\])*")$/);
		if (!m) return undefined;
		return [unquoteDiffField(m[1]!, "a/") ?? "", unquoteDiffField(m[2]!, "b/") ?? ""];
	}
	if (!rest.startsWith("a/")) return undefined;
	const body = rest.slice(2);
	let idx = body.indexOf(" b/");
	let fallback: [string, string] | undefined;
	while (idx !== -1) {
		const left = body.slice(0, idx);
		const right = body.slice(idx + 3);
		if (fallback === undefined) fallback = [left, right];
		if (left === right) return [left, right];
		idx = body.indexOf(" b/", idx + 1);
	}
	return fallback;
}

/** The set of paths a unified diff (as produced by `git diff-tree -p`/`git diff`, default a/ b/
 *  prefixes) could possibly have written — both sides of every `diff --git a/X b/Y` header (a
 *  rename's old AND new path; an add/delete's one real side, the other is `/dev/null` and therefore
 *  absent from this header form already). Used only to scope the C1 post-apply divergence check to
 *  paths this patch could have touched — nothing else needs snapshotting or verifying.
 *
 * N1: prefers the unambiguous per-line forms that follow each `diff --git` header (`--- a/X`,
 * `+++ b/Y`, `rename from`/`rename to` — each names exactly one path with no twin-prefix split
 * ambiguity) over the header line itself, and reverses C-quoting on whichever source is used. The
 * header line alone is used only as a fallback for a block with none of those lines (a pure binary
 * patch — `GIT binary patch` carries no `---`/`+++` text — or a bare mode-change), via
 * `splitDiffGitHeader`'s old==new-exploiting split. */
export function patchTouchedPaths(patch: string): string[] {
	const paths = new Set<string>();
	const lines = patch.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.startsWith("diff --git ")) continue;
		let sawLine = false;
		for (let j = i + 1; j < lines.length && !lines[j]!.startsWith("diff --git "); j++) {
			const l = lines[j]!;
			let m: RegExpMatchArray | null;
			if ((m = l.match(/^--- (.+?)(?:\t.*)?$/))) {
				const p = unquoteDiffField(m[1]!, "a/");
				if (p !== undefined) paths.add(p);
				sawLine = true;
			} else if ((m = l.match(/^\+\+\+ (.+?)(?:\t.*)?$/))) {
				const p = unquoteDiffField(m[1]!, "b/");
				if (p !== undefined) paths.add(p);
				sawLine = true;
			} else if ((m = l.match(/^rename from (.+)$/))) {
				paths.add(unquoteGitPath(m[1]!));
				sawLine = true;
			} else if ((m = l.match(/^rename to (.+)$/))) {
				paths.add(unquoteGitPath(m[1]!));
				sawLine = true;
			}
		}
		if (!sawLine) {
			const split = splitDiffGitHeader(line.slice("diff --git ".length));
			if (split) {
				paths.add(split[0]);
				paths.add(split[1]);
			}
		}
	}
	return [...paths];
}

/** A path's real-tree identity for the C1 pre/post comparison — deliberately the same three shapes
 *  `fingerprintUntracked` already distinguishes (file/symlink/absent), plus "unreadable" for anything
 *  else (permission denied, or a non-regular non-symlink path) so a capture failure never silently
 *  reads as "equal to whatever came after". */
type PathSnapshot = { kind: "file"; content: Buffer } | { kind: "symlink"; target: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

async function snapshotPaths(dir: string, paths: string[]): Promise<Map<string, PathSnapshot>> {
	const out = new Map<string, PathSnapshot>();
	for (const p of paths) {
		const abs = path.join(dir, p);
		try {
			const st = await fs.lstat(abs);
			if (st.isSymbolicLink()) out.set(p, { kind: "symlink", target: await fs.readlink(abs) });
			else if (st.isFile()) out.set(p, { kind: "file", content: await fs.readFile(abs) });
			else out.set(p, { kind: "unreadable", reason: "not a regular file or symlink" });
		} catch (e) {
			if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") out.set(p, { kind: "absent" });
			else out.set(p, { kind: "unreadable", reason: errText(e) });
		}
	}
	return out;
}

/** Never true for a pair involving "unreadable" — an inconclusive capture must never compare equal
 *  to anything (the same fail-closed rule `fingerprintUntracked`'s failures follow). */
function snapshotsEqual(a: PathSnapshot | undefined, b: PathSnapshot | undefined): boolean {
	if (!a || !b || a.kind !== b.kind) return false;
	if (a.kind === "file" && b.kind === "file") return a.content.equals(b.content);
	if (a.kind === "symlink" && b.kind === "symlink") return a.target === b.target;
	return a.kind === "absent" && b.kind === "absent";
}

/** What the patch ALONE should have produced, computed by replaying it (via a second, throwaway
 *  `git apply`) against the pre-write snapshot in an empty scratch directory — `git apply` works fine
 *  outside of a git repository entirely (verified live), so this needs no `.git` and cannot be
 *  affected by anything happening in the real checkout concurrently. Deterministic: same patch, same
 *  starting bytes, same result, every time. */
async function expectedPostApply(patch: string, pre: Map<string, PathSnapshot>): Promise<Map<string, PathSnapshot> | { failed: string }> {
	let tmpDir: string;
	try {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glance-bsync-expect-"));
	} catch (e) {
		return { failed: `scratch dir: ${errText(e)}` };
	}
	try {
		for (const [p, snap] of pre) {
			const abs = path.join(tmpDir, p);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			if (snap.kind === "file") await fs.writeFile(abs, snap.content);
			else if (snap.kind === "symlink") await fs.symlink(snap.target, abs).catch(() => {});
			// "absent" (the patch creates it) and "unreadable" (can't seed it) are left missing —
			// git apply either creates the file itself (absent) or the comparison degrades honestly
			// (an "unreadable" pre-capture can never produce an "equal" verdict either side).
		}
		const patchFile = path.join(tmpDir, ".glance-expected.patch");
		await fs.writeFile(patchFile, patch);
		const applied = await hardenedGit(["apply", "--whitespace=nowarn", patchFile], { cwd: tmpDir });
		if (applied.code !== 0) return { failed: gitErr("expected-output git apply", applied) };
		return await snapshotPaths(tmpDir, [...pre.keys()]);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Persist the pre-write capture for the paths a divergence was found in — retained on disk so a
 *  human can recover by hand (naming this exact directory in the attention message); never used to
 *  auto-restore. Best-effort per file: one unwritable entry doesn't cost the others. */
async function retainDivergenceCapture(root: string, pre: Map<string, PathSnapshot>, affected: string[]): Promise<string> {
	const dir = path.join(root, `divergence-${randomUUID()}`);
	await fs.mkdir(dir, { recursive: true });
	for (const p of affected) {
		const snap = pre.get(p);
		if (!snap) continue;
		const safeName = p.replace(/[/\\]/g, "__");
		try {
			if (snap.kind === "file") await fs.writeFile(path.join(dir, safeName), snap.content);
			else if (snap.kind === "symlink") await fs.writeFile(path.join(dir, `${safeName}.symlink-target`), snap.target);
			else if (snap.kind === "absent") await fs.writeFile(path.join(dir, `${safeName}.did-not-exist-pre-write`), "");
			else await fs.writeFile(path.join(dir, `${safeName}.unreadable`), snap.reason);
		} catch {
			// Best-effort retention — a failed write here must never mask the divergence report itself.
		}
	}
	return dir;
}

/** The C1 detect half: given the pre-write snapshot of every patch-touched path and the patch itself,
 *  read the SAME paths from the real tree (now, post-write) and compare each against what the patch
 *  alone should have produced. Returns undefined when everything matches (the common case, zero extra
 *  disk writes). A patch touching nothing (pure mode changes, empty diff) skips the check entirely —
 *  nothing to verify. */
async function detectPostApplyDivergence(realDir: string, patch: string, touched: string[], pre: Map<string, PathSnapshot>, divergenceRoot: string): Promise<DivergenceReport | undefined> {
	if (touched.length === 0) return undefined;
	const expected = await expectedPostApply(patch, pre);
	if ("failed" in expected) {
		// Couldn't even compute what "correct" looks like — that is itself something to surface rather
		// than silently trust the write, naming every touched path since none could be verified.
		return { paths: touched, captureDir: await retainDivergenceCapture(divergenceRoot, pre, touched) };
	}
	const actual = await snapshotPaths(realDir, touched);
	const bad = touched.filter((p) => !snapshotsEqual(expected.get(p), actual.get(p)));
	if (bad.length === 0) return undefined;
	return { paths: bad, captureDir: await retainDivergenceCapture(divergenceRoot, pre, bad) };
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
 * with nothing written; only the final `git apply` spawn itself remains exposed (window 3) — and
 * that window is now DETECTED, not silent (C1): immediately before the write, every patch-touched
 * path's real-tree content is snapshotted; after a successful `git apply`, that snapshot is replayed
 * against the patch in a scratch dir to compute what should be there, and the real tree is compared
 * against it. A mismatch comes back as `ApplyResult.divergence` — `ok` stays `true` (the write did
 * happen; there is nothing to retry) but callers must surface it loudly and never auto-restore.
 *
 * @substrate exported for tests only — tests/boundary-sync.test.ts asserts this apply primitive
 * directly (including the race-window recheck); its only in-repo callers are `syncTurnEnd` and
 * `applyHeldNow`, both in this same file.
 */
export async function applyPatchToRealTree(
	realDir: string,
	patch: string,
	expectedFingerprint?: string,
	opts?: {
		/** Durable dir a detected divergence's pre-write capture is retained under. Defaults to a
		 *  shared tmp location — production callers always pass `HeldSyncStore.root`-derived path so
		 *  a rare divergence lands beside the held patches it's related to. */
		divergenceDir?: string;
		/** Test-only seam (C1 regression test): fires after the pre-write snapshot is captured but
		 *  before the real `git apply` write, so a test can mutate a patch-touched path in that exact
		 *  window to simulate the residual race deterministically. */
		testHookAfterSnapshot?: () => Promise<void>;
	},
): Promise<ApplyResult> {
	if (patch.trim().length === 0) return { ok: true };
	let tmpDir: string;
	try {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glance-bsync-apply-"));
	} catch (e) {
		return fail(`temp patch dir: ${errText(e)}`);
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
		// C1: snapshot the real-tree side of every patch-touched path immediately before the write —
		// the recheck above proves stability at CAPTURE time, not through the `git apply` spawn itself.
		const touched = patchTouchedPaths(patch);
		const preSnapshot = await snapshotPaths(realDir, touched);
		if (opts?.testHookAfterSnapshot) await opts.testHookAfterSnapshot();
		const applied = await hardenedGit(["apply", "--whitespace=nowarn", patchFile], { cwd: realDir });
		if (applied.code !== 0) return fail(gitErr("git apply", applied));
		const divergence = await detectPostApplyDivergence(realDir, patch, touched, preSnapshot, opts?.divergenceDir ?? DEFAULT_DIVERGENCE_ROOT);
		return divergence ? { ok: true, divergence } : { ok: true };
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
	| { kind: "applied"; endTree: string; patchBytes: number; divergence?: DivergenceReport }
	/** `held` is undefined (never a HeldSync) exactly when the ledger-append half of the hold itself
	 *  failed but the patch body was still written to `patchFile` (S6) — recoverable by hand or by the
	 *  next boot sweep once the ledger heals, never "nothing is held". */
	| { kind: "held"; endTree?: string; reason: string; held?: HeldSync; patchFile?: string }
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

	// S6: once we're here, the patch is KNOWN GOOD — computed, non-empty, ready to hold. `hold` is the
	// one place this function ever gives up on auto-applying; it must never come back empty-handed.
	// `HeldSyncStore.hold` writes the patch body BEFORE the ledger line, and distinguishes the two
	// failure modes with typed errors so this can react correctly to each (see the store's own doc).
	const hold = async (reason: string): Promise<SyncOutcome> => {
		try {
			const held = await store.hold({ agentId, turn, realDir, reason, patch: patch.patch });
			return { kind: "held", endTree: end.tree, reason, held };
		} catch (err) {
			if (err instanceof HeldLedgerAppendError) {
				// The patch body IS durably on disk — only the ledger bookkeeping failed. Never say
				// "nothing is held" about a patch that demonstrably exists; name the file.
				return { kind: "held", endTree: end.tree, reason: `${reason} — and recording the hold failed: ${err.message}`, patchFile: err.patchFile };
			}
			// The patch body itself couldn't be written — genuinely nothing durable exists. Same
			// fail-closed direction as before (real tree untouched), with the real cause folded in.
			return { kind: "uncapturable", reason: `couldn't hold this turn's patch: ${errText(err)}` };
		}
	};

	try {
		// 2. Ordering: anything already held means this patch may depend on unapplied hunks — hold it
		//    behind the backlog rather than auto-applying out of order.
		const backlog = await store.listHeld(agentId);
		if (backlog.length > 0) return await hold(`${backlog.length} earlier turn(s) are already held — applying in order needs your go-ahead`);

		// 3. The precondition. A capture failure at either end is the SAME code path as a genuine
		//    divergence: hold + attention, never an apply.
		if (!start.realFingerprint) return await hold(`couldn't fingerprint your checkout at turn start: ${start.realFailure ?? "unknown"}`);
		const now = await captureRealTreeState(realDir);
		if (!now.ok) return await hold(`couldn't re-fingerprint your checkout at turn end: ${now.reason}`);
		if (now.fingerprint !== start.realFingerprint) return await hold("your checkout changed during this turn");

		// 4. Unchanged and provably so — apply, with one last-instant re-fingerprint inside the apply
		//    (after `--check`, before the write) so an operator edit in the fingerprint→apply window
		//    fails the apply into a hold instead of being written into (module doc, race window 2).
		//    A conflicting patch (e.g. the real tree carried uncommitted WIP in the same files since
		//    before the session) still aborts atomically. `divergenceDir` lands beside this session's
		//    held patches so a rare post-apply divergence (C1) is retained somewhere discoverable.
		const applied = await applyPatchToRealTree(realDir, patch.patch, now.fingerprint, { divergenceDir: path.join(store.root, "divergence") });
		if (!applied.ok) return await hold(`the turn's patch did not apply cleanly: ${applied.reason}`);
		return { kind: "applied", endTree: end.tree, patchBytes: patch.patch.length, divergence: applied.divergence };
	} catch (err) {
		// Anything above threw instead of returning its own fail-closed result (e.g. `listHeld` hitting
		// an unreadable ledger) — the fail-closed DIRECTION still holds (nothing was written to the real
		// tree), but the patch itself must not evaporate with the exception: hold it explicitly (S6)
		// rather than letting a bookkeeping hiccup cost the turn's actual edits.
		return await hold(`sync bookkeeping failed: ${errText(err)}`);
	}
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

type LedgerLine =
	| ({ kind: "held" } & HeldSync)
	| { kind: "resolved"; id: string; outcome: "applied" | "discarded"; at: number }
	/** C2 reattach re-key: a hold's `agentId` changes onto a successor session WITHOUT touching the
	 *  original "held" line or its patch body/file — the id (and therefore recoverability) stays
	 *  identical, only which live agent the store lists it under changes. Append-only, same as every
	 *  other ledger event. */
	| { kind: "rekeyed"; id: string; newAgentId: string; at: number };

/** Structural narrow for a parsed ledger line — no parse-and-cast (json-parse-as-cast ratchet;
 *  NB the ratchet is a pure line-regex with no comment skip, so don't quote the idiom here
 *  either). The ledger is our own freshly-written state (`appendLine` only ever writes
 *  `satisfies LedgerLine` objects), so a discriminant + used-field check is the right depth: it
 *  rejects a foreign or hand-mangled line instead of folding it into the backlog, without pulling
 *  a Schema decode into a hot per-line loop. */
function isLedgerLine(v: unknown): v is LedgerLine {
	if (typeof v !== "object" || v === null || !("kind" in v) || !("id" in v) || typeof v.id !== "string") return false;
	if (v.kind === "resolved") return true;
	if (v.kind === "rekeyed") return "newAgentId" in v && typeof v.newAgentId === "string";
	if (v.kind !== "held") return false;
	return (
		"agentId" in v &&
		typeof v.agentId === "string" &&
		"patchFile" in v &&
		typeof v.patchFile === "string" &&
		"realDir" in v &&
		typeof v.realDir === "string"
	);
}

/** S6: the patch body itself couldn't even be written — genuinely nothing durable exists anywhere. */
export class HeldPatchWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HeldPatchWriteError";
	}
}

/** S6: the patch body WAS written successfully (see `patchFile`) but appending the ledger line that
 *  would track it failed — recoverable (by hand, pointed at `patchFile`; or by the next boot sweep
 *  once the ledger heals), never "uncapturable". */
export class HeldLedgerAppendError extends Error {
	constructor(
		message: string,
		public readonly patchFile: string,
		public readonly id: string,
	) {
		super(message);
		this.name = "HeldLedgerAppendError";
	}
}

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

	/** Patch body FIRST, ledger line second — a ledger entry must never point at a missing body, and
	 *  the two failure modes are distinguished (S6) so a caller can tell "nothing durable exists"
	 *  (`HeldPatchWriteError`) from "the patch IS on disk, only its ledger tracking failed"
	 *  (`HeldLedgerAppendError`, which names the exact file). */
	async hold(e: { agentId: string; turn: number; realDir: string; reason: string; patch: string }): Promise<HeldSync> {
		if (e.patch.length > MAX_SYNC_PATCH_BYTES) throw new Error(`held patch too large (${e.patch.length} bytes)`);
		await fs.mkdir(this.dir, { recursive: true });
		const id = randomUUID();
		const patchFile = path.join(this.dir, `${id}.patch`);
		try {
			await fs.writeFile(patchFile, e.patch);
		} catch (err) {
			throw new HeldPatchWriteError(`couldn't write the held patch body: ${errText(err)}`);
		}
		const held: HeldSync = { id, agentId: e.agentId, turn: e.turn, realDir: e.realDir, reason: e.reason, patchFile, patchBytes: e.patch.length, createdAt: Date.now() };
		try {
			await this.appendLine(JSON.stringify({ kind: "held", ...held } satisfies LedgerLine));
		} catch (err) {
			throw new HeldLedgerAppendError(`the patch is saved at ${patchFile} but recording it in the ledger failed: ${errText(err)}`, patchFile, id);
		}
		return held;
	}

	/** C2: re-key a held patch onto a NEW agent id — the recovery half of a `here` session's restart
	 *  reattach. ACP sessions are non-resumable, so a reattach always mints a fresh agent id, and a
	 *  hold keyed by the dead predecessor's id would otherwise be permanently unreachable (no live
	 *  agent ever lists it again). Append-only, mirroring `resolve`: a "rekeyed" marker, applied by
	 *  `listAllHeld`'s replay, which never mutates the original "held" line or its patch file — the id
	 *  (and therefore the patch body) stays identical, only which agent it's listed under changes. */
	async rekey(id: string, newAgentId: string): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true });
		await this.appendLine(JSON.stringify({ kind: "rekeyed", id, newAgentId, at: Date.now() } satisfies LedgerLine));
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
			throw new Error(`held-sync ledger unreadable (${this.ledger}): ${errText(e)}`);
		}
		const held = new Map<string, HeldSync>();
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // a torn tail line (crash mid-append) — ignore; complete lines are one-per-write
			}
			if (!isLedgerLine(parsed)) continue; // foreign/mangled line — never fold it into the backlog
			if (parsed.kind === "held") held.set(parsed.id, parsed);
			else if (parsed.kind === "resolved") held.delete(parsed.id);
			else {
				// "rekeyed" — only meaningful for a hold that's still open; a rekey line for an already
				// resolved/unknown id is a no-op replay artifact, never fabricates a hold from nothing.
				const cur = held.get(parsed.id);
				if (cur) held.set(parsed.id, { ...cur, agentId: parsed.newAgentId });
			}
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
	/** C1: any patch in this replay whose post-apply content didn't match what it alone should have
	 *  produced — the write still happened (nothing to retry), but each entry needs its own loud,
	 *  never-auto-restored surfacing. Absent/empty when nothing diverged (the common case). */
	divergences?: { turn: number; paths: string[]; captureDir: string }[];
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
	const divergences: { turn: number; paths: string[]; captureDir: string }[] = [];
	for (const h of held) {
		const patch = await fs.readFile(h.patchFile, "utf8").catch(() => undefined);
		if (patch === undefined) {
			return { ok: false, applied, remaining: held.length - applied, reason: `held patch body is missing (${path.basename(h.patchFile)}) — inspect ${store.root}` };
		}
		const res = await applyPatchToRealTree(realDir, patch, pin, { divergenceDir: path.join(store.root, "divergence") });
		if (!res.ok) return { ok: false, applied, remaining: held.length - applied, reason: `turn ${h.turn} is still divergent: ${res.reason}` };
		if (res.divergence) divergences.push({ turn: h.turn, paths: res.divergence.paths, captureDir: res.divergence.captureDir });
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
				reason: `turn ${h.turn} WAS applied but recording that failed (${errText(e)}) — a re-apply will report it still divergent (crash semantics); inspect ${store.root}`,
				divergences: divergences.length > 0 ? divergences : undefined,
			};
		}
		// Re-pin for the next patch: each apply legitimately changes the tree, so the next write is
		// gated on the state THIS apply produced — a third-party edit between patches breaks the pin.
		if (applied < held.length) {
			const next = await captureRealTreeState(realDir);
			if (!next.ok) return { ok: false, applied, remaining: held.length - applied, reason: `couldn't re-verify your checkout after turn ${h.turn}: ${next.reason}`, divergences: divergences.length > 0 ? divergences : undefined };
			pin = next.fingerprint;
		}
	}
	return { ok: true, applied, remaining: 0, divergences: divergences.length > 0 ? divergences : undefined };
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
			return { ok: false, discarded, remaining: held.length - discarded, reason: `recording the discard failed (${errText(e)}) — inspect ${store.root}` };
		}
		discarded++;
	}
	return { ok: true, discarded, remaining: held.length - discarded };
}
