/**
 * The fail-open sentinel bug: `aheadOfBase` (land-mode.ts) returns -1 when the underlying
 * `git rev-list --count` fails — an in-band error sentinel on a numeric channel. Every "does this
 * branch have unlanded work?" consumer used to ask a bare `> 0`, and `-1 > 0` is `false`, so a
 * transient git fault read as "no unlanded work". Concretely: `orchestrator.ts:220`'s
 * `if (!(await this.deps.agentHasWork(a.id))) continue;` would silently SKIP landing a unit whose
 * only crime was a flaky git call, with no escalation, no retry, no visible failure — the same
 * "fault reads as nothing-to-do" interlock shape this codebase has been bitten by before.
 *
 * This file drives a REAL git binary shimmed to fail exactly the `rev-list --count` call
 * `aheadOfBase` makes, matching `land-stale-gate.test.ts`'s PATH-shim convention (delegate every
 * other invocation to the real binary — a return-value stub would prove nothing about the actual
 * fault path). It proves:
 *   1. (repro) `agentHasUnlandedWork` returns TRUE, not false, when the git read fails.
 *   2. A genuine ahead=0 (real landed branch, real git, no shim) still reads "no unlanded work".
 *   3. A genuine ahead>0 (real unlanded commit, real git, no shim) still reads "has unlanded work".
 *
 * The worktree-reaper's own "unknown ahead-count is never merged" invariant is already covered
 * (unaffected by this fix — `selectReapable`'s check is exact-equality, see worktree-reaper.ts's
 * doc comment) by `tests/worktree-reaper.test.ts`'s "failed ahead-count (-1) does not read as
 * merged" test — not duplicated here.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const { SquadManager } = await import("../src/squad-manager.ts");
const { SubagentTracker } = await import("../src/subagents.ts");
import type { AgentDTO, PersistedAgent } from "../src/types.ts";

class TestManager extends SquadManager {
	callAgentHasUnlandedWork(id: string): Promise<boolean> {
		return this.agentHasUnlandedWork(id);
	}
}

function seed(mgr: InstanceType<typeof TestManager>, id: string, over: Partial<PersistedAgent>): void {
	const repo = over.repo!;
	const worktree = over.worktree!;
	const branch = over.branch!;
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo,
		worktree,
		branch,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, branch, approvalMode: "yolo", ...over };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

const ENV_KEYS = ["OMP_SQUAD_LAND_MODE", "OMP_SQUAD_LAND_MODE_TTL_MS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

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
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function commit(repo: string, file: string, content: string, message: string): Promise<void> {
	await fs.writeFile(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", message);
}

/** Resolved once, before any test shims PATH — the real `git` binary the shim delegates to. */
const REAL_GIT = Bun.which("git") ?? "/usr/bin/git";

/** Shims `git` on PATH so `rev-list --count HEAD..<branch>` — exactly the call `aheadOfBase` makes
 *  in local mode — fails with a transient error, while every other git invocation (init, commit,
 *  worktree add, status, etc.) delegates unchanged to the real binary. Mirrors
 *  land-stale-gate.test.ts's shim convention. Returns a restore function. */
async function shimRevListFailure(): Promise<() => void> {
	const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-shim-ahead-"));
	tmps.push(shimDir);
	await fs.writeFile(
		path.join(shimDir, "git"),
		`#!/usr/bin/env bash\nargs=("$@")\njoined=" \${args[*]} "\nif [[ "$joined" == *" rev-list "* && "$joined" == *" --count "* && "$joined" == *"HEAD.."* ]]; then\n  echo "fatal: simulated transient git failure (test probe hiccup)" >&2\n  exit 1\nfi\nexec ${REAL_GIT} "$@"\n`,
		{ mode: 0o755 },
	);
	const savedPath = process.env.PATH;
	process.env.PATH = `${shimDir}:${savedPath}`;
	return () => {
		process.env.PATH = savedPath;
	};
}

// ── 1. repro: a git fault must NOT read as "no unlanded work" ──────────────────────────────────

test("agentHasUnlandedWork: a git rev-list FAULT reads as unlanded work (true), never as clean (false)", async () => {
	process.env.OMP_SQUAD_LAND_MODE = "local"; // bypass the gh probe entirely — no origin needed

	const repo = await tmpDir("aob-unknown-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "branch", "squad/fault");

	const wtParent = await tmpDir("aob-unknown-wt-");
	const worktree = path.join(wtParent, "squad-fault");
	await git(repo, "worktree", "add", "-q", worktree, "squad/fault");
	// A genuinely unlanded commit — if the fault-handling regresses back to "-1 reads as clean", this
	// would be the commit silently dropped from landing.
	await commit(worktree, "b.txt", "b\n", "one unlanded commit the fault must not hide");

	const restore = await shimRevListFailure();
	let has: boolean;
	try {
		const mgr = new TestManager({ stateDir: await tmpDir("aob-unknown-mgr-") });
		seed(mgr, "a1", { repo, worktree, branch: "squad/fault" });
		has = await mgr.callAgentHasUnlandedWork("a1");
	} finally {
		restore();
	}

	// Before the fix: aheadOfBase returns -1 on the shimmed failure, `-1 > 0` is false ⇒ agentHasUnlandedWork
	// returned false here — a fault silently read as "nothing to land" (orchestrator.ts:220 would then skip
	// this unit's land forever, with no escalation). After the fix: unknown ⇒ assume work exists ⇒ true.
	expect(has).toBe(true);
});

// ── 2 & 3. genuine 0 and genuine >0 are unaffected by the fix ───────────────────────────────────

test("agentHasUnlandedWork: a genuinely landed branch (real ahead=0, real git) still reads no unlanded work", async () => {
	process.env.OMP_SQUAD_LAND_MODE = "local";

	const repo = await tmpDir("aob-genuine0-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "branch", "squad/landed");

	const wtParent = await tmpDir("aob-genuine0-wt-");
	const worktree = path.join(wtParent, "squad-landed");
	await git(repo, "worktree", "add", "-q", worktree, "squad/landed");
	await commit(worktree, "b.txt", "b\n", "work");
	await git(repo, "merge", "-q", "--no-ff", "-m", "merge squad/landed", "squad/landed");

	const mgr = new TestManager({ stateDir: await tmpDir("aob-genuine0-mgr-") });
	seed(mgr, "a2", { repo, worktree, branch: "squad/landed" });
	expect(await mgr.callAgentHasUnlandedWork("a2")).toBe(false);
});

test("agentHasUnlandedWork: a genuinely unlanded branch (real ahead>0, real git) still reads has unlanded work", async () => {
	process.env.OMP_SQUAD_LAND_MODE = "local";

	const repo = await tmpDir("aob-genuinepos-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "branch", "squad/unlanded");

	const wtParent = await tmpDir("aob-genuinepos-wt-");
	const worktree = path.join(wtParent, "squad-unlanded");
	await git(repo, "worktree", "add", "-q", worktree, "squad/unlanded");
	await commit(worktree, "b.txt", "b\n", "unlanded work");

	const mgr = new TestManager({ stateDir: await tmpDir("aob-genuinepos-mgr-") });
	seed(mgr, "a3", { repo, worktree, branch: "squad/unlanded" });
	expect(await mgr.callAgentHasUnlandedWork("a3")).toBe(true);
});
