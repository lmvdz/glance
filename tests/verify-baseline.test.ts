/**
 * Unit tests for `makeBaselineFailureProvider` (postmortem-gate-fixes): the per-unit verify
 * gate's base-diff provider. Everything here is FAKE (git + exec) so it never spawns a real
 * process or touches a real repo — the point is to prove the base-ref resolution (origin-preferred,
 * fail-closed), the dependency-change guard, the scratch worktree lifecycle, memoization, and the
 * fail-closed error paths, independent of git/bun.
 */

import { expect, test } from "bun:test";
import { type BaselineProviderDeps, makeBaselineFailureProvider } from "../src/workflow/verify-baseline.ts";

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Fake git. Defaults resolve a clean base: origin/HEAD → origin/main, that ref exists, merge-base
 * yields a base sha, and the unit changed no dependency manifests — so a plain `fakeGit({})` lets the
 * base run proceed. Override any handler to exercise a specific path.
 */
function fakeGit(handlers: {
	symbolicRef?: Run; // git symbolic-ref refs/remotes/origin/HEAD
	refExists?: (ref: string) => boolean; // git rev-parse --verify --quiet <ref>^{commit}
	mergeBase?: Run; // git merge-base HEAD <target>
	depDiff?: Run; // git diff --name-only <base> -- package.json bun.lock
	worktreeAdd?: Run;
	worktreeRemove?: Run;
}) {
	const calls: string[][] = [];
	const git: BaselineProviderDeps["git"] = async (args) => {
		calls.push(args);
		if (args[0] === "symbolic-ref") return handlers.symbolicRef ?? { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			const ref = (args[3] ?? "").replace(/\^\{commit\}$/, "");
			const exists = handlers.refExists ? handlers.refExists(ref) : true;
			return exists ? { code: 0, stdout: `${ref}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
		}
		if (args[0] === "merge-base") return handlers.mergeBase ?? { code: 0, stdout: "deadbeef01234567\n", stderr: "" };
		if (args[0] === "diff") return handlers.depDiff ?? { code: 0, stdout: "", stderr: "" };
		if (args[0] === "worktree" && args[1] === "add") return handlers.worktreeAdd ?? { code: 0, stdout: "", stderr: "" };
		if (args[0] === "worktree" && args[1] === "remove") return handlers.worktreeRemove ?? { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { git, calls };
}

function baseDeps(overrides: Partial<BaselineProviderDeps> & { git: BaselineProviderDeps["git"] }): BaselineProviderDeps {
	return {
		worktree: "/fake/worktree",
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		mkTmpDir: () => "/fake/scratch-dir",
		log: () => {},
		...overrides,
	};
}

test("resolves the base ref via merge-base against origin/<default> (remote-tracking, not local), and creates + removes a detached scratch worktree", async () => {
	const { git, calls } = fakeGit({
		symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" },
		mergeBase: { code: 0, stdout: "abc123def456\n", stderr: "" },
	});
	const exec = async (_script: string, _cwd: string) => ({ code: 0, stdout: "ok", stderr: "" });
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));

	const result = await provider("bun test");
	expect(result).not.toBeNull();
	expect(result!.baseRef).toBe("abc123def456");
	expect(result!.failures).toEqual([]);
	expect(result!.unrunnable).toBeNull();

	// merge-base was resolved against the REMOTE-tracking default (origin/main), never local `main` —
	// diffing against a stale local default would wave a reintroduced-then-fixed failure through.
	expect(calls).toContainEqual(["symbolic-ref", "refs/remotes/origin/HEAD"]);
	expect(calls).toContainEqual(["merge-base", "HEAD", "origin/main"]);
	// Scratch worktree lifecycle: add --detach <tmp> <baseSha>, later remove --force <tmp>.
	expect(calls).toContainEqual(["worktree", "add", "--detach", "/fake/scratch-dir", "abc123def456"]);
	expect(calls).toContainEqual(["worktree", "remove", "--force", "/fake/scratch-dir"]);
});

test("falls back to a LOCAL default (main/master) only when no remote-tracking default exists", async () => {
	const { git, calls } = fakeGit({
		symbolicRef: { code: 1, stdout: "", stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref" },
		refExists: (ref) => ref === "main", // origin/main, origin/master absent; local main present
		mergeBase: { code: 0, stdout: "cafef00d\n", stderr: "" },
	});
	const provider = makeBaselineFailureProvider(baseDeps({ git }));
	const result = await provider("bun test");
	expect(result!.baseRef).toBe("cafef00d");
	expect(result!.unrunnable).toBeNull();
	expect(calls).toContainEqual(["merge-base", "HEAD", "main"]);
});

test("FAIL CLOSED: no resolvable base target ⇒ unrunnable, never a HEAD fallback (which would fold committed unit edits into 'base')", async () => {
	const { git } = fakeGit({
		symbolicRef: { code: 1, stdout: "", stderr: "no ref" },
		refExists: () => false, // nothing resolves
	});
	let execCalled = false;
	const exec = async () => {
		execCalled = true;
		return { code: 0, stdout: "ok", stderr: "" };
	};
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toContain("could not resolve a base ref");
	expect(result!.failures).toEqual([]);
	expect(execCalled).toBe(false); // never runs a gate against an untrustworthy base
});

test("FAIL CLOSED: merge-base failing (unrelated histories) ⇒ unrunnable, exec never runs", async () => {
	const { git } = fakeGit({
		symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" },
		mergeBase: { code: 1, stdout: "", stderr: "fatal: no merge base" },
	});
	let execCalled = false;
	const exec = async () => {
		execCalled = true;
		return { code: 0, stdout: "", stderr: "" };
	};
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toContain("could not resolve a base ref");
	expect(execCalled).toBe(false);
});

test("FAIL CLOSED: unit changed dependencies (package.json/bun.lock) ⇒ unrunnable, never runs the base gate against the unit's own deps", async () => {
	const { git } = fakeGit({
		depDiff: { code: 0, stdout: "bun.lock\n", stderr: "" }, // the unit's tree differs from base in bun.lock
	});
	let execCalled = false;
	const exec = async () => {
		execCalled = true;
		return { code: 0, stdout: "", stderr: "" };
	};
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toContain("changed dependencies");
	expect(result!.failures).toEqual([]);
	expect(execCalled).toBe(false); // base run shares the unit's node_modules — would look pre-existing
});

test("memoizes PER SCRIPT: repeated calls with the same script run the base exec exactly once", async () => {
	const { git } = fakeGit({});
	let execCalls = 0;
	const exec = async () => {
		execCalls++;
		await new Promise((r) => setTimeout(r, 5));
		return { code: 0, stdout: "ok", stderr: "" };
	};
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));

	const [a, b] = await Promise.all([provider("bun test"), provider("bun test")]);
	expect(execCalls).toBe(1);
	expect(a).toBe(b); // same memoized result object

	const c = await provider("bun test"); // a third, sequential call still hits the memo
	expect(execCalls).toBe(1);
	expect(c).toBe(a);
});

test("memoization is keyed on the script: a DIFFERENT command runs its own base run (no cross-gate reuse)", async () => {
	const { git } = fakeGit({});
	const seen: string[] = [];
	const exec = async (script: string) => {
		seen.push(script);
		return { code: 0, stdout: "ok", stderr: "" };
	};
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	await provider("bun test");
	await provider("bun run other-gate");
	expect(seen).toEqual(["bun test", "bun run other-gate"]);
});

test("a failing base run returns the extracted failure identities", async () => {
	const { git } = fakeGit({});
	const exec = async () => ({
		code: 1,
		stdout: "1 pass\n2 fail\n(fail) tests/foo.test.ts > adds two numbers\n(fail) tests/bar.test.ts > subtracts\n",
		stderr: "",
	});
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toBeNull();
	expect(result!.failures).toEqual(["tests/bar.test.ts > subtracts", "tests/foo.test.ts > adds two numbers"]);
});

test("a base run that never executed (exit 127, command not found) is classified unrunnable, not as zero failures", async () => {
	const { git } = fakeGit({});
	const exec = async () => ({ code: 127, stdout: "", stderr: "bash: bun: command not found" });
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toBeTruthy();
	// Callers must gate on `unrunnable` FIRST, never trust `failures` alone once it's set.
});

test("a base run reporting zero tests executed is classified unrunnable", async () => {
	const { git } = fakeGit({});
	const exec = async () => ({ code: 1, stdout: "Ran 0 tests across 0 files\n", stderr: "" });
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toBeTruthy();
});

test("a base run that DID execute tests (N pass marker present) is judged on its failures even if the output also mentions 'command not found'", async () => {
	const { git } = fakeGit({});
	const exec = async () => ({
		code: 1,
		stdout: "3 pass\n1 fail\n(fail) tests/cli.test.ts > reports command not found errors\n",
		stderr: "",
	});
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toBeNull();
	expect(result!.failures).toEqual(["tests/cli.test.ts > reports command not found errors"]);
});

test("git worktree add failing returns an unrunnable result instead of throwing, and never calls exec", async () => {
	const { git } = fakeGit({
		worktreeAdd: { code: 128, stdout: "", stderr: "fatal: '/fake/scratch-dir' already exists" },
	});
	let execCalled = false;
	const exec = async () => {
		execCalled = true;
		return { code: 0, stdout: "", stderr: "" };
	};
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result).not.toBeNull();
	expect(result!.unrunnable).toContain("could not create base worktree");
	expect(result!.unrunnable).toContain("already exists");
	expect(result!.failures).toEqual([]);
	expect(execCalled).toBe(false); // never ran the gate against a worktree that doesn't exist
});

test("a thrown error anywhere in the base run degrades to an unrunnable result, never an uncaught rejection", async () => {
	const { git } = fakeGit({});
	const exec = async () => {
		throw new Error("spawn ENOMEM");
	};
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));
	const result = await provider("bun test");
	expect(result).not.toBeNull();
	expect(result!.unrunnable).toContain("base run threw");
	expect(result!.unrunnable).toContain("spawn ENOMEM");
});

test("cleanup (worktree remove) failing does not throw out of the provider and still returns the result", async () => {
	const { git } = fakeGit({
		worktreeRemove: { code: 1, stdout: "", stderr: "fatal: could not remove worktree" },
	});
	const exec = async () => ({ code: 0, stdout: "ok", stderr: "" });
	const logs: string[] = [];
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec, log: (msg) => logs.push(msg) }));
	const result = await provider("bun test");
	expect(result!.unrunnable).toBeNull();
	expect(result!.failures).toEqual([]);
	expect(logs.some((l) => l.includes("worktree remove failed"))).toBe(true);
});
