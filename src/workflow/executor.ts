/**
 * SingleAgentExecutor — the Phase-A NodeExecutor. It binds every agent/prompt
 * node to ONE persistent omp thread (so a workflow run is one steerable roster
 * entry), runs command nodes as shell scripts in the run's worktree, and raises
 * human gates through an injected callback (the driver turns these into the
 * manager's ordinary needs-input requests).
 *
 * Everything the driver and the tests need to vary is injected: how to acquire
 * the agent, how to emit frames, how to raise a gate, how to run a command, and
 * how to resolve an `@file.md` prompt reference.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDriver } from "../agent-driver.ts";
import type { NodeExecutor, NodeResult, RunContext, StageEvent, WorkflowNode } from "./types.ts";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface SingleAgentExecutorOptions {
	/** Worktree the run operates in (command cwd, prompt-ref base). */
	cwd: string;
	/** Lazily obtain (and start) the agent thread for agent/prompt nodes. */
	acquireAgent: () => Promise<AgentDriver>;
	/** Forward an omp-shaped frame to surfaces (the manager). */
	emit: (frame: Record<string, unknown>) => void;
	/** Raise a human gate; resolve with the chosen edge label. */
	gate: (node: WorkflowNode, options: string[]) => Promise<string>;
	/** Run a command node. Default: bash via Bun.spawn in `cwd`. */
	execCommand?: (script: string, cwd: string) => Promise<CommandResult>;
	/** Resolve an `@relative.md` prompt reference. Default: read it from `cwd`-relative dir. */
	readPromptRef?: (ref: string) => Promise<string>;
	/** Per-node agent turn timeout. */
	turnTimeoutMs?: number;
	/** Resolve a node's effective model + reasoning effort (model stylesheet). */
	resolveStyle?: (node: WorkflowNode) => { model?: string; reasoningEffort?: string };
	/** Spawn an independent fleet agent for a parallel-branch node. Absent → branches run sequentially on the shared thread. */
	spawnBranch?: (node: WorkflowNode, task: string) => Promise<NodeResult>;
}

const MAX_CONTEXT_OUTPUT = 4000;

export class SingleAgentExecutor implements NodeExecutor {
	/** Stage rollup for the driver's synthetic getState (done/total + active). */
	readonly rollup: { label: string; status: "in_progress" | "completed" }[] = [];

	private readonly opts: SingleAgentExecutorOptions;
	private primed = false;
	private lastModel?: string;
	private lastEffort?: string;

	constructor(opts: SingleAgentExecutorOptions) {
		this.opts = opts;
	}

	onStage(ev: StageEvent): void {
		if (ev.kind === "start" || ev.kind === "exit") return;
		if (ev.phase === "start") {
			this.rollup.push({ label: ev.label, status: "in_progress" });
			this.opts.emit({ type: "tool_execution_start", toolName: "stage", intent: ev.label });
		} else {
			const last = this.rollup[this.rollup.length - 1];
			if (last) last.status = "completed";
		}
	}

	async runAgent(node: WorkflowNode, ctx: RunContext): Promise<NodeResult> {
		let body = node.prompt ?? node.label ?? "Continue toward the goal.";
		if (body.startsWith("@")) body = await this.resolvePromptRef(body);

		const parts: string[] = [];
		if (!this.primed) {
			parts.push(`Goal: ${ctx.goal}`);
			this.primed = true;
		}
		parts.push(body);
		if (ctx.vars.lastOutput) {
			parts.push(`--- Recent command output ---\n${ctx.vars.lastOutput}`);
		}
		const message = parts.join("\n\n");

		try {
			const agent = await this.opts.acquireAgent();
			const style = this.opts.resolveStyle?.(node);
			if (style?.reasoningEffort && style.reasoningEffort !== this.lastEffort && agent.setThinkingLevel) {
				await agent.setThinkingLevel(style.reasoningEffort).catch(() => {});
				this.lastEffort = style.reasoningEffort;
			}
			if (style?.model && style.model !== this.lastModel && agent.setModel) {
				await agent.setModel(style.model).catch(() => {});
				this.lastModel = style.model;
			}
			const timeoutMs = Number(node.attrs.timeout_ms) || this.opts.turnTimeoutMs || 600_000;
			const text = await this.awaitTurn(agent, message, timeoutMs);
			return { outcome: "succeeded", text };
		} catch (err) {
			return { outcome: "failed", text: err instanceof Error ? err.message : String(err) };
		}
	}

	async runCommand(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		const script = node.script ?? "";
		if (!script.trim()) return { outcome: "failed", text: `command node "${node.id}" has no script` };
		const run = this.opts.execCommand ?? defaultExecCommand;
		const { code, stdout, stderr } = await run(script, this.opts.cwd);
		const combined = [stdout, stderr].filter((s) => s.trim()).join("\n").trim();
		const shown = combined.length > MAX_CONTEXT_OUTPUT ? `${combined.slice(0, MAX_CONTEXT_OUTPUT)}\n…(truncated)` : combined;
		this.opts.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `$ ${node.label ?? node.id} → exit ${code}\n${shown || "(no output)"}` } });
		this.opts.emit({ type: "message_end" });
		return { outcome: code === 0 ? "succeeded" : "failed", text: shown };
	}

	humanGate(node: WorkflowNode, options: string[], _ctx: RunContext): Promise<string> {
		return this.opts.gate(node, options);
	}

	/** A parallel branch: a fresh fleet agent (if `spawnBranch`) or, without a fleet, a sequential turn. */
	async runBranch(node: WorkflowNode, ctx: RunContext): Promise<NodeResult> {
		if (!this.opts.spawnBranch) return this.runAgent(node, ctx);
		let body = node.prompt ?? node.label ?? "";
		if (body.startsWith("@")) body = await this.resolvePromptRef(body);
		const task = body ? `Goal: ${ctx.goal}\n\n${body}` : ctx.goal;
		return this.opts.spawnBranch(node, task);
	}

	private async resolvePromptRef(ref: string): Promise<string> {
		if (this.opts.readPromptRef) return this.opts.readPromptRef(ref);
		return fs.readFile(path.join(this.opts.cwd, ref.slice(1)), "utf8");
	}

	/** Send a turn and resolve with the assistant text once the turn ends (mirrors OmpArchitect.runTurn). */
	private awaitTurn(agent: AgentDriver, message: string, timeoutMs: number): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let buf = "";
		const onEvent = (frame: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } }) => {
			if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
				buf += frame.assistantMessageEvent.delta ?? "";
			} else if (frame.type === "agent_end") {
				finish();
			}
		};
		const onExit = () => reject(new Error("agent exited mid-turn"));
		const timer = setTimeout(() => reject(new Error(`stage timed out after ${timeoutMs}ms`)), timeoutMs);
		const finish = () => {
			clearTimeout(timer);
			agent.off("event", onEvent);
			agent.off("exit", onExit);
			resolve(buf.trim());
		};
		agent.on("event", onEvent);
		agent.once("exit", onExit);
		agent.prompt(message).catch(reject);
		return promise;
	}
}

async function defaultExecCommand(script: string, cwd: string): Promise<CommandResult> {
	const proc = Bun.spawn(["bash", "-lc", script], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}
