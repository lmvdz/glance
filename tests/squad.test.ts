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
import { TemplateArchitect } from "../src/architect.ts";
import { FlueServiceDriver } from "../src/flue-service-driver.ts";
import type { CommissionSpec } from "../src/types.ts";
import { validateWorker } from "../src/validate.ts";
import { generateWorkerFiles } from "../src/worker-template.ts";
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
		kind: o.kind ?? "omp-operator",
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
		view: "list",
		draft: "",
		scroll: 0,
		width: 100,
		height: 24,
		connected: true,
		cwd: "/home/me/project",
		...over,
	};
}

test("buildBoard emits exactly height lines, none over width (both views)", () => {
	for (const view of ["list", "agent"] as const) {
		const lines = buildBoard(board({ view }));
		expect(lines.length).toBe(24);
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
	}
});

test("list view shows roster, needs-input, and the new-agent composer", () => {
	const plain = buildBoard(board({ view: "list" })).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
	expect(plain).toContain("need input");
	expect(plain).toContain("alpha");
	expect(plain).toContain("new agent in");
	expect(plain).toContain("new›");
});

test("agent view shows transcript, pending detail, and the draft", () => {
	const plain = buildBoard(board({ view: "agent", draft: "hello there" }))
		.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");
	expect(plain).toContain("working on it");
	expect(plain).toContain("Delete?");
	expect(plain).toContain("hello there");
	expect(plain).toContain("← back");
});

test("buildBoard nests fan-out branches under their workflow parent, with a kind glyph", () => {
	const lines = buildBoard(
		board({
			view: "list",
			selectedId: "wf",
			agents: [
				dto({ id: "wf", name: "feature", kind: "workflow", status: "working" }),
				dto({ id: "c1", name: "branch-a", parentId: "wf", status: "working" }),
				dto({ id: "c2", name: "branch-b", parentId: "wf", status: "idle" }),
				dto({ id: "op", name: "solo", status: "idle" }),
			],
		}),
	).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const wfLine = lines.findIndex((l) => l.includes("feature"));
	expect(wfLine).toBeGreaterThanOrEqual(0);
	expect(lines[wfLine + 1]).toContain("branch-a"); // children immediately follow the parent
	expect(lines[wfLine + 2]).toContain("branch-b");
	expect(lines[wfLine + 1]).toContain("└"); // and are indented
	expect(lines.some((l) => l.includes("⚙"))).toBe(true); // workflow kind glyph rendered
});

// ── RPC transport (real omp, no model tokens) ────────────────────────────────

test(
	"RpcAgent: spawn host → ready → get_state → bash; detach leaves host alive; a new client re-attaches",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-rpc-"));
		tmps.push(dir);
		const id = `rpc-test-${Date.now().toString(36)}`;
		const a = new RpcAgent({ id, cwd: dir, approvalMode: "yolo", thinking: "minimal" });
		await a.start(25_000);
		expect(a.isReady).toBe(true);
		const state = await a.getState();
		expect(typeof state.sessionId).toBe("string");
		const res = (await a.bash("echo squad-test-OK")) as { exitCode: number; output: string };
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("squad-test-OK");

		// Detach: the daemon-side client goes away, but the detached host keeps omp alive.
		a.detach();
		await Bun.sleep(200);
		// A fresh client (same id → same socket) re-attaches to the SAME live session.
		const b = new RpcAgent({ id, cwd: dir, approvalMode: "yolo", thinking: "minimal" });
		await b.start(10_000);
		expect(b.isReady).toBe(true);
		const state2 = await b.getState();
		expect(state2.sessionId).toBe(state.sessionId); // same omp session survived

		await b.stop(); // terminate the host
		await Bun.sleep(200);
		expect(b.isAlive).toBe(false);
	},
	40_000,
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

// ── commissioning loop (deterministic — no model, no network) ────────────────

const EMAIL_BODY = `const text = String(payload.text ?? "");
const emails = text.match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/g) ?? [];
return { emails, count: emails.length };`;

function emailSpec(): CommissionSpec {
	return {
		name: "extract-emails",
		purpose: "Extract email addresses from text.",
		model: false,
		capabilities: [],
		workflowBody: EMAIL_BODY,
		accept: { payload: { text: "a@x.io b@y.org" }, expect: { count: 2 } },
	};
}

test("commission: TemplateArchitect authors a worker, lint gate passes, manager onboards a flue-service member", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-state-"));
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-worker-"));
	tmps.push(stateDir, dir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();

	const result = await mgr.commission(emailSpec(), { architect: new TemplateArchitect(), dir });
	expect(result.ok).toBe(true);
	expect(result.report.checks.find((c) => c.name === "lint")?.status).toBe("pass");
	// No flue toolchain installed in the temp worker → acceptance is skipped, not failed.
	expect(result.report.checks.find((c) => c.name === "acceptance")?.status).toBe("skip");

	const member = mgr.list().find((a) => a.name === "extract-emails");
	expect(member?.kind).toBe("flue-service");
	expect(member?.status).toBe("idle");
	expect(member?.verified).toBe(false);
	expect(await fs.exists(path.join(dir, ".flue", "workflows", "extract-emails.ts"))).toBe(true);
	expect(await fs.exists(path.join(dir, "flue.worker.json"))).toBe(true);
	await mgr.stop();
});

test("commission: a candidate failing the lint gate is rejected, nothing onboarded", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-state-"));
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-worker-"));
	tmps.push(stateDir, dir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();

	// A model string that is not a provider/model specifier → lint fails the candidate.
	const spec: CommissionSpec = { name: "bad-worker", purpose: "broken", model: "notaspecifier" };
	const result = await mgr.commission(spec, { architect: new TemplateArchitect(), dir });
	expect(result.ok).toBe(false);
	expect(result.report.checks.find((c) => c.name === "lint")?.status).toBe("fail");
	expect(mgr.list().length).toBe(0);
	await mgr.stop();
});

test("commission: an onboarded flue-service member persists and is restored without re-validation", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-state-"));
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-worker-"));
	tmps.push(stateDir, dir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	await mgr.commission(emailSpec(), { architect: new TemplateArchitect(), dir });
	await mgr.stop();

	const persisted = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as {
		agents: { name: string; kind?: string; flue?: { workflow?: string } }[];
	};
	const saved = persisted.agents.find((a) => a.name === "extract-emails");
	expect(saved?.kind).toBe("flue-service");
	expect(saved?.flue?.workflow).toBe("extract-emails");

	const restored = new SquadManager({ stateDir });
	const n = await restored.loadPersisted();
	expect(n).toBe(1);
	const member = restored.list().find((a) => a.name === "extract-emails");
	expect(member?.kind).toBe("flue-service");
	expect(member?.status).toBe("idle");
	await restored.stop();
});

test("FlueServiceDriver: invokes a worker and emits omp-shaped frames around the result", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-fixture-"));
	tmps.push(dir);
	const fixture = path.join(dir, "fixture.ts");
	await fs.writeFile(
		fixture,
		`const i = process.argv.indexOf("--payload");\nconst payload = i >= 0 ? JSON.parse(process.argv[i + 1]) : {};\nconsole.log("banner: running");\nconsole.log(JSON.stringify({ ok: true, echo: payload }, null, 2));\n`,
	);
	const driver = new FlueServiceDriver({
		dir,
		workflow: "echo",
		target: "node",
		buildInvocation: (payload) => ({ bin: "bun", args: [fixture, "--payload", JSON.stringify(payload)] }),
	});
	const frames: string[] = [];
	driver.on("event", (f: { type?: string }) => {
		if (typeof f.type === "string") frames.push(f.type);
	});
	await driver.start();
	expect(driver.isReady).toBe(true);
	await driver.prompt('{"text":"hi"}');
	expect(frames).toEqual(["agent_start", "tool_execution_start", "message_update", "message_end", "agent_end"]);
	expect(driver.lastResult).toEqual({ ok: true, echo: { text: "hi" } });
	await driver.stop();
});

// ── ponytail gate (lazy-senior-dev acceptance dimension) ─────────────────────

async function writeWorker(spec: CommissionSpec): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-pony-"));
	tmps.push(dir);
	for (const f of generateWorkerFiles(spec)) {
		const target = path.join(dir, f.path);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, f.content);
	}
	return dir;
}

test("ponytail gate: a minimal template worker passes the lazy-dev check", async () => {
	const dir = await writeWorker(emailSpec());
	const report = await validateWorker(dir, emailSpec());
	expect(report.checks.find((c) => c.name === "ponytail")?.status).toBe("pass");
});

test("ponytail gate: an unrequested dependency fails the gate (report.ok=false → commission onboards nothing)", async () => {
	const spec = emailSpec();
	const dir = await writeWorker(spec);
	// The architect reached for a dependency the pinned skeleton already covers.
	const pkgPath = path.join(dir, "package.json");
	const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as { dependencies: Record<string, string> };
	pkg.dependencies.lodash = "^4.17.21";
	await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));

	const report = await validateWorker(dir, spec);
	const check = report.checks.find((c) => c.name === "ponytail");
	expect(check?.status).toBe("fail");
	expect(check?.detail).toContain("lodash");
	expect(report.ok).toBe(false);
});

test("ponytail gate: an over-built workflow fails the size budget", async () => {
	const filler = Array.from({ length: 90 }, (_, i) => `const x${i} = ${i};`).join("\n");
	const spec: CommissionSpec = { ...emailSpec(), workflowBody: `${filler}\nreturn { emails: [], count: 0 };` };
	const dir = await writeWorker(spec);
	const report = await validateWorker(dir, spec);
	const check = report.checks.find((c) => c.name === "ponytail");
	expect(check?.status).toBe("fail");
	expect(check?.detail).toContain("non-blank lines");
	expect(report.ok).toBe(false);
});
