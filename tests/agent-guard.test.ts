/**
 * Agent guardrails — the deny policy that fences a yolo agent into its worktree. Tests the two
 * jobs: block daemon/host control + process-killing shell commands (the things that took the fleet
 * down this session), and block file edits that escape the worktree — while leaving ordinary
 * build/test/git/read work untouched (false positives would cripple the agent).
 */

import { expect, test } from "bun:test";
import { escapesWorktree, screenToolCall } from "../src/agent-guard.ts";

const WT = "/home/u/.omp/squad/worktrees/omp-squad-squad-ompsq-9-abc";
const sh = (command: string) => screenToolCall("bash", { command }, WT);

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

test("blocks process killing that can take down the daemon/siblings", () => {
	for (const c of ["pkill bun", "killall node", "kill -9 1234", "kill -KILL 5", "kill 9999 # the bun daemon"]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("blocks touching daemon control files (launcher, lock, admin token)", () => {
	for (const c of ["cat ~/.omp/squad/access-token", "echo x > ~/.omp/squad/up.sh", "rm ~/.omp/squad/daemon.lock"]) {
		expect(sh(c)?.block).toBe(true);
	}
});

test("ALLOWS ordinary agent shell work", () => {
	for (const c of ["bun run check", "bun test", "git add -A && git commit -m wip", "cat up.sh", "less README.md", "ls ~/.omp/squad", "grep -r foo src", "node scripts/build.js", "kill -0 $$  # liveness probe of own shell"]) {
		expect(sh(c)).toBeUndefined();
	}
});

test("blocks edit/write escaping the worktree (the shared main checkout)", () => {
	// absolute path into the main checkout
	expect(screenToolCall("edit", { input: "[/home/u/sui/omp-squad/src/auth.ts#1A2B]\nSWAP 1.=1:\n+x" }, WT)?.block).toBe(true);
	// relative path climbing out
	expect(screenToolCall("write", { path: "../../../sui/omp-squad/src/x.ts" }, WT)?.block).toBe(true);
	expect(screenToolCall("write", { path: "/etc/passwd" }, WT)?.block).toBe(true);
});

test("ALLOWS edit/write inside the worktree", () => {
	expect(screenToolCall("write", { path: "src/x.ts" }, WT)).toBeUndefined();
	expect(screenToolCall("write", { path: `${WT}/src/x.ts` }, WT)).toBeUndefined();
	expect(screenToolCall("edit", { input: `[${WT}/src/auth.ts#1A2B]\nSWAP 1.=1:\n+x` }, WT)).toBeUndefined();
	expect(screenToolCall("edit", { input: "[src/auth.ts#1A2B]\nSWAP 1.=1:\n+x" }, WT)).toBeUndefined();
});

test("escapesWorktree handles the worktree root and nested paths", () => {
	expect(escapesWorktree(["src/a.ts", "deep/nested/b.ts"], WT)).toBeUndefined();
	expect(escapesWorktree(["."], WT)).toBeUndefined();
	expect(escapesWorktree(["../sibling/x"], WT)).toBe("../sibling/x");
});

// ── Wiring: the hook the daemon actually loads (`omp -e lease-hook.ts`) must enforce the guard on
//    every tool call. Construct the hook with a fake ExtensionAPI, capture its tool_call handler,
//    and prove a forbidden command is blocked while normal work passes — same block path the live
//    yolo agents respect. ──
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
	expect(await toolHandler!({ toolName: "bash", input: { command: "bun test" } }, ctx)).toBeUndefined();
});
