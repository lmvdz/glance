/**
 * Unit tests for `makeBaselineFailureProvider` (postmortem-gate-fixes): the per-unit verify
 * gate's base-diff provider. Everything here is FAKE (git + exec) so it never spawns a real
 * process or touches a real repo — the point is to prove the base-ref resolution, scratch
 * worktree lifecycle, memoization, and fail-closed error paths, independent of git/bun.
 */

import { expect, test } from "bun:test";
import { type BaselineProviderDeps, makeBaselineFailureProvider } from "../src/workflow/verify-baseline.ts";

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

function fakeGit(handlers: {
	symbolicRef?: Run;
	revParseVerify?: (branch: string) => Run;
	mergeBase?: Run;
	revParseHead?: Run;
	worktreeAdd?: Run;
	worktreeRemove?: Run;
}) {
	const calls: string[][] = [];
	const git: BaselineProviderDeps["git"] = async (args) => {
		calls.push(args);
		if (args[0] === "symbolic-ref") return handlers.symbolicRef ?? { code: 1, stdout: "", stderr: "not a symbolic ref" };
		if (args[0] === "rev-parse" && args[1] === "--verify") return handlers.revParseVerify?.(args[2]!) ?? { code: 1, stdout: "", stderr: "unknown revision" };
		if (args[0] === "merge-base") return handlers.mergeBase ?? { code: 0, stdout: "deadbeef01234567\n", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return handlers.revParseHead ?? { code: 0, stdout: "0000000000000000\n", stderr: "" };
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

test("resolves the base ref via merge-base against origin/HEAD's target, and creates + removes a detached scratch worktree", async () => {
	const { git, calls } = fakeGit({
		symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" },
		mergeBase: { code: 0, stdout: "abc123def456\n", stderr: "" },
	});
	const exec = async (_script: string, cwd: string) => ({ code: 0, stdout: "ok", stderr: "" });
	const provider = makeBaselineFailureProvider(baseDeps({ git, exec }));

	const result = await provider("bun test");
	expect(result).not.toBeNull();
	expect(result!.baseRef).toBe("abc123def456");
	expect(result!.failures).toEqual([]);
	expect(result!.unrunnable).toBeNull();

	// merge-base was resolved against the ref stripped from origin/HEAD.
	expect(calls).toContainEqual(["symbolic-ref", "refs/remotes/origin/HEAD"]);
	expect(calls).toContainEqual(["merge-base", "HEAD", "main"]);
	// Scratch worktree lifecycle: add --detach <tmp> <baseSha>, later remove --force <tmp>.
	expect(calls).toContainEqual(["worktree", "add", "--detach", "/fake/scratch-dir", "abc123def456"]);
	expect(calls).toContainEqual(["worktree", "remove", "--force", "/fake/scratch-dir"]);
});

test("falls back to main/master rev-parse --verify when origin/HEAD is not resolvable", async () => {
	const { git, calls } = fakeGit({
		symbolicRef: { code: 1, stdout: "", stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref" },
		revParseVerify: (branch) => (branch === "main" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
		mergeBase: { code: 0, stdout: "cafef00d\n", stderr: "" },
	});
	const provider = makeBaselineFailureProvider(baseDeps({ git }));
	const result = await provider("bun test");
	expect(result!.baseRef).toBe("cafef00d");
	expect(calls).toContainEqual(["merge-base", "HEAD", "main"]);
});

test("falls back to HEAD when merge-base fails (e.g. no default branch resolvable at all)", async () => {
	const { git } = fakeGit({
		symbolicRef: { code: 1, stdout: "", stderr: "no ref" },
		revParseVerify: () => ({ code: 1, stdout: "", stderr: "no such branch" }),
		revParseHead: { code: 0, stdout: "feedface9999\n", stderr: "" },
	});
	const provider = makeBaselineFailureProvider(baseDeps({ git }));
	const result = await provider("bun test");
	expect(result!.baseRef).toBe("feedface9999");
});

test("memoizes: calling the provider twice runs the base exec exactly once", async () => {
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
	expect(result!.unrunnable).toContain("could not execute");
	// Callers must gate on `unrunnable` FIRST, never trust `failures` alone once it's set — the field
	// is still populated (matching the spec's "always extract" step) but is not a reliable signal here.
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
