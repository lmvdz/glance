/**
 * Deterministic suite — no model tokens spent.
 *
 * Exercises worktree ops, the pure board renderer, the RPC transport
 * (get_state + bash only), and the manager lifecycle (spawn → idle → remove).
 * The model-driven end-to-end check lives in the README (needs auth + tokens).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcAgent } from "../src/rpc-agent.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { buildBoard, type BoardState } from "../src/tui.ts";
import type { AgentDTO } from "../src/types.ts";
import { addWorktree, removeWorktree, repoRoot, worktreeStatus } from "../src/worktree.ts";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const tmps: string[] = [];

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-repo-"));
	tmps.push(repo);
	const git = async (args: string[]) => {
		const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
		await p.exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

// ── worktree ─────────────────────────────────────────────────────────────────

test("addWorktree creates a branch + worktree, status reads it, remove cleans up", async () => {
	const repo = await makeRepo();
	const wt = await addWorktree({ repo, branch: "squad/test" });
	tmps.push(wt.worktree);
	expect(await fs.exists(wt.worktree)).toBe(true);
	expect(wt.branch).toBe("squad/test");
	expect(wt.repo).toBe(await repoRoot(repo));

	const status = await worktreeStatus(wt.worktree);
	expect(status.branch).toBe("squad/test");

	await removeWorktree(repo, wt.worktree);
	expect(await fs.exists(wt.worktree)).toBe(false);
});

test("addWorktree reuses an existing worktree path idempotently", async () => {
	const repo = await makeRepo();
	const a = await addWorktree({ repo, branch: "squad/reuse" });
	tmps.push(a.worktree);
	const b = await addWorktree({ repo, branch: "squad/reuse" });
	expect(b.worktree).toBe(a.worktree);
	await removeWorktree(repo, a.worktree);
});

test("repoRoot throws on a non-repo", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-nonrepo-"));
	tmps.push(dir);
	await expect(repoRoot(dir)).rejects.toThrow();
});

// ── board renderer (pure) ────────────────────────────────────────────────────

function dto(o: Partial<AgentDTO>): AgentDTO {
	return {
		id: o.id ?? "x",
		name: o.name ?? "x",
		status: o.status ?? "idle",
		repo: "/r",
		worktree: `/wt/${o.name ?? "x"}`,
		branch: `squad/${o.name ?? "x"}`,
		approvalMode: "write",
		pending: o.pending ?? [],
		lastActivity: Date.now(),
		messageCount: 0,
		...o,
	};
}

function board(over: Partial<BoardState> = {}): BoardState {
	return {
		agents: [
			dto({ id: "a", name: "alpha", status: "working", activity: "edit: auth.ts", contextPct: 0.12 }),
			dto({
				id: "b",
				name: "bravo",
				status: "input",
				pending: [{ id: "p1", source: "ui", kind: "confirm", title: "Delete?", message: "old.ts", createdAt: 0 }],
			}),
			dto({ id: "c", name: "charlie", status: "idle" }),
		],
		selectedId: "b",
		transcript: [
			{ kind: "user", text: "do it", ts: 0 },
			{ kind: "assistant", text: "working on it", ts: 0 },
		],
		mode: "nav",
		draft: "",
		draftTarget: "prompt",
		width: 100,
		height: 24,
		connected: true,
		...over,
	};
}

test("buildBoard emits exactly height lines, none over width", () => {
	const lines = buildBoard(board());
	expect(lines.length).toBe(24);
	for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
});

test("buildBoard surfaces needs-input, pending detail, and transcript", () => {
	const plain = buildBoard(board()).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
	expect(plain).toContain("need input");
	expect(plain).toContain("alpha");
	expect(plain).toContain("Delete?");
	expect(plain).toContain("working on it");
});

test("buildBoard input mode renders the draft line", () => {
	const plain = buildBoard(board({ mode: "input", draft: "hello there" }))
		.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");
	expect(plain).toContain("hello there");
});

// ── RPC transport (real omp, no model tokens) ────────────────────────────────

test(
	"RpcAgent: spawn → ready → get_state → bash, then clean stop",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-rpc-"));
		tmps.push(dir);
		const a = new RpcAgent({ cwd: dir, approvalMode: "yolo", thinking: "minimal" });
		await a.start(25_000);
		expect(a.isReady).toBe(true);
		const state = await a.getState();
		expect(typeof state.sessionId).toBe("string");
		const res = (await a.bash("echo squad-test-OK")) as { exitCode: number; output: string };
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("squad-test-OK");
		await a.stop();
		expect(a.isAlive).toBe(false);
	},
	30_000,
);

// ── manager lifecycle (no task → no model turn) ──────────────────────────────

test(
	"SquadManager: create (no task) reaches idle, lists, removes + cleans worktree",
	async () => {
		const repo = await makeRepo();
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-state-"));
		tmps.push(stateDir);
		const mgr = new SquadManager({ stateDir });
		await mgr.start();
		const created = await mgr.create({ name: "alpha", repo, approvalMode: "yolo" });
		tmps.push(created.worktree);

		expect(mgr.list().length).toBe(1);
		expect(["idle", "starting"]).toContain(mgr.list()[0].status);
		expect(await fs.exists(path.join(stateDir, "state.json"))).toBe(true);

		await mgr.applyCommand({ type: "remove", id: created.id, deleteWorktree: true });
		expect(mgr.list().length).toBe(0);
		expect(await fs.exists(created.worktree)).toBe(false);
		await mgr.stop();
	},
	30_000,
);
