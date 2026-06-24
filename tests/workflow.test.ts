/**
 * Workflow runtime — deterministic suite (no model tokens, no network).
 *
 * Covers the DOT parser, condition evaluation, the pure engine (routing,
 * human gates, bounded fix-up loops) with a fake executor, and the
 * WorkflowDriver's frame/gate/state mapping with a fake inner agent.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { RpcSessionState } from "../src/types.ts";
import { type BranchSpec, WorkflowDriver } from "../src/workflow-driver.ts";
import { parseWorkflow, WorkflowParseError } from "../src/workflow/dot.ts";
import { evalCondition, WorkflowEngine } from "../src/workflow/engine.ts";
import type { NodeExecutor, NodeResult, RunContext, WorkflowNode } from "../src/workflow/types.ts";
import { CommissionExecutor } from "../src/workflow/commission-executor.ts";
import type { AgentDTO, GateReport } from "../src/types.ts";
import { buildTddVerifyWorkflow, buildVerifyWorkflow } from "../src/workflow/verify-workflow.ts";
import { parseStylesheet, resolveNodeStyle } from "../src/workflow/stylesheet.ts";
import { pickModel } from "../src/rpc-agent.ts";

const BUNDLED = path.join(import.meta.dir, "..", "workflows", "plan-implement", "workflow.fabro");
const BUNDLED_COMMISSION = path.join(import.meta.dir, "..", "workflows", "commission", "workflow.fabro");
const BUNDLED_FANOUT = path.join(import.meta.dir, "..", "workflows", "fan-out", "workflow.fabro");

type Frame = { type?: string; toolName?: string; intent?: string; assistantMessageEvent?: { type?: string; delta?: string } };

const tmps: string[] = [];

// ── parser ───────────────────────────────────────────────────────────────────

test("parser: the bundled plan-implement workflow parses into the expected graph", async () => {
	const wf = parseWorkflow(await fs.readFile(BUNDLED, "utf8"));
	expect(wf.name).toBe("PlanImplement");
	expect(wf.goal).toBe("Plan, get human approval, implement, and verify a change");
	expect(wf.start).toBe("start");
	expect(wf.exit).toBe("exit");
	expect(wf.nodes.get("plan")?.kind).toBe("agent");
	expect(wf.nodes.get("approve")?.kind).toBe("human");
	expect(wf.nodes.get("verify")?.kind).toBe("command");
	expect(wf.nodes.get("verify")?.goalGate).toBe(true);
	expect(wf.nodes.get("verify")?.retryTarget).toBe("fixup");
	expect(wf.nodes.get("verify")?.script).toContain("bun test");
	expect(wf.nodes.get("fixup")?.maxVisits).toBe(3);
	// human gate options come from labeled outgoing edges
	const approveLabels = wf.edges.filter((e) => e.from === "approve").map((e) => e.label).sort();
	expect(approveLabels).toEqual(["Approve", "Revise"]);
});

test("parser: preserves a multi-line quoted script with operators, honors comments and edge chains", () => {
	const src = `digraph T {
		# a comment line
		graph [ goal="g", max_node_visits=7 ]
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		build [shape=parallelogram, script="set -e
cargo build 2>&1 && echo 'ok' || exit 1"]   // trailing comment
		start -> build -> exit
	}`;
	const wf = parseWorkflow(src);
	expect(wf.maxNodeVisits).toBe(7);
	const script = wf.nodes.get("build")?.script ?? "";
	expect(script).toContain("\n"); // newline inside the quoted value survived
	expect(script).toContain("&&");
	expect(script).toContain("|| exit 1");
	// `start -> build -> exit` expands into two edges
	expect(wf.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["start->build", "build->exit"]);
});

test("parser: rejects missing start/exit, unknown shapes, and subgraphs", () => {
	expect(() => parseWorkflow("digraph A {\n\texit [shape=Msquare]\n}")).toThrow(WorkflowParseError);
	expect(() => parseWorkflow("digraph A {\n\tstart [shape=Mdiamond]\n\texit [shape=Msquare]\n\tn [shape=octagon]\n}")).toThrow(/unknown node shape/);
	expect(() => parseWorkflow('digraph A {\n\tstart [shape=Mdiamond]\n\texit [shape=Msquare]\n\tsubgraph c { x [label="y"] }\n}')).toThrow(/not supported/);
});

// ── condition evaluation ───────────────────────────────────────────────────────

test("evalCondition: outcome, preferred_label, context vars, &&/||/!=", () => {
	const ctx = (over: Partial<RunContext>): RunContext => ({ goal: "", vars: {}, ...over });
	expect(evalCondition("outcome=succeeded", ctx({ outcome: "succeeded" }))).toBe(true);
	expect(evalCondition("outcome=succeeded", ctx({ outcome: "failed" }))).toBe(false);
	expect(evalCondition("outcome=failed || preferred_label=Continue", ctx({ preferredLabel: "Continue", outcome: "succeeded" }))).toBe(true);
	expect(evalCondition("outcome!=succeeded", ctx({ outcome: "failed" }))).toBe(true);
	expect(evalCondition("context.ready=true && outcome=succeeded", ctx({ outcome: "succeeded", vars: { ready: "true" } }))).toBe(true);
	expect(evalCondition("context.ready=true && outcome=succeeded", ctx({ outcome: "succeeded", vars: { ready: "false" } }))).toBe(false);
});

// ── engine (fake executor) ─────────────────────────────────────────────────────

interface FakeOptions {
	command?: (node: WorkflowNode) => NodeResult;
	branch?: (node: WorkflowNode) => NodeResult;
	gateAnswers?: string[];
}

class FakeExecutor implements NodeExecutor {
	agentCalls: string[] = [];
	commandCalls: string[] = [];
	branchCalls: string[] = [];
	gateCalls = 0;
	private gateAnswers: string[];
	private commandFn: (node: WorkflowNode) => NodeResult;
	private branchFn: (node: WorkflowNode) => NodeResult;

	constructor(o: FakeOptions = {}) {
		this.gateAnswers = o.gateAnswers ?? [];
		this.commandFn = o.command ?? (() => ({ outcome: "succeeded" }));
		this.branchFn = o.branch ?? ((n) => ({ outcome: "succeeded", text: `${n.id} ok` }));
	}
	async runAgent(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.agentCalls.push(node.id);
		return { outcome: "succeeded", text: `${node.id} done` };
	}
	async runCommand(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.commandCalls.push(node.id);
		return this.commandFn(node);
	}
	async humanGate(_node: WorkflowNode, options: string[], _ctx: RunContext): Promise<string> {
		const answer = this.gateAnswers[this.gateCalls] ?? options[0]!;
		this.gateCalls++;
		return answer;
	}
	async runBranch(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.branchCalls.push(node.id);
		return this.branchFn(node);
	}
}

test("engine: a human gate routes by chosen label — Revise loops back to plan, Approve proceeds", async () => {
	const wf = parseWorkflow(await fs.readFile(BUNDLED, "utf8"));
	const exec = new FakeExecutor({ gateAnswers: ["Revise", "Approve"], command: () => ({ outcome: "succeeded" }) });
	const res = await new WorkflowEngine(wf, exec).run("ship it");
	expect(res.outcome).toBe("succeeded");
	expect(exec.gateCalls).toBe(2); // revised once, then approved
	expect(exec.agentCalls.filter((n) => n === "plan").length).toBe(2); // planned, revised, re-planned
	expect(exec.agentCalls).toContain("implement");
	expect(exec.commandCalls).toEqual(["verify"]); // verify passed first try
});

test("engine: a failing goal-gate drives a bounded fix-up loop, then fails", async () => {
	const wf = parseWorkflow(await fs.readFile(BUNDLED, "utf8"));
	const exec = new FakeExecutor({ gateAnswers: ["Approve"], command: () => ({ outcome: "failed", text: "boom" }) });
	const res = await new WorkflowEngine(wf, exec).run("ship it");
	expect(res.outcome).toBe("failed");
	expect(res.reason).toContain("fixup");
	expect(exec.agentCalls.filter((n) => n === "fixup").length).toBe(3); // fixup max_visits=3
	expect(exec.commandCalls.filter((n) => n === "verify").length).toBe(4); // 1 + one per fixup
});

// ── WorkflowDriver (fake inner agent) ──────────────────────────────────────────

/** A minimal AgentDriver: every prompt is a one-shot turn that streams a line and ends. */
class FakeInnerDriver extends EventEmitter implements AgentDriver {
	private ready = false;
	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.ready;
	}
	async start(): Promise<void> {
		this.ready = true;
		this.emit("ready");
	}
	async stop(): Promise<void> {
		this.ready = false;
	}
	async prompt(message: string): Promise<void> {
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `did: ${message.slice(0, 24)}` } });
		this.emit("event", { type: "message_end" });
		this.emit("event", { type: "agent_end" });
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.resolve({ thinkingLevel: undefined, isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", interruptMode: "immediate", sessionId: "fake", autoCompactionEnabled: false, messageCount: 0, queuedMessageCount: 0, todoPhases: [] });
	}
	setSessionName(): Promise<unknown> {
		return Promise.resolve();
	}
	readonly modelCalls: string[] = [];
	readonly effortCalls: string[] = [];
	setModel(spec: string): Promise<unknown> {
		this.modelCalls.push(spec);
		return Promise.resolve();
	}
	setThinkingLevel(level: string): Promise<unknown> {
		this.effortCalls.push(level);
		return Promise.resolve();
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

async function writeWorkflow(body: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wft-"));
	tmps.push(dir);
	const file = path.join(dir, "workflow.fabro");
	await fs.writeFile(file, body);
	return file;
}

/** Run a WorkflowDriver to completion, auto-answering gates from `answers`, collecting frames. */
async function runDriver(file: string, answers: string[] = []): Promise<{ frames: Frame[]; driver: WorkflowDriver }> {
	const driver = new WorkflowDriver({
		id: "test",
		workflowPath: file,
		cwd: path.dirname(file),
		createInnerDriver: () => new FakeInnerDriver(),
		execCommand: async () => ({ code: 0, stdout: "ok", stderr: "" }),
	});
	const frames: Frame[] = [];
	let answerIdx = 0;
	driver.on("event", (f: Frame) => frames.push(f));
	driver.on("ui", (req: { id: string }) => driver.respondUi(req.id, { value: answers[answerIdx++] ?? "Approve" }));
	const done = new Promise<void>((resolve) => {
		driver.on("event", (f: Frame) => {
			if (f.type === "agent_end") resolve();
		});
	});
	await driver.start();
	await driver.prompt("do the thing");
	await done;
	return { frames, driver };
}

test("WorkflowDriver: emits one agent_start/agent_end around the run, stage frames, and a ✓ summary", async () => {
	const file = await writeWorkflow(`digraph D {
		start     [shape=Mdiamond]
		exit      [shape=Msquare]
		implement [label="Implement", prompt="do it"]
		verify    [shape=parallelogram, label="Verify", script="true", goal_gate=true]
		start -> implement -> verify
		verify -> exit [condition="outcome=succeeded"]
	}`);
	const { frames, driver } = await runDriver(file);

	expect(frames.filter((f) => f.type === "agent_start").length).toBe(1);
	expect(frames.filter((f) => f.type === "agent_end").length).toBe(1);
	expect(frames.some((f) => f.type === "tool_execution_start" && f.toolName === "stage" && f.intent === "Implement")).toBe(true);
	expect(frames.some((f) => f.type === "tool_execution_start" && f.toolName === "stage" && f.intent === "Verify")).toBe(true);
	const summary = frames.findLast((f) => f.type === "message_update")?.assistantMessageEvent?.delta ?? "";
	expect(summary).toContain("✓ workflow");

	const state = await driver.getState();
	expect(state.todoPhases[0]?.tasks.map((t) => t.status)).toEqual(["completed", "completed"]);
	await driver.stop();
});

test("WorkflowDriver: a human gate surfaces as a select UI request and the answer routes the run", async () => {
	const file = await writeWorkflow(`digraph G {
		start  [shape=Mdiamond]
		exit   [shape=Msquare]
		gate   [shape=hexagon, label="Approve?"]
		start -> gate
		gate -> exit [label="Approve"]
		gate -> gate [label="Revise"]
	}`);
	const uiRequests: { method?: string; options?: string[] }[] = [];
	const driver = new WorkflowDriver({ id: "g", workflowPath: file, cwd: path.dirname(file), createInnerDriver: () => new FakeInnerDriver(), execCommand: async () => ({ code: 0, stdout: "", stderr: "" }) });
	let answered = 0;
	const answers = ["Revise", "Approve"];
	driver.on("ui", (req: { id: string; method?: string; options?: string[] }) => {
		uiRequests.push({ method: req.method, options: req.options });
		driver.respondUi(req.id, { value: answers[answered++] ?? "Approve" });
	});
	const frames: Frame[] = [];
	driver.on("event", (f: Frame) => frames.push(f));
	const done = new Promise<void>((resolve) => driver.on("event", (f: Frame) => f.type === "agent_end" && resolve()));
	await driver.start();
	await driver.prompt("approve me");
	await done;

	expect(uiRequests.length).toBe(2); // revised once, approved once
	expect(uiRequests[0]?.method).toBe("select");
	expect(uiRequests[0]?.options).toEqual(["Approve", "Revise"]);
	expect((frames.findLast((f) => f.type === "message_update")?.assistantMessageEvent?.delta ?? "")).toContain("✓ workflow");
	await driver.stop();
});

// ── commission as a workflow (Phase B) ─────────────────────────────────────────

function gateReport(ok: boolean): GateReport {
	return { ok, checks: [{ name: "lint", status: ok ? "pass" : "fail", detail: ok ? undefined : "exports missing" }] };
}

/** Drive the bundled commission graph with a CommissionExecutor whose gate yields `gateResults` in order (last value repeats). */
async function runCommission(gateResults: boolean[]): Promise<{ exec: CommissionExecutor; feedbacks: (string | undefined)[]; onboards: number }> {
	const wf = parseWorkflow(await fs.readFile(BUNDLED_COMMISSION, "utf8"));
	const feedbacks: (string | undefined)[] = [];
	let gateIdx = 0;
	let onboards = 0;
	const exec = new CommissionExecutor({
		author: async (feedback) => {
			feedbacks.push(feedback);
		},
		validate: async () => gateReport(gateResults[Math.min(gateIdx++, gateResults.length - 1)]!),
		onboard: async (): Promise<AgentDTO> => {
			onboards++;
			return { id: "m", name: "w", status: "idle", kind: "flue-service", repo: "(flue-service)", worktree: "/tmp/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0 };
		},
	});
	await new WorkflowEngine(wf, exec).run("make a worker");
	return { exec, feedbacks, onboards };
}

test("commission graph: action nodes, a bounded re-author loop, and a goal-gated validate", async () => {
	const wf = parseWorkflow(await fs.readFile(BUNDLED_COMMISSION, "utf8"));
	expect(wf.nodes.get("author")?.attrs.action).toBe("author");
	expect(wf.nodes.get("gate")?.attrs.action).toBe("validate");
	expect(wf.nodes.get("onboard")?.attrs.action).toBe("onboard");
	expect(wf.nodes.get("author")?.maxVisits).toBe(2);
	expect(wf.nodes.get("gate")?.goalGate).toBe(true);
	expect(wf.nodes.get("gate")?.retryTarget).toBe("author");
});

test("commission: a passing gate authors once and onboards", async () => {
	const { exec, feedbacks, onboards } = await runCommission([true]);
	expect(feedbacks).toEqual([undefined]); // authored once, no retry feedback
	expect(onboards).toBe(1);
	expect(exec.member).toBeDefined();
	expect(exec.report?.ok).toBe(true);
});

test("commission: a gate that fails then passes re-authors with feedback, then onboards", async () => {
	const { exec, feedbacks, onboards } = await runCommission([false, true]);
	expect(feedbacks.length).toBe(2);
	expect(feedbacks[0]).toBeUndefined();
	expect(feedbacks[1]).toContain("failed the acceptance gate");
	expect(onboards).toBe(1);
	expect(exec.member).toBeDefined();
});

test("commission: a persistently failing gate exhausts the re-author cap and onboards nothing", async () => {
	const { exec, feedbacks, onboards } = await runCommission([false]);
	expect(feedbacks.length).toBe(2); // author max_visits=2 → one retry, then stop
	expect(onboards).toBe(0);
	expect(exec.member).toBeUndefined();
	expect(exec.report?.ok).toBe(false);
});

// ── verify loop (Phase C) ──────────────────────────────────────────────────────

test("buildVerifyWorkflow: synthesizes implement → verify(goal_gate) → codefix → fixup", () => {
	const wf = buildVerifyWorkflow({ command: "cargo test 2>&1", maxFixups: 5 });
	expect(wf.nodes.get("implement")?.kind).toBe("agent");
	expect(wf.nodes.get("verify")?.kind).toBe("command");
	expect(wf.nodes.get("verify")?.script).toBe("cargo test 2>&1");
	expect(wf.nodes.get("verify")?.goalGate).toBe(true);
	expect(wf.nodes.get("verify")?.retryTarget).toBe("codefix"); // failure routes to the deterministic pre-pass first
	expect(wf.nodes.get("codefix")?.kind).toBe("command");
	expect(wf.nodes.get("codefix")?.script).toContain("codefix");
	expect(wf.nodes.get("codefix")?.maxVisits).toBe(1); // deterministic pre-pass runs once, then overflows to fixup
	expect(wf.nodes.get("codefix")?.overflow).toBe("fixup");
	expect(wf.nodes.get("fixup")?.maxVisits).toBe(5);
	expect(wf.nodes.get("fixup")?.overflow).toBe("escalate"); // exhausted fixup routes to escalation
	expect(wf.nodes.get("escalate")?.kind).toBe("agent");
	expect(wf.nodes.get("escalate")?.maxVisits).toBe(2);
	expect(wf.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["start->implement", "implement->verify", "verify->exit", "verify->fixup", "codefix->verify", "fixup->verify", "escalate->verify"]);
});

test("buildTddVerifyWorkflow: prepends a write-test node before implement, keeps the verify gate + fixup loop", () => {
	const wf = buildTddVerifyWorkflow({ command: "bun test 2>&1", maxFixups: 4 });
	// write-test is an agent turn that comes before implement
	expect(wf.nodes.get("write-test")?.kind).toBe("agent");
	expect(wf.nodes.get("write-test")?.prompt).toMatch(/FIRST/);
	expect(wf.nodes.get("write-test")?.prompt).toMatch(/FAIL|red/i);
	expect(wf.nodes.get("implement")?.kind).toBe("agent");
	// the gate is unchanged otherwise: goal-gated command that retries into the codefix → fixup cascade
	expect(wf.nodes.get("verify")?.kind).toBe("command");
	expect(wf.nodes.get("verify")?.script).toBe("bun test 2>&1");
	expect(wf.nodes.get("verify")?.goalGate).toBe(true);
	expect(wf.nodes.get("verify")?.retryTarget).toBe("codefix");
	expect(wf.nodes.get("codefix")?.kind).toBe("command");
	expect(wf.nodes.get("codefix")?.maxVisits).toBe(1);
	expect(wf.nodes.get("codefix")?.overflow).toBe("fixup");
	expect(wf.nodes.get("fixup")?.maxVisits).toBe(4);
	expect(wf.nodes.get("fixup")?.overflow).toBe("escalate");
	expect(wf.nodes.get("escalate")?.kind).toBe("agent");
	expect(wf.nodes.get("escalate")?.maxVisits).toBe(2);
	// full path: start → write-test → implement → verify, pass→exit / fail→codefix→fixup→verify
	expect(wf.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["start->write-test", "write-test->implement", "implement->verify", "verify->exit", "verify->fixup", "codefix->verify", "fixup->verify", "escalate->verify"]);
	expect(wf.edges.find((e) => e.from === "verify" && e.to === "exit")?.condition).toBe("outcome=succeeded");
	expect(wf.start).toBe("start");
	expect(wf.exit).toBe("exit");
});

test("verify loop: a failing gate routes through codefix, then a fixup turn, until it passes", async () => {
	const wf = buildVerifyWorkflow({ command: "check" });
	let verifyRuns = 0;
	const exec = new FakeExecutor({
		command: (node) => {
			if (node.id === "codefix") return { outcome: "succeeded" }; // deterministic pre-pass: no-op success here
			const n = verifyRuns++;
			// distinct output per failing run ⇒ genuine progress, so the no-progress short-circuit does NOT fire
			return n < 2 ? { outcome: "failed", text: `err ${n}` } : { outcome: "succeeded" };
		},
	});
	const res = await new WorkflowEngine(wf, exec).run("add a feature");
	expect(res.outcome).toBe("succeeded");
	// 1st failure → codefix pre-pass; 2nd failure → codefix overflows (cap 1) into one fixup; then verify passes.
	expect(exec.agentCalls).toEqual(["implement", "fixup"]);
	expect(exec.commandCalls).toEqual(["verify", "codefix", "verify", "verify"]);
});

test("verify loop: a persistently failing gate runs codefix once, exhausts fixup, then escalation, then fails", async () => {
	const wf = buildVerifyWorkflow({ command: "check", maxFixups: 2 });
	let n = 0;
	// distinct error per verify ⇒ always "progress", so routing flows verify → codefix → (overflow) fixup → escalate.
	const exec = new FakeExecutor({ command: (node) => (node.id === "codefix" ? { outcome: "succeeded" } : { outcome: "failed", text: `err ${n++}` }) });
	const res = await new WorkflowEngine(wf, exec).run("doomed");
	expect(res.outcome).toBe("failed");
	expect(exec.agentCalls.filter((x) => x === "fixup").length).toBe(2); // fixup cap
	expect(exec.agentCalls.filter((x) => x === "escalate").length).toBe(2); // then escalation, its own cap
	expect(exec.commandCalls.filter((x) => x === "codefix").length).toBe(1); // deterministic pre-pass runs once, then overflows
	expect(exec.commandCalls.filter((x) => x === "verify").length).toBe(6); // initial + after the pre-pass, each fixup, each escalate
});

test("WorkflowDriver: runs a synthesized verify loop (no file), codefix pre-pass clears the gate before any fixup", async () => {
	let cmdRuns = 0;
	const driver = new WorkflowDriver({
		id: "v",
		workflow: buildVerifyWorkflow({ command: "check" }),
		cwd: os.tmpdir(),
		createInnerDriver: () => new FakeInnerDriver(),
		execCommand: async () => ({ code: cmdRuns++ === 0 ? 1 : 0, stdout: cmdRuns === 1 ? "boom" : "ok", stderr: "" }),
	});
	const frames: Frame[] = [];
	driver.on("event", (f: Frame) => frames.push(f));
	const done = new Promise<void>((resolve) => driver.on("event", (f: Frame) => f.type === "agent_end" && resolve()));
	await driver.start();
	await driver.prompt("ship the feature");
	await done;

	const stages = frames.filter((f) => f.type === "tool_execution_start" && f.toolName === "stage").map((f) => f.intent);
	expect(stages).toEqual(["Implement", "Verify", "Codefix", "Verify"]); // failed once → deterministic codefix → re-verify passes, no agent fixup
	expect((frames.findLast((f) => f.type === "message_update")?.assistantMessageEvent?.delta ?? "")).toContain("✓ workflow");
	await driver.stop();
});

// ── model stylesheet (Phase D) ─────────────────────────────────────────────────

const SHEET = "* { model: haiku; reasoning_effort: low; } .hard { model: opus; reasoning_effort: high; } #review { model: gpt-5; }";

test("parseStylesheet: flattens blocks into rules with specificity", () => {
	const rules = parseStylesheet(SHEET);
	expect(rules.find((r) => r.selector === "*")?.model).toBe("haiku");
	expect(rules.find((r) => r.selector === "*")?.specificity).toBe(0);
	expect(rules.find((r) => r.selector === ".hard")?.reasoningEffort).toBe("high");
	expect(rules.find((r) => r.selector === ".hard")?.specificity).toBe(10);
	expect(rules.find((r) => r.selector === "#review")?.specificity).toBe(100);
});

test("resolveNodeStyle: class beats universal, node attr beats stylesheet, id is most specific", () => {
	const rules = parseStylesheet(SHEET);
	const node = (id: string, attrs: Record<string, string>, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, kind: "agent", attrs, ...extra });
	// universal only
	expect(resolveNodeStyle(node("plan", {}), rules)).toEqual({ model: "haiku", reasoningEffort: "low" });
	// class overrides universal's model + effort
	expect(resolveNodeStyle(node("impl", { class: "hard" }), rules)).toEqual({ model: "opus", reasoningEffort: "high" });
	// id selector matches by node id (model from #review, effort falls back to universal)
	expect(resolveNodeStyle(node("review", {}), rules)).toEqual({ model: "gpt-5", reasoningEffort: "low" });
	// explicit node model= attr wins over the stylesheet
	expect(resolveNodeStyle(node("impl", { class: "hard" }, { model: "sonnet" }), rules).model).toBe("sonnet");
});

test("pickModel: exact id, provider-scoped, substring, and no match", () => {
	const models = [
		{ provider: "anthropic", id: "claude-opus-4-5" },
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "openai", id: "gpt-5.2" },
	];
	expect(pickModel(models, "claude-haiku-4-5")?.id).toBe("claude-haiku-4-5"); // exact id
	expect(pickModel(models, "anthropic/opus")?.id).toBe("claude-opus-4-5"); // provider-scoped substring
	expect(pickModel(models, "gpt-5")?.id).toBe("gpt-5.2"); // substring on id
	expect(pickModel(models, "haiku")?.provider).toBe("anthropic"); // substring
	expect(pickModel(models, "gemini")).toBeUndefined(); // no match
});

test("WorkflowDriver: a model stylesheet switches the inner agent's model/effort per node", async () => {
	const file = await writeWorkflow(`digraph S {
		graph [ model_stylesheet="${SHEET.replace(/"/g, '\\"')}" ]
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		think [label="Think", class="hard"]
		start -> think -> exit
	}`);
	const inner = new FakeInnerDriver();
	const driver = new WorkflowDriver({ id: "s", workflowPath: file, cwd: path.dirname(file), createInnerDriver: () => inner, execCommand: async () => ({ code: 0, stdout: "", stderr: "" }) });
	const done = new Promise<void>((resolve) => driver.on("event", (f: Frame) => f.type === "agent_end" && resolve()));
	await driver.start();
	await driver.prompt("do the hard thing");
	await done;
	expect(inner.modelCalls).toContain("opus"); // .hard → opus
	expect(inner.effortCalls).toContain("high");
	await driver.stop();
});

// ── parallel fan-out (Level 2) ─────────────────────────────────────────────────

const FORK_GRAPH = `digraph P {
	start [shape=Mdiamond]
	exit  [shape=Msquare]
	fork  [shape=component, label="Fork", JOIN]
	a [label="A"]
	b [label="B"]
	merge [shape=tripleoctagon, label="Merge"]
	recover [label="Recover"]
	start -> fork
	fork -> a
	fork -> b
	a -> merge
	b -> merge
	merge -> exit [label="ok", condition="outcome=succeeded"]
	merge -> recover
	recover -> exit
}`;

test("parser: component → parallel, tripleoctagon → merge, with join attrs (fan-out bundle)", async () => {
	const wf = parseWorkflow(await fs.readFile(BUNDLED_FANOUT, "utf8"));
	expect(wf.nodes.get("fork")?.kind).toBe("parallel");
	expect(wf.nodes.get("merge")?.kind).toBe("merge");
	expect(wf.nodes.get("fork")?.attrs.join_policy).toBe("wait_all");
	expect(wf.nodes.get("fork")?.attrs.max_parallel).toBe("3");
	expect(wf.edges.filter((e) => e.from === "fork").map((e) => e.to).sort()).toEqual(["fast", "lean", "simple"]);
});

test("engine: wait_all fan-out runs every branch then merges to exit", async () => {
	const wf = parseWorkflow(FORK_GRAPH.replace("JOIN", 'join_policy="wait_all"'));
	const exec = new FakeExecutor();
	const res = await new WorkflowEngine(wf, exec).run("explore");
	expect(res.outcome).toBe("succeeded");
	expect(exec.branchCalls.sort()).toEqual(["a", "b"]); // both branches ran
	expect(exec.agentCalls).not.toContain("recover"); // join succeeded → no recovery
});

test("engine: wait_all with a failing branch routes the merge into recovery", async () => {
	const wf = parseWorkflow(FORK_GRAPH.replace("JOIN", 'join_policy="wait_all"'));
	const exec = new FakeExecutor({ branch: (n) => ({ outcome: n.id === "b" ? "failed" : "succeeded" }) });
	const res = await new WorkflowEngine(wf, exec).run("explore");
	expect(exec.branchCalls.sort()).toEqual(["a", "b"]);
	expect(exec.agentCalls).toContain("recover"); // join failed → merge fell through to recover
	expect(res.outcome).toBe("succeeded"); // recover reaches exit
});

test("engine: first_success reaches exit when any branch succeeds", async () => {
	const wf = parseWorkflow(FORK_GRAPH.replace("JOIN", 'join_policy="first_success"'));
	const exec = new FakeExecutor({ branch: (n) => ({ outcome: n.id === "a" ? "failed" : "succeeded" }) });
	const res = await new WorkflowEngine(wf, exec).run("explore");
	expect(res.outcome).toBe("succeeded");
	expect(exec.agentCalls).not.toContain("recover"); // one success ⇒ join succeeded
});

/**
 * A branch executor that honors the abort signal: each branch resolves per `plan[id]`, except a
 * branch told to "hang" stays pending until its signal aborts (then resolves failed) — modelling a
 * real roster agent that only stops when the engine signals it. `aborted` records which branches
 * were signalled, so a test can prove losers/siblings are torn down rather than left running.
 */
class SignalAwareExecutor implements NodeExecutor {
	aborted = new Set<string>();
	agentCalls: string[] = [];
	constructor(private readonly plan: Record<string, "succeed" | "fail" | "hang" | "throw">) {}
	async runAgent(node: WorkflowNode): Promise<NodeResult> {
		this.agentCalls.push(node.id);
		return { outcome: "succeeded", text: `${node.id} done` };
	}
	async runCommand(): Promise<NodeResult> {
		return { outcome: "succeeded" };
	}
	async humanGate(_node: WorkflowNode, options: string[]): Promise<string> {
		return options[0]!;
	}
	async runBranch(node: WorkflowNode, _ctx: RunContext, signal?: AbortSignal): Promise<NodeResult> {
		const what = this.plan[node.id] ?? "succeed";
		if (what === "throw") throw new Error(`branch ${node.id} blew up`);
		if (what === "hang") {
			return new Promise<NodeResult>((resolve) => {
				signal?.addEventListener("abort", () => {
					this.aborted.add(node.id);
					resolve({ outcome: "failed", text: `${node.id} stopped` });
				}, { once: true });
			});
		}
		return { outcome: what === "succeed" ? "succeeded" : "failed", text: `${node.id} ${what}` };
	}
}

test("engine: first_success short-circuits — a winning branch aborts the slow loser instead of blocking on it", async () => {
	const wf = parseWorkflow(FORK_GRAPH.replace("JOIN", 'join_policy="first_success"'));
	const exec = new SignalAwareExecutor({ a: "hang", b: "succeed" });
	const res = await new WorkflowEngine(wf, exec).run("explore");
	expect(res.outcome).toBe("succeeded"); // b won; the join did not wait on the hung branch
	expect(exec.aborted.has("a")).toBe(true); // the slow loser was signalled to stop, not leaked
});

test("engine: a throwing branch fails just itself and aborts its siblings — no orphaned branch agents", async () => {
	const wf = parseWorkflow(FORK_GRAPH.replace("JOIN", 'join_policy="wait_all"'));
	const exec = new SignalAwareExecutor({ a: "throw", b: "hang" });
	const res = await new WorkflowEngine(wf, exec).run("explore");
	expect(exec.aborted.has("b")).toBe(true); // the sibling was torn down rather than left running detached
	expect(exec.agentCalls).toContain("recover"); // both branches failed → merge fell through to recover
	expect(res.outcome).toBe("succeeded"); // recover reaches exit; the run never crashed on the throw
});

test("WorkflowDriver: a fan-out spawns one fleet agent per branch and merges", async () => {
	const file = await writeWorkflow(`digraph F {
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		fork  [shape=component, join_policy="wait_all"]
		a [label="A", prompt="approach a"]
		b [label="B", prompt="approach b"]
		merge [shape=tripleoctagon]
		start -> fork
		fork -> a
		fork -> b
		a -> merge
		b -> merge
		merge -> exit
	}`);
	const fleetCalls: BranchSpec[] = [];
	const driver = new WorkflowDriver({
		id: "fan",
		workflowPath: file,
		cwd: path.dirname(file),
		createInnerDriver: () => new FakeInnerDriver(),
		fleet: { runBranch: async (spec) => (fleetCalls.push(spec), { outcome: "succeeded", text: `${spec.name} done` }) },
	});
	const frames: Frame[] = [];
	driver.on("event", (f: Frame) => frames.push(f));
	const done = new Promise<void>((resolve) => driver.on("event", (f: Frame) => f.type === "agent_end" && resolve()));
	await driver.start();
	await driver.prompt("explore the change");
	await done;
	expect(fleetCalls.map((s) => s.name).sort()).toEqual(["a", "b"]); // one fleet agent per branch
	expect(fleetCalls.every((s) => s.task.includes("explore the change"))).toBe(true); // goal threaded into each branch task
	expect((frames.findLast((f) => f.type === "message_update")?.assistantMessageEvent?.delta ?? "")).toContain("✓ workflow");
	await driver.stop();
});

afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
