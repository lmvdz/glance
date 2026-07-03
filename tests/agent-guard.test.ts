/**
 * Agent guardrails — the deny policy that fences a yolo agent into its worktree. Three jobs:
 * block daemon/host control + process-killing shell commands, block any reference to a protected
 * tree (the main checkout / the glance state dir — ~/.glance or legacy ~/.omp/squad) by absolute
 * path — incl. bash writes the file-tool fence
 * can't see — and block file edits that escape the worktree. Ordinary build/test/git/read work and
 * /tmp scratch stay untouched (false positives would cripple the agent).
 */

import { expect, test } from "bun:test";
import { escapesWorktree, screenToolCall, type GuardContext } from "../src/agent-guard.ts";

const HOME = "/home/u";
const MAIN = "/home/u/sui/omp-squad";
const WT = "/home/u/.omp/squad/worktrees/omp-squad-squad-ompsq-9-abc";
const CTX: GuardContext = { worktree: WT, protectedRoots: [`${HOME}/.omp/squad`, MAIN], home: HOME };
const sh = (command: string) => screenToolCall("bash", { command }, CTX);

test("blocks daemon lifecycle control", () => {
	for (const c of ["omp-squad up --no-tui --port 7878", "omp-squad down", "omp-squad restart", "x && omp-squad stop"]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("blocks launching the daemon via up.sh (incl. watchdog loops)", () => {
	for (const c of ["./up.sh", "bash $HOME/.omp/squad/up.sh", "nohup ./up.sh &", "while true; do omp-squad list || bash ~/.omp/squad/up.sh; sleep 8; done"]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("blocks process killing — mass kill, SIGKILL, by name, and by numeric pid", () => {
	for (const c of ["pkill bun", "killall node", "kill -9 1234", "kill -KILL 5", "kill 9999", "kill -15 4321", "kill $(pgrep bun)"]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("ALLOWS killing your OWN processes by job spec / variable, and -0 probes of your shell", () => {
	for (const c of ["kill $!", "kill %1", "kill -0 $$", "kill $SERVER_PID"]) {
		expect(sh(c)).toBeUndefined();
	}
});

test("blocks touching daemon control files (launcher, lock, admin token)", () => {
	for (const c of ["cat ~/.omp/squad/access-token", "echo x > ~/.omp/squad/up.sh", "rm ~/.omp/squad/daemon.lock"]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("blocks the same control files under the new ~/.glance state dir", () => {
	for (const c of ["cat ~/.glance/access-token", "echo x > ~/.glance/up.sh", "rm ~/.glance/daemon.lock", "bash $HOME/.glance/up.sh"]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("protected-tree fence covers a ~/.glance root too (protectedStateRoots wiring)", () => {
	const ctx: GuardContext = { worktree: WT, protectedRoots: [`${HOME}/.glance`, `${HOME}/.omp/squad`, MAIN], home: HOME };
	expect(screenToolCall("bash", { command: `cat ${HOME}/.glance/state.json` }, ctx)?.block).toBe(true);
	expect(screenToolCall("bash", { command: "echo scratch > /tmp/out.txt" }, ctx)).toBeUndefined();
});

test("blocks bash that reaches into a protected tree by absolute path (the gap the file-tool fence misses)", () => {
	for (const c of [
		`echo broken > ${MAIN}/src/auth.ts`, // redirect into the main checkout
		`sed -i 's/a/b/' ${MAIN}/src/auth.ts`, // in-place edit of main
		`git -C ${MAIN} commit -am x`, // git in the main checkout
		`cat ${MAIN}/src/secret.ts`, // even reading main by abspath
		`cat ${HOME}/.omp/squad/state.json`, // squad state
		`cp ./x.ts ${HOME}/.omp/squad/worktrees/omp-squad-squad-ompsq-8-zzz/x.ts`, // into a SIBLING worktree
	]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("ALLOWS ordinary shell work + scratch outside any protected tree", () => {
	for (const c of [
		"bun run check", "bun test", "git add -A && git commit -m wip", "cat up.sh", "grep -r foo src",
		"echo scratch > /tmp/out.txt", "cat /etc/hosts", "ls /usr/lib", "node scripts/build.js",
		`cat ${WT}/src/x.ts`, // the agent's OWN worktree by abspath is fine
		`sed -i 's/a/b/' ${WT}/src/x.ts`, // in-place edit of its own worktree is fine
	]) {
		expect(sh(c)).toBeUndefined();
	}
});

test("blocks edit/write escaping the worktree (the shared main checkout)", () => {
	expect(screenToolCall("edit", { input: `[${MAIN}/src/auth.ts#1A2B]\nSWAP 1.=1:\n+x` }, CTX)?.block).toBe(true);
	expect(screenToolCall("write", { path: "../../../sui/omp-squad/src/x.ts" }, CTX)?.block).toBe(true);
	expect(screenToolCall("write", { path: "/etc/passwd" }, CTX)?.block).toBe(true);
});

test("ALLOWS edit/write inside the worktree", () => {
	expect(screenToolCall("write", { path: "src/x.ts" }, CTX)).toBeUndefined();
	expect(screenToolCall("write", { path: `${WT}/src/x.ts` }, CTX)).toBeUndefined();
	expect(screenToolCall("edit", { input: "[src/auth.ts#1A2B]\nSWAP 1.=1:\n+x" }, CTX)).toBeUndefined();
});

test("escapesWorktree handles the worktree root and nested paths", () => {
	expect(escapesWorktree(["src/a.ts", "deep/nested/b.ts"], WT)).toBeUndefined();
	expect(escapesWorktree(["."], WT)).toBeUndefined();
	expect(escapesWorktree(["../sibling/x"], WT)).toBe("../sibling/x");
});

// ── Wiring: the hook the daemon actually loads (`omp -e lease-hook.ts`) must enforce the guard on
//    every tool call. Construct the hook with a fake ExtensionAPI, capture its tool_call handler,
//    and prove a forbidden command is blocked while normal work passes — same block path the live
//    yolo agents respect. (protectedRoots is empty here since session_start isn't fired; the
//    command-pattern rules still fire, which is what this asserts.) ──
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import leaseHook from "../src/lease-hook.ts";

type ToolHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: { hasUI: boolean },
) => Promise<{ block?: boolean; reason?: string } | undefined>;

test("lease-hook enforces the guard end-to-end (forbidden blocked, normal allowed)", async () => {
	let toolHandler: ToolHandler | undefined;
	const pi = {
		on(name: string, fn: (...a: unknown[]) => unknown) {
			if (name === "tool_call") toolHandler = fn as unknown as ToolHandler;
		},
	};
	leaseHook(pi as unknown as ExtensionAPI);
	expect(toolHandler).toBeDefined();
	const ctx = { hasUI: false };
	expect((await toolHandler!({ toolName: "bash", input: { command: "nohup ./up.sh &" } }, ctx))?.block).toBe(true);
	expect((await toolHandler!({ toolName: "bash", input: { command: "pkill bun" } }, ctx))?.block).toBe(true);
	expect((await toolHandler!({ toolName: "bash", input: { command: "kill 4242" } }, ctx))?.block).toBe(true);
	expect(await toolHandler!({ toolName: "bash", input: { command: "bun test" } }, ctx)).toBeUndefined();
});
