/**
 * Boundary sync (daily-onramp 03) — one-directional per-turn patch-apply into the operator's real
 * checkout, exercised against REAL git repos (no mocked git): the module under test is a git-write
 * path against the operator's checkout, so a green run here must mean real `git apply` semantics.
 *
 * The named fail-closed acceptance tests (00-meta.md's "four fail-open instances" note — a spec
 * violation if missing) live in the "fail-closed acceptance" describe block: a fingerprint capture
 * FAILURE at either end of a turn must hold + raise, never apply, and never touch the real tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	applyHeldNow,
	applyPatchToRealTree,
	beginTurn,
	captureRealTreeState,
	captureWorktreeTree,
	computeTurnPatch,
	discardHeldNow,
	fingerprintUntracked,
	HeldLedgerAppendError,
	HeldSyncStore,
	patchTouchedPaths,
	pruneDivergenceCaptures,
	syncTurnEnd,
} from "../src/boundary-sync.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`git ${a.join(" ")} failed (${code}): ${stderr}`);
	return { code, stdout, stderr };
}

async function initRepo(): Promise<string> {
	const repo = await tmpDir("bsync-real-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
	await fs.writeFile(path.join(repo, "b.txt"), "b\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

/** Mirror of the here-flow shape: the agent runs in a standard git worktree of the real repo. */
async function addWorktree(repo: string): Promise<string> {
	const parent = await tmpDir("bsync-wt-");
	const worktree = path.join(parent, "wt");
	await git(repo, "worktree", "add", "-q", "-b", "squad/bsync-test", worktree, "HEAD");
	return worktree;
}

async function newStore(): Promise<HeldSyncStore> {
	return new HeldSyncStore(await tmpDir("bsync-store-"));
}

/** A byte-level snapshot of a directory's FILES (paths + contents), .git excluded — for asserting
 *  the real tree was not touched at all, stronger than "the fingerprint still matches". */
async function fileSnapshot(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const walk = async (rel: string): Promise<void> => {
		for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
			if (e.name === ".git") continue;
			const r = path.join(rel, e.name);
			if (e.isDirectory()) await walk(r);
			else out.set(r, await fs.readFile(path.join(dir, r), "utf8"));
		}
	};
	await walk("");
	return out;
}

// ── fingerprint (read-only, fail-closed by construction) ─────────────────────────────────────────

describe("captureRealTreeState", () => {
	test("deterministic for identical tree state", async () => {
		const repo = await initRepo();
		const a = await captureRealTreeState(repo);
		const b = await captureRealTreeState(repo);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.fingerprint).toBe(b.fingerprint);
	});

	test("changes when tracked content changes, and again when it reverts (content-derived, not time-derived)", async () => {
		const repo = await initRepo();
		const before = await captureRealTreeState(repo);
		await fs.appendFile(path.join(repo, "a.txt"), "four\n");
		const after = await captureRealTreeState(repo);
		expect(before.ok && after.ok).toBe(true);
		if (before.ok && after.ok) expect(after.fingerprint).not.toBe(before.fingerprint);
		await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
		const reverted = await captureRealTreeState(repo);
		if (before.ok && reverted.ok) expect(reverted.fingerprint).toBe(before.fingerprint);
	});

	test("changes when an untracked file appears", async () => {
		const repo = await initRepo();
		const before = await captureRealTreeState(repo);
		await fs.writeFile(path.join(repo, "new.txt"), "hi\n");
		const after = await captureRealTreeState(repo);
		expect(before.ok && after.ok).toBe(true);
		if (before.ok && after.ok) expect(after.fingerprint).not.toBe(before.fingerprint);
	});

	test("changes when an untracked file's CONTENT changes (path list alone would miss this)", async () => {
		const repo = await initRepo();
		await fs.writeFile(path.join(repo, "new.txt"), "v1\n");
		const before = await captureRealTreeState(repo);
		await fs.writeFile(path.join(repo, "new.txt"), "v2\n");
		const after = await captureRealTreeState(repo);
		expect(before.ok && after.ok).toBe(true);
		if (before.ok && after.ok) expect(after.fingerprint).not.toBe(before.fingerprint);
	});

	test("FAILS (never an empty fingerprint) on a non-repo directory", async () => {
		const dir = await tmpDir("bsync-notrepo-");
		const r = await captureRealTreeState(dir);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("rev-parse");
	});

	test("FAILS on a directory that no longer exists", async () => {
		const dir = await tmpDir("bsync-gone-");
		await fs.rm(dir, { recursive: true, force: true });
		const r = await captureRealTreeState(dir);
		expect(r.ok).toBe(false);
	});

	test("FAILS when an untracked path contains a newline (cannot be fed to hash-object safely)", async () => {
		const repo = await initRepo();
		await fs.writeFile(path.join(repo, "evil\nname.txt"), "x\n");
		const r = await captureRealTreeState(repo);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("newline");
	});

	test("a dangling (broken-target) untracked symlink does NOT fail the capture, and is stable when unchanged (regression: git hash-object always follows symlinks and exits 128 on a missing referent, which used to brick every capture forever)", async () => {
		const repo = await initRepo();
		await fs.symlink("/no/such/target", path.join(repo, "dangling-link"));
		const a = await captureRealTreeState(repo);
		const b = await captureRealTreeState(repo);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.fingerprint).toBe(b.fingerprint);
	});

	test("changes when a dangling symlink's TARGET STRING changes, even though it stays unreadable both times", async () => {
		const repo = await initRepo();
		const link = path.join(repo, "dangling-link");
		await fs.symlink("/no/such/target-v1", link);
		const before = await captureRealTreeState(repo);
		expect(before.ok).toBe(true);
		await fs.rm(link);
		await fs.symlink("/no/such/target-v2", link);
		const after = await captureRealTreeState(repo);
		expect(after.ok).toBe(true);
		if (before.ok && after.ok) expect(after.fingerprint).not.toBe(before.fingerprint);
	});

	test("an untracked regular file that cannot be opened (permission denied) does NOT fail the capture, and is stable when unchanged", async () => {
		if (process.getuid?.() === 0) return; // root reads through 0o000 — nothing to assert
		const repo = await initRepo();
		const locked = path.join(repo, "locked.txt");
		await fs.writeFile(locked, "secret\n");
		await fs.chmod(locked, 0o000);
		try {
			const a = await captureRealTreeState(repo);
			const b = await captureRealTreeState(repo);
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(true);
			if (a.ok && b.ok) expect(a.fingerprint).toBe(b.fingerprint);
		} finally {
			await fs.chmod(locked, 0o644); // afterEach's rm needs to read the directory clean
		}
	});

	test("is read-only: capture does not disturb git status or the index", async () => {
		const repo = await initRepo();
		await fs.appendFile(path.join(repo, "a.txt"), "dirty\n");
		await fs.writeFile(path.join(repo, "untracked.txt"), "u\n");
		const statusBefore = (await git(repo, "status", "--porcelain")).stdout;
		const r = await captureRealTreeState(repo);
		expect(r.ok).toBe(true);
		expect((await git(repo, "status", "--porcelain")).stdout).toBe(statusBefore);
	});
});

describe("fingerprintUntracked (the per-path fallback the capture-bricking bug lived in)", () => {
	test("a path lstat genuinely cannot resolve fails closed, naming the offending path (no dead-end 'couldn't fingerprint')", async () => {
		const repo = await initRepo();
		// "ghost.txt" is never created — ls-files would never report it, but this isolates the
		// lstat-failure branch deterministically (no race needed): the path is unconditionally gone.
		const r = await fingerprintUntracked(repo, ["ghost.txt"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("ghost.txt");
	});
});

// ── worktree tree snapshot + per-turn patch ───────────────────────────────────────────────────────

describe("captureWorktreeTree / computeTurnPatch", () => {
	test("stable for unchanged tree; changes with tracked and untracked edits; worktree index untouched", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const statusBefore = (await git(wt, "status", "--porcelain")).stdout;
		const t1 = await captureWorktreeTree(wt);
		const t2 = await captureWorktreeTree(wt);
		expect(t1.ok && t2.ok).toBe(true);
		if (t1.ok && t2.ok) expect(t1.tree).toBe(t2.tree);
		await fs.writeFile(path.join(wt, "fresh.txt"), "untracked\n");
		const t3 = await captureWorktreeTree(wt);
		if (t1.ok && t3.ok) expect(t3.tree).not.toBe(t1.tree);
		// The snapshot staged NOTHING in the worktree's real index (fresh.txt still shows untracked).
		expect((await git(wt, "status", "--porcelain")).stdout).toBe(`${statusBefore}?? fresh.txt\n`);
	});

	test("turn patch is exactly the start→end delta, applies cleanly, and includes new files", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const start = await captureWorktreeTree(wt);
		await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
		await fs.writeFile(path.join(wt, "created.txt"), "brand new\n");
		const end = await captureWorktreeTree(wt);
		expect(start.ok && end.ok).toBe(true);
		if (!start.ok || !end.ok) return;
		const patch = await computeTurnPatch(wt, start.tree, end.tree);
		expect(patch.ok).toBe(true);
		if (!patch.ok) return;
		expect(patch.patch).toContain("a.txt");
		expect(patch.patch).toContain("created.txt");
		const applied = await applyPatchToRealTree(repo, patch.patch);
		expect(applied.ok).toBe(true);
		expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("agent line");
		expect(await fs.readFile(path.join(repo, "created.txt"), "utf8")).toBe("brand new\n");
	});

	test("identical trees produce an empty patch", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const t = await captureWorktreeTree(wt);
		expect(t.ok).toBe(true);
		if (!t.ok) return;
		const patch = await computeTurnPatch(wt, t.tree, t.tree);
		expect(patch.ok).toBe(true);
		if (patch.ok) expect(patch.patch).toBe("");
	});

	// ── N1 (live-verified): core.quotepath C-quoting a non-ASCII filename made patchTouchedPaths
	// lstat the ESCAPED LITERAL instead of the real path, which read as "absent" and raised a false
	// CRITICAL divergence on every legitimate turn touching a pre-existing accented/CJK-named file. ──

	test("N1: a turn touching a pre-existing ACCENTED filename produces an UNQUOTED diff header (core.quotepath disabled on the patch-producing diff) and applies clean with no divergence", async () => {
		const repo = await initRepo();
		await fs.writeFile(path.join(repo, "naïve.txt"), "hello\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "add accented file");
		const wt = await addWorktree(repo);
		const start = await captureWorktreeTree(wt);
		await fs.writeFile(path.join(wt, "naïve.txt"), "world\n");
		const end = await captureWorktreeTree(wt);
		if (!start.ok || !end.ok) throw new Error("snapshot failed");
		const patch = await computeTurnPatch(wt, start.tree, end.tree);
		if (!patch.ok) throw new Error("patch failed");
		// The header must carry the RAW UTF-8 path, not git's default C-quoted literal — this is the
		// root fix (-c core.quotepath=false on the patch-producing diff); without it this assertion
		// fails with `"a/na\303\257ve.txt"` instead.
		expect(patch.patch).toContain("diff --git a/naïve.txt b/naïve.txt");
		expect(patch.patch).not.toContain("\\303\\257");
		expect(patchTouchedPaths(patch.patch)).toEqual(["naïve.txt"]);
		const decided = await captureRealTreeState(repo);
		if (!decided.ok) throw new Error("capture failed");
		const r = await applyPatchToRealTree(repo, patch.patch, decided.fingerprint);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.divergence).toBeUndefined(); // the false-positive this finding is about
		expect(await fs.readFile(path.join(repo, "naïve.txt"), "utf8")).toBe("world\n");
	});
});

describe("patchTouchedPaths (defense in depth: unquoting + the header split ambiguity)", () => {
	test("a plain unquoted modify/add/delete header resolves via the unambiguous ---/+++ lines", () => {
		const patch = [
			"diff --git a/foo.txt b/foo.txt",
			"index 111..222 100644",
			"--- a/foo.txt",
			"+++ b/foo.txt",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/new.txt b/new.txt",
			"new file mode 100644",
			"index 000..333",
			"--- /dev/null",
			"+++ b/new.txt",
			"@@ -0,0 +1 @@",
			"+created",
			"",
		].join("\n");
		expect(patchTouchedPaths(patch).sort()).toEqual(["foo.txt", "new.txt"]);
	});

	test("a C-quoted header (core.quotepath left ON somewhere upstream) still resolves to the real path", () => {
		const patch = [
			'diff --git "a/na\\303\\257ve.txt" "b/na\\303\\257ve.txt"',
			"index 111..222 100644",
			'--- "a/na\\303\\257ve.txt"',
			'+++ "b/na\\303\\257ve.txt"',
			"@@ -1 +1 @@",
			"-hello",
			"+world",
			"",
		].join("\n");
		expect(patchTouchedPaths(patch)).toEqual(["naïve.txt"]);
	});

	test("a binary patch (no ---/+++ text lines) falls back to the header split — old==new invariant resolves even a path containing the literal substring ' b/'", () => {
		const patch = ["diff --git a/weird b/x b/weird b/x", "index 111..222 100644", "GIT binary patch", "literal 4", "abcd", ""].join("\n");
		expect(patchTouchedPaths(patch)).toEqual(["weird b/x"]);
	});

	test("a quoted header with no ---/+++ lines (binary + non-ASCII name) still unquotes via the header-split fallback", () => {
		const patch = ['diff --git "a/na\\303\\257ve.bin" "b/na\\303\\257ve.bin"', "index 111..222 100644", "GIT binary patch", "literal 4", "abcd", ""].join("\n");
		expect(patchTouchedPaths(patch)).toEqual(["naïve.bin"]);
	});

	test("/dev/null sides (pure add/delete) never register as a touched path", () => {
		const patch = ["diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "index 111..000", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", ""].join("\n");
		expect(patchTouchedPaths(patch)).toEqual(["gone.txt"]);
	});
});

describe("applyPatchToRealTree", () => {
	test("a conflicting patch leaves the real tree byte-identical (check-first, atomic)", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const start = await captureWorktreeTree(wt);
		await fs.writeFile(path.join(wt, "a.txt"), "one\ntwo\nthree\nagent\n");
		const end = await captureWorktreeTree(wt);
		if (!start.ok || !end.ok) throw new Error("snapshot failed");
		const patch = await computeTurnPatch(wt, start.tree, end.tree);
		if (!patch.ok) throw new Error("patch failed");
		// Real tree diverges in the SAME file so the patch can no longer apply.
		await fs.writeFile(path.join(repo, "a.txt"), "totally different\n");
		const before = await fileSnapshot(repo);
		const r = await applyPatchToRealTree(repo, patch.patch);
		expect(r.ok).toBe(false);
		expect(await fileSnapshot(repo)).toEqual(before);
	});

	test("last-instant re-fingerprint: a DISJOINT operator edit after the decision fingerprint fails the apply (git's context check alone would let it through)", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const start = await captureWorktreeTree(wt);
		await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
		const end = await captureWorktreeTree(wt);
		if (!start.ok || !end.ok) throw new Error("snapshot failed");
		const patch = await computeTurnPatch(wt, start.tree, end.tree);
		if (!patch.ok) throw new Error("patch failed");
		// The fingerprint the auto path decided on…
		const decided = await captureRealTreeState(repo);
		if (!decided.ok) throw new Error("capture failed");
		// …then the operator edits a DIFFERENT file: `git apply --check` still passes (disjoint), so
		// only the expectedFingerprint recheck stands between the stale decision and the write.
		await fs.appendFile(path.join(repo, "b.txt"), "operator raced in\n");
		const before = await fileSnapshot(repo);
		const r = await applyPatchToRealTree(repo, patch.patch, decided.fingerprint);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("changed between the safety check and the apply");
		expect(await fileSnapshot(repo)).toEqual(before); // nothing written — the agent line stayed out too
	});

	test("last-instant re-fingerprint: a matching fingerprint still applies", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const start = await captureWorktreeTree(wt);
		await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
		const end = await captureWorktreeTree(wt);
		if (!start.ok || !end.ok) throw new Error("snapshot failed");
		const patch = await computeTurnPatch(wt, start.tree, end.tree);
		if (!patch.ok) throw new Error("patch failed");
		const decided = await captureRealTreeState(repo);
		if (!decided.ok) throw new Error("capture failed");
		const r = await applyPatchToRealTree(repo, patch.patch, decided.fingerprint);
		expect(r.ok).toBe(true);
		expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("agent line");
	});

	// ── C1: the residual window-3 race is now DETECTED, never silent ────────────────────────────────

	test("C1: a disjoint operator write landing between the pre-write snapshot and the real `git apply` is DETECTED as a divergence, never silently accepted", async () => {
		const repo = await initRepo();
		// Widen a.txt so the turn's hunk (an append at the very end) carries only TAIL context — line 1
		// stays free for the race to land OUTSIDE the hunk entirely (the module doc's "disjoint same-file
		// edit interleaves with apply's in-place rewrite" shape — `git apply` has no lock a real editor
		// write would also honor).
		const wide = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
		await fs.writeFile(path.join(repo, "a.txt"), wide);
		await git(repo, "commit", "-aqm", "widen a.txt");
		const wt = await addWorktree(repo);
		const start = await captureWorktreeTree(wt);
		await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
		const end = await captureWorktreeTree(wt);
		if (!start.ok || !end.ok) throw new Error("snapshot failed");
		const patch = await computeTurnPatch(wt, start.tree, end.tree);
		if (!patch.ok) throw new Error("patch failed");
		const decided = await captureRealTreeState(repo);
		if (!decided.ok) throw new Error("capture failed");

		const divergenceRoot = await tmpDir("bsync-divergence-");
		const raced = `RACED\n${wide.split("\n").slice(1).join("\n")}`;
		const r = await applyPatchToRealTree(repo, patch.patch, decided.fingerprint, {
			divergenceDir: divergenceRoot,
			// Fires after the pre-write snapshot, before the real `git apply` — the exact residual window.
			testHookAfterSnapshot: async () => {
				await fs.writeFile(path.join(repo, "a.txt"), raced);
			},
		});
		expect(r.ok).toBe(true); // the write itself happened — nothing to retry
		if (!r.ok) return;
		expect(r.divergence).toBeDefined();
		expect(r.divergence?.paths).toEqual(["a.txt"]);
		expect(r.divergence?.captureDir.startsWith(divergenceRoot)).toBe(true);
		// The pre-write capture is retained on disk — the PRE-race content, never the racer's own write.
		const retained = await fs.readFile(path.join(r.divergence!.captureDir, "a.txt"), "utf8");
		expect(retained).toBe(wide);
		// Nothing was auto-restored: the real tree keeps whatever `git apply` actually produced.
		const finalContent = await fs.readFile(path.join(repo, "a.txt"), "utf8");
		expect(finalContent).toContain("RACED");
		expect(finalContent).toContain("agent line");
	});

	test("C1: no divergence on the happy path — zero extra disk writes, no false positive", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const start = await captureWorktreeTree(wt);
		await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
		const end = await captureWorktreeTree(wt);
		if (!start.ok || !end.ok) throw new Error("snapshot failed");
		const patch = await computeTurnPatch(wt, start.tree, end.tree);
		if (!patch.ok) throw new Error("patch failed");
		const decided = await captureRealTreeState(repo);
		if (!decided.ok) throw new Error("capture failed");
		const r = await applyPatchToRealTree(repo, patch.patch, decided.fingerprint);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.divergence).toBeUndefined();
	});
});

// ── the turn-end decision ─────────────────────────────────────────────────────────────────────────

describe("syncTurnEnd", () => {
	test("noop when the turn changed nothing", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		const start = await beginTurn(repo, wt);
		const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("noop");
		expect(await store.listHeld("a1")).toHaveLength(0);
	});

	test("applies end to end even with an untouched dangling symlink sitting in the real checkout (regression: this used to brick auto-sync AND the Apply recovery path forever)", async () => {
		const repo = await initRepo();
		await fs.symlink("/no/such/target", path.join(repo, "dangling-link"));
		const wt = await addWorktree(repo);
		const store = await newStore();
		const start = await beginTurn(repo, wt);
		expect(start.realFingerprint).toBeTruthy(); // capture must succeed, not ride realFailure
		await fs.appendFile(path.join(wt, "a.txt"), "from the agent\n");
		const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("applied");
		expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("from the agent");
		expect(await store.listHeld("a1")).toHaveLength(0);
		// The recovery affordance is exercised too: Apply must still work when there IS a backlog,
		// with the same broken symlink present throughout.
		const store2 = await newStore();
		const s1 = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "turn2\n");
		await fs.appendFile(path.join(repo, "b.txt"), "operator\n"); // force a hold
		const held = await syncTurnEnd({ realDir: repo, worktree: wt, start: s1, store: store2, agentId: "a1", turn: 2 });
		expect(held.kind).toBe("held");
		const applied = await applyHeldNow(store2, "a1", repo);
		expect(applied).toEqual({ ok: true, applied: 1, remaining: 0 });
		expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("turn2");
	});

	test("HOLDS when a dangling symlink's target string changes mid-turn (a real divergence, not a capture failure)", async () => {
		const repo = await initRepo();
		const link = path.join(repo, "dangling-link");
		await fs.symlink("/no/such/target-v1", link);
		const wt = await addWorktree(repo);
		const store = await newStore();
		const start = await beginTurn(repo, wt);
		expect(start.realFingerprint).toBeTruthy();
		await fs.appendFile(path.join(wt, "a.txt"), "agent edit\n");
		await fs.rm(link);
		await fs.symlink("/no/such/target-v2", link); // operator (or something) retargets it mid-turn
		const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("held");
		if (out.kind === "held") expect(out.reason).toContain("changed during this turn");
		expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("agent edit"); // not written
	});

	test("S1: HOLDS when an untracked file's readability flips mid-turn (content: mode ⇒ stat: mode) — mixed-mode fingerprints must never compare equal", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const secret = path.join(repo, "secret.txt");
		await fs.writeFile(secret, "before\n");
		const store = await newStore();
		const start = await beginTurn(repo, wt);
		expect(start.realFingerprint).toBeTruthy(); // captured while readable — "content:" mode
		await fs.appendFile(path.join(wt, "a.txt"), "agent edit\n");
		try {
			await fs.chmod(secret, 0o000); // readability flips mid-turn — the mode TAG changes, not the bytes
			const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
			expect(out.kind).toBe("held");
			if (out.kind === "held") expect(out.reason).toContain("changed during this turn");
			expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("agent edit"); // not written
		} finally {
			await fs.chmod(secret, 0o644).catch(() => {});
		}
	});

	test("applies the turn's edits to the real checkout when it provably did not move", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		const start = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "from the agent\n");
		const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("applied");
		expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("from the agent");
		expect(await store.listHeld("a1")).toHaveLength(0);
	});

	test("HOLDS (never applies, never conflicts) when the real tree moved mid-turn", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		const start = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "agent edit\n");
		// The operator concurrently edits a DIFFERENT file — the patch would apply cleanly, which is
		// exactly why this must hold on the fingerprint, not on git-apply conflict detection.
		await fs.appendFile(path.join(repo, "b.txt"), "operator edit\n");
		const before = await fileSnapshot(repo);
		const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("held");
		if (out.kind === "held") expect(out.reason).toContain("changed during this turn");
		expect(await fileSnapshot(repo)).toEqual(before); // real tree untouched
		const held = await store.listHeld("a1");
		expect(held).toHaveLength(1);
		expect(await fs.readFile(held[0].patchFile, "utf8")).toContain("agent edit");
	});

	test("a held backlog blocks the NEXT turn's auto-apply even when the real tree is stable again", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		// Turn 1 holds (operator moved the tree mid-turn).
		const s1 = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
		await fs.appendFile(path.join(repo, "b.txt"), "operator\n");
		const o1 = await syncTurnEnd({ realDir: repo, worktree: wt, start: s1, store, agentId: "a1", turn: 1 });
		expect(o1.kind).toBe("held");
		// Turn 2: real tree is stable across the whole turn, but turn 2's hunks may depend on turn
		// 1's — it must queue behind the backlog, not leapfrog it.
		const s2 = await beginTurn(repo, wt, o1.kind === "held" ? o1.endTree : undefined);
		await fs.appendFile(path.join(wt, "a.txt"), "turn2\n");
		const before = await fileSnapshot(repo);
		const o2 = await syncTurnEnd({ realDir: repo, worktree: wt, start: s2, store, agentId: "a1", turn: 2 });
		expect(o2.kind).toBe("held");
		if (o2.kind === "held") expect(o2.reason).toContain("held");
		expect(await fileSnapshot(repo)).toEqual(before);
		expect(await store.listHeld("a1")).toHaveLength(2);
	});

	test("holds when the patch itself cannot apply (pre-session divergence in the same file)", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		// The real tree diverged in a.txt BEFORE the session's first turn — fingerprints match
		// start→end (no mid-turn movement) but the patch conflicts; it must hold, not half-apply.
		await fs.writeFile(path.join(repo, "a.txt"), "operator wip\n");
		const store = await newStore();
		const start = await beginTurn(repo, wt);
		await fs.writeFile(path.join(wt, "a.txt"), "one\ntwo\nthree\nagent\n");
		const before = await fileSnapshot(repo);
		const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("held");
		if (out.kind === "held") expect(out.reason).toContain("did not apply cleanly");
		expect(await fileSnapshot(repo)).toEqual(before);
		expect(await store.listHeld("a1")).toHaveLength(1);
	});
});

// ── fail-closed acceptance (00-meta.md: missing these = spec violation) ──────────────────────────

describe("fail-closed acceptance: fingerprint capture failure can never authorize an apply", () => {
	test("turn-START capture failure ⇒ hold + attention-shaped outcome, real tree untouched", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		// Force the turn-start fingerprint to fail: the "real dir" is not a git repo at capture time.
		const notARepo = await tmpDir("bsync-notrepo-");
		const start = await beginTurn(notARepo, wt);
		expect(start.realFingerprint).toBeUndefined();
		expect(start.realFailure).toBeTruthy();
		await fs.appendFile(path.join(wt, "a.txt"), "agent edit\n");
		// The real repo is fine at turn END — but the start baseline is a recorded FAILURE, which
		// must compare equal to nothing.
		const before = await fileSnapshot(repo);
		const out = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("held");
		if (out.kind === "held") expect(out.reason).toContain("turn start");
		expect(await fileSnapshot(repo)).toEqual(before);
		expect(await store.listHeld("a1")).toHaveLength(1);
	});

	test("turn-END capture failure ⇒ hold, real tree untouched (repo breaks mid-turn)", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		// A separate plain directory plays the real tree so we can break it without breaking the
		// worktree's own git plumbing (a worktree shares its repo's object DB).
		const real = await tmpDir("bsync-real2-");
		await git(real, "init", "-q", "-b", "main");
		await git(real, "config", "user.email", "t@t");
		await git(real, "config", "user.name", "t");
		await fs.writeFile(path.join(real, "a.txt"), "one\ntwo\nthree\n");
		await git(real, "add", "-A");
		await git(real, "commit", "-qm", "base");
		const start = await beginTurn(real, wt);
		expect(start.realFingerprint).toBeTruthy();
		await fs.appendFile(path.join(wt, "a.txt"), "agent edit\n");
		// Mid-turn, the real checkout stops being a repo (e.g. deleted/moved) — re-fingerprint FAILS.
		await fs.rename(path.join(real, ".git"), path.join(real, ".git-hidden"));
		const before = await fileSnapshot(real);
		const out = await syncTurnEnd({ realDir: real, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("held");
		if (out.kind === "held") expect(out.reason).toContain("turn end");
		expect(await fileSnapshot(real)).toEqual(before);
		expect(await store.listHeld("a1")).toHaveLength(1);
	});

	test("turn-start WORKTREE snapshot failure ⇒ uncapturable (surfaced, nothing applied)", async () => {
		const repo = await initRepo();
		const store = await newStore();
		const notARepo = await tmpDir("bsync-badwt-");
		const start = await beginTurn(repo, notARepo);
		expect(start.startTree).toBeUndefined();
		expect(start.treeFailure).toBeTruthy();
		const before = await fileSnapshot(repo);
		const out = await syncTurnEnd({ realDir: repo, worktree: notARepo, start, store, agentId: "a1", turn: 1 });
		expect(out.kind).toBe("uncapturable");
		expect(await fileSnapshot(repo)).toEqual(before);
		expect(await store.listHeld("a1")).toHaveLength(0);
	});

	test("explicit apply with an unfingerprint-able checkout applies NOTHING", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		// Seed one legitimately held patch.
		const start = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "agent edit\n");
		await fs.appendFile(path.join(repo, "b.txt"), "operator edit\n");
		const held = await syncTurnEnd({ realDir: repo, worktree: wt, start, store, agentId: "a1", turn: 1 });
		expect(held.kind).toBe("held");
		// The explicit-apply target cannot be fingerprinted → refuse before reading a single patch.
		const notARepo = await tmpDir("bsync-notrepo2-");
		const r = await applyHeldNow(store, "a1", notARepo);
		expect(r.ok).toBe(false);
		expect(r.applied).toBe(0);
		expect(r.remaining).toBe(1);
		expect(await store.listHeld("a1")).toHaveLength(1);
	});
});

// ── held-patch store durability ───────────────────────────────────────────────────────────────────

describe("HeldSyncStore", () => {
	test("holds survive a new store instance (daemon restart) and resolve() clears them", async () => {
		const dir = await tmpDir("bsync-store-");
		const s1 = new HeldSyncStore(dir);
		const h = await s1.hold({ agentId: "a1", turn: 1, realDir: "/real", reason: "r", patch: "diff --git a/x b/x\n" });
		const s2 = new HeldSyncStore(dir);
		expect(await s2.listHeld("a1")).toHaveLength(1);
		expect(await fs.readFile(h.patchFile, "utf8")).toContain("diff --git");
		await s2.resolve(h.id, "applied");
		expect(await s2.listHeld("a1")).toHaveLength(0);
		expect(await new HeldSyncStore(dir).listHeld("a1")).toHaveLength(0);
	});

	test("a torn tail line (crash mid-append) is ignored; complete lines still parse", async () => {
		const dir = await tmpDir("bsync-store-");
		const s = new HeldSyncStore(dir);
		await s.hold({ agentId: "a1", turn: 1, realDir: "/real", reason: "r", patch: "p1" });
		await fs.appendFile(path.join(dir, "held.jsonl"), '{"kind":"held","id":"torn');
		expect(await s.listHeld("a1")).toHaveLength(1);
	});

	test("an append AFTER a torn tail starts on a fresh line — the new event is never welded onto the garbage", async () => {
		const dir = await tmpDir("bsync-store-");
		const s = new HeldSyncStore(dir);
		await s.hold({ agentId: "a1", turn: 1, realDir: "/real", reason: "r", patch: "p1" });
		// Crash mid-append: partial line, no trailing newline.
		await fs.appendFile(path.join(dir, "held.jsonl"), '{"kind":"held","id":"torn');
		// The NEXT hold must survive — naive appendFile would produce `…"torn{"kind":"held"…`,
		// losing the new (valid) event along with the torn one and letting later turns leapfrog it.
		const h2 = await s.hold({ agentId: "a1", turn: 2, realDir: "/real", reason: "r", patch: "p2" });
		const held = await s.listHeld("a1");
		expect(held).toHaveLength(2);
		expect(held.map((h) => h.turn)).toEqual([1, 2]);
		// And resolution lines get the same guard.
		await fs.appendFile(path.join(dir, "held.jsonl"), '{"kind":"resolv');
		await s.resolve(h2.id, "discarded");
		expect((await s.listHeld("a1")).map((h) => h.turn)).toEqual([1]);
	});

	test("an unreadable ledger FAILS the read (never an empty backlog) — fail-closed, not fail-open", async () => {
		const dir = await tmpDir("bsync-store-");
		const s = new HeldSyncStore(dir);
		// held.jsonl exists but cannot be read as a file (EISDIR — deterministic for any uid).
		await fs.mkdir(path.join(dir, "held.jsonl"));
		await expect(s.listAllHeld()).rejects.toThrow(/ledger unreadable/);
		// An empty [] here would have let the next turn auto-apply ahead of an older held
		// dependency and let Apply report ok/0 while clearing a row with real patches behind it.
	});

	test("no ledger at all IS an empty backlog (ENOENT is the one genuinely-empty error)", async () => {
		const s = await newStore();
		expect(await s.listAllHeld()).toEqual([]);
	});

	test("holds are per-agent", async () => {
		const s = await newStore();
		await s.hold({ agentId: "a1", turn: 1, realDir: "/r", reason: "r", patch: "p" });
		await s.hold({ agentId: "a2", turn: 1, realDir: "/r", reason: "r", patch: "p" });
		expect(await s.listHeld("a1")).toHaveLength(1);
		expect(await s.listHeld("a2")).toHaveLength(1);
		expect(await s.listAllHeld()).toHaveLength(2);
	});

	// ── S6: a ledger-append failure must never cost the patch body itself ──────────────────────────

	test("S6: ledger-append failure throws HeldLedgerAppendError but the patch body IS on disk (never uncapturable)", async () => {
		const dir = await tmpDir("bsync-store-");
		const s = new HeldSyncStore(dir);
		// held.jsonl exists as a DIRECTORY before any hold ever runs — the patch write (a sibling
		// `<id>.patch` file) succeeds; only the ledger line append (opening held.jsonl itself) fails.
		await fs.mkdir(path.join(dir, "held.jsonl"));
		let caught: unknown;
		try {
			await s.hold({ agentId: "a1", turn: 1, realDir: "/r", reason: "r", patch: "the patch body" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(HeldLedgerAppendError);
		const err = caught as HeldLedgerAppendError;
		expect(err.patchFile).toContain(dir);
		expect(await fs.readFile(err.patchFile, "utf8")).toBe("the patch body"); // recoverable by hand
		expect(err.message).toContain(err.patchFile); // the message itself names the file
	});

	// ── C2: reattach re-key (a hold's agentId moves onto a fresh session id) ────────────────────────

	describe("rekey", () => {
		test("re-keys a hold onto a new agent id without touching the patch body or its file", async () => {
			const s = await newStore();
			const held = await s.hold({ agentId: "chat-old", turn: 1, realDir: "/r", reason: "r", patch: "p1" });
			await s.rekey(held.id, "chat-new");
			expect(await s.listHeld("chat-old")).toHaveLength(0); // gone from the old id
			const moved = await s.listHeld("chat-new");
			expect(moved).toHaveLength(1);
			expect(moved[0]!.id).toBe(held.id); // same identity
			expect(moved[0]!.patchFile).toBe(held.patchFile); // same body, never rewritten
			expect(await fs.readFile(held.patchFile, "utf8")).toBe("p1");
		});

		test("a rekey line for an already-resolved id is an inert replay artifact, never fabricates a hold", async () => {
			const s = await newStore();
			const held = await s.hold({ agentId: "chat-old", turn: 1, realDir: "/r", reason: "r", patch: "p1" });
			await s.resolve(held.id, "applied");
			await s.rekey(held.id, "chat-new");
			expect(await s.listHeld("chat-new")).toHaveLength(0);
			expect(await s.listAllHeld()).toHaveLength(0);
		});

		test("rekey survives a restart (fresh HeldSyncStore instance over the same dir replays it identically)", async () => {
			const dir = await tmpDir("bsync-store-");
			const s1 = new HeldSyncStore(dir);
			const held = await s1.hold({ agentId: "chat-old", turn: 1, realDir: "/r", reason: "r", patch: "p1" });
			await s1.rekey(held.id, "chat-new");
			const s2 = new HeldSyncStore(dir); // simulates a daemon restart over the same state dir
			expect(await s2.listHeld("chat-old")).toHaveLength(0);
			expect((await s2.listHeld("chat-new"))[0]?.id).toBe(held.id);
		});
	});
});

// ── explicit apply (the attention row's one click) ────────────────────────────────────────────────

describe("applyHeldNow", () => {
	test("replays held patches in order and clears them once the checkout is safe again", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		// Two held turns: turn 1 held on operator movement, turn 2 held on backlog.
		const s1 = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
		await fs.appendFile(path.join(repo, "b.txt"), "operator\n");
		const o1 = await syncTurnEnd({ realDir: repo, worktree: wt, start: s1, store, agentId: "a1", turn: 1 });
		expect(o1.kind).toBe("held");
		const s2 = await beginTurn(repo, wt, o1.kind === "held" ? o1.endTree : undefined);
		await fs.appendFile(path.join(wt, "a.txt"), "turn2\n");
		const o2 = await syncTurnEnd({ realDir: repo, worktree: wt, start: s2, store, agentId: "a1", turn: 2 });
		expect(o2.kind).toBe("held");
		// The operator clicks Apply.
		const r = await applyHeldNow(store, "a1", repo);
		expect(r).toEqual({ ok: true, applied: 2, remaining: 0 });
		const a = await fs.readFile(path.join(repo, "a.txt"), "utf8");
		expect(a).toContain("turn1");
		expect(a).toContain("turn2");
		expect(a.indexOf("turn1")).toBeLessThan(a.indexOf("turn2")); // strict order
		expect(await store.listHeld("a1")).toHaveLength(0);
	});

	test("stops at the first still-divergent patch; later patches stay held; earlier applies stick", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		// Turn 1 edits a.txt (held via operator edit to b.txt); the operator then ALSO rewrites
		// a.txt, so turn 1's patch can never apply — but a second held patch touching c.txt could.
		const s1 = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
		await fs.appendFile(path.join(repo, "b.txt"), "operator\n");
		expect((await syncTurnEnd({ realDir: repo, worktree: wt, start: s1, store, agentId: "a1", turn: 1 })).kind).toBe("held");
		const s2 = await beginTurn(repo, wt);
		await fs.writeFile(path.join(wt, "c.txt"), "turn2\n");
		expect((await syncTurnEnd({ realDir: repo, worktree: wt, start: s2, store, agentId: "a1", turn: 2 })).kind).toBe("held");
		await fs.writeFile(path.join(repo, "a.txt"), "operator rewrote this\n");
		const r = await applyHeldNow(store, "a1", repo);
		expect(r.ok).toBe(false);
		expect(r.applied).toBe(0);
		expect(r.remaining).toBe(2);
		expect(r.reason).toContain("still divergent");
		// Order is strict: the conflicting FIRST patch blocks everything after it — c.txt not written.
		await expect(fs.access(path.join(repo, "c.txt"))).rejects.toThrow();
		expect(await store.listHeld("a1")).toHaveLength(2);
	});

	test("no holds is a clean no-op", async () => {
		const repo = await initRepo();
		const store = await newStore();
		expect(await applyHeldNow(store, "a1", repo)).toEqual({ ok: true, applied: 0, remaining: 0 });
	});
});

// ── explicit discard (the recovery path for a backlog that can never apply) ──────────────────────

describe("discardHeldNow", () => {
	test("unwedges a backlog whose first patch can never apply: discard it, then auto-sync works again", async () => {
		const repo = await initRepo();
		const wt = await addWorktree(repo);
		const store = await newStore();
		// Turn 1 held; the operator then fixes the divergence BY HAND (rewrites a.txt), so turn 1's
		// patch will fail `--check` forever — the exact wedge the discard affordance exists for.
		const s1 = await beginTurn(repo, wt);
		await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
		await fs.appendFile(path.join(repo, "b.txt"), "operator\n");
		expect((await syncTurnEnd({ realDir: repo, worktree: wt, start: s1, store, agentId: "a1", turn: 1 })).kind).toBe("held");
		await fs.writeFile(path.join(repo, "a.txt"), "operator applied the change by hand\n");
		expect((await applyHeldNow(store, "a1", repo)).ok).toBe(false); // wedged for real
		const before = await fileSnapshot(repo);
		const r = await discardHeldNow(store, "a1");
		expect(r).toEqual({ ok: true, discarded: 1, remaining: 0 });
		expect(await fileSnapshot(repo)).toEqual(before); // discard never touches the real tree
		expect(await store.listHeld("a1")).toHaveLength(0);
		// With the backlog gone, the next stable turn auto-applies again (auto-sync un-bricked).
		const s2 = await beginTurn(repo, wt);
		await fs.writeFile(path.join(wt, "c.txt"), "turn2\n");
		const o2 = await syncTurnEnd({ realDir: repo, worktree: wt, start: s2, store, agentId: "a1", turn: 2 });
		expect(o2.kind).toBe("applied");
		expect(await fs.readFile(path.join(repo, "c.txt"), "utf8")).toBe("turn2\n");
	});

	test("patchId discards exactly one held patch; the rest stay held in order", async () => {
		const store = await newStore();
		const h1 = await store.hold({ agentId: "a1", turn: 1, realDir: "/r", reason: "r", patch: "p1" });
		await store.hold({ agentId: "a1", turn: 2, realDir: "/r", reason: "r", patch: "p2" });
		const r = await discardHeldNow(store, "a1", h1.id);
		expect(r).toEqual({ ok: true, discarded: 1, remaining: 1 });
		const left = await store.listHeld("a1");
		expect(left).toHaveLength(1);
		expect(left[0].turn).toBe(2);
	});

	test("an unknown patchId discards nothing and says so", async () => {
		const store = await newStore();
		await store.hold({ agentId: "a1", turn: 1, realDir: "/r", reason: "r", patch: "p1" });
		const r = await discardHeldNow(store, "a1", "not-a-real-id");
		expect(r.ok).toBe(false);
		expect(r.discarded).toBe(0);
		expect(r.remaining).toBe(1);
		expect(await store.listHeld("a1")).toHaveLength(1);
	});

	test("discard is per-agent: another session's holds are untouched", async () => {
		const store = await newStore();
		await store.hold({ agentId: "a1", turn: 1, realDir: "/r", reason: "r", patch: "p1" });
		await store.hold({ agentId: "a2", turn: 1, realDir: "/r", reason: "r", patch: "p2" });
		expect(await discardHeldNow(store, "a1")).toEqual({ ok: true, discarded: 1, remaining: 0 });
		expect(await store.listHeld("a2")).toHaveLength(1);
	});

	test("no holds is a clean no-op", async () => {
		const store = await newStore();
		expect(await discardHeldNow(store, "a1")).toEqual({ ok: true, discarded: 0, remaining: 0 });
	});
});
