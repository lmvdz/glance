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

/** A canceller for a scheduled repeating check. */
export interface IdleCheckHandle {
	cancel: () => void;
}
/** Schedules a repeating idle check; returns a canceller. Default: setInterval; injected in tests to drive deterministically. */
export type IdleScheduler = (check: () => void, intervalMs: number) => IdleCheckHandle;

export interface SingleAgentExecutorOptions {
	/** Worktree the run operates in (command cwd, prompt-ref base). */
	cwd: string;
	/** Lazily obtain (and start) the agent thread for agent/prompt nodes. `node` lets the driver route an
	 *  `isolatedLineage` node (e.g. the TDD write-test author) to a SEPARATE agent/context from the shared
	 *  inner thread; absent/ordinary nodes get the one persistent thread. */
	acquireAgent: (node?: WorkflowNode) => Promise<AgentDriver>;
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
	/** Spawn an independent fleet agent for a parallel-branch node. Absent → branches run sequentially on the shared thread.
	 * `signal` aborts when the join short-circuits or a sibling threw — the spawner stops the agent so it isn't leaked.
	 * `branchKey` is the engine's deterministic per-branch identity, forwarded so the spawner can derive a stable agent id. */
	spawnBranch?: (node: WorkflowNode, task: string, signal?: AbortSignal, branchKey?: string) => Promise<NodeResult>;
	/** Schedule the idle turn-end check (default: setInterval). Injected in tests to drive it deterministically. */
	scheduleIdleCheck?: IdleScheduler;
	/** Seed the stage rollup when resuming a run, so the progress view survives a restart. */
	initialRollup?: { label: string; status: "in_progress" | "completed" }[];
	/** Fold extra context (e.g. unresolved plan-review comments) into the FIRST agent node after a
	 *  human gate resolves — the feed-forward seam. Returns undefined to add nothing. May be async. */
	decoratePrompt?: (node: WorkflowNode, ctx: RunContext) => Promise<string | undefined> | string | undefined;
	/**
	 * True when resuming on a FRESH inner thread (the prior host died — the adopt path). A cold thread
	 * never received the goal, so the in-flight node must RE-EXECUTE via runAgent (re-priming the goal)
	 * rather than waiting on a turn no live thread is running. Absent/false = warm reattach (reconnect),
	 * where the original turn is still in flight and must NOT be re-prompted.
	 */
	cold?: boolean;
}

/**
 * Run var that survives a cold restart to re-trigger the post-gate feed-forward fold. `gateJustPassed`
 * is in-memory and lost when a fresh executor is built on resume; this var rides in the checkpoint vars
 * so a cold resume of the agent node right after a human gate still folds in the reviewer's comments.
 */
const GATE_FOLD_VAR = "__gateFold";

const MAX_CONTEXT_OUTPUT = 4000;
const IDLE_POLL_MS = 5_000;
/** Idle polls (~30s) with the inner loop reporting not-streaming, after it was seen active, before we treat a missing agent_end as turn-end. */
const IDLE_TICKS = 6;

export class SingleAgentExecutor implements NodeExecutor {
	/** Stage rollup for the driver's synthetic getState (done/total + active). */
	readonly rollup: { label: string; status: "in_progress" | "completed" }[] = [];

	private readonly opts: SingleAgentExecutorOptions;
	private primed = false;
	private lastModel?: string;
	private lastEffort?: string;
	/** Set when a human gate resolves; consumed once by the next runAgent (the decoratePrompt fold). */
	private gateJustPassed = false;

	constructor(opts: SingleAgentExecutorOptions) {
		this.opts = opts;
		if (opts.initialRollup?.length) this.rollup.push(...opts.initialRollup);
		// primed is decoupled from the seeded rollup: a WARM resume's inner thread already carries the
		// goal (don't re-send it), but a COLD resume's fresh thread never received it — so the first
		// runAgent must re-prime "Goal:" while still showing the restored progress rollup (RTC-F11).
		this.primed = !!opts.initialRollup?.length && !opts.cold;
	}

	onStage(ev: StageEvent): void {
		if (ev.kind === "start" || ev.kind === "exit") return;
		if (ev.phase === "start") {
			// On resume the seeded rollup already ends with the in-flight node as in_progress; reuse that
			// trailing entry instead of pushing a duplicate (RTC-F10) so the resumed node isn't listed twice.
			const tail = this.rollup[this.rollup.length - 1];
			if (!(tail && tail.status === "in_progress" && tail.label === ev.label)) {
				this.rollup.push({ label: ev.label, status: "in_progress" });
			}
			this.opts.emit({ type: "tool_execution_start", toolName: "stage", intent: ev.label });
		} else {
			const last = this.rollup[this.rollup.length - 1];
			if (last) last.status = "completed";
		}
	}

	async runAgent(node: WorkflowNode, ctx: RunContext): Promise<NodeResult> {
		let body = node.prompt ?? node.label ?? "Continue toward the goal.";
		if (body.startsWith("@")) body = await this.resolvePromptRef(body);

		// ponytail: idempotent rewrite — a fan-out's branch results land in cwd for the review node to read.
		if (ctx.vars.parallelResults) {
			await fs.writeFile(path.join(this.opts.cwd, "parallel_results.json"), ctx.vars.parallelResults);
		}

		// An isolatedLineage node (the TDD write-test author) runs on a SEPARATE agent/context from the
		// shared inner, so the author and the implementer cannot co-reason. Its fresh thread never received
		// the goal, so it always gets its own "Goal:" prime — but it must NOT flip the shared thread's
		// `primed` (or the implementer, running next as the first node on the shared inner, would never be
		// primed with the goal) or its model/effort tracking (that follows the shared coder thread).
		const isolated = node.isolatedLineage === true;

		const parts: string[] = [];
		if (isolated || !this.primed) {
			parts.push(`Goal: ${ctx.goal}`);
			if (!isolated) this.primed = true;
		}
		parts.push(body);
		if (ctx.vars.lastOutput) {
			parts.push(`--- Recent command output ---\n${ctx.vars.lastOutput}`);
		}
		// Feed-forward: on the FIRST agent node after a gate resolves, fold in the reviewer's comments once
		// (agent nodes share one thread, so re-injecting every turn would spam the same notes). The trigger
		// is OR'd with a persisted checkpoint var so a COLD restart landing on this node still folds the
		// comments in — a fresh executor has gateJustPassed=false and would otherwise run blind (RTC-F7).
		// Never on an isolated author — reviewer feedback is for the implementer, not the test author.
		if (!isolated && (this.gateJustPassed || ctx.vars[GATE_FOLD_VAR])) {
			this.gateJustPassed = false;
			delete ctx.vars[GATE_FOLD_VAR];
			const extra = await this.opts.decoratePrompt?.(node, ctx);
			if (extra) parts.push(extra);
		}
		const message = parts.join("\n\n");

		try {
			const agent = await this.opts.acquireAgent(node);
			// Style (model/effort) tracking follows the shared coder thread only — an isolated agent carries
			// its own model chosen at creation, so applying the stylesheet to it (and mutating lastModel/
			// lastEffort) would leak across lineages and desync the coder's own next comparison.
			if (!isolated) {
				const style = this.opts.resolveStyle?.(node);
				if (style?.reasoningEffort && style.reasoningEffort !== this.lastEffort && agent.setThinkingLevel) {
					await agent.setThinkingLevel(style.reasoningEffort).catch(() => {});
					this.lastEffort = style.reasoningEffort;
				}
				if (style?.model && style.model !== this.lastModel && agent.setModel) {
					await agent.setModel(style.model).catch(() => {});
					this.lastModel = style.model;
				}
			}
			const timeoutMs = Number(node.attrs.timeout_ms) || this.opts.turnTimeoutMs || 600_000;
			const text = await this.awaitTurn(agent, message, timeoutMs);
			return { outcome: "succeeded", text };
		} catch (err) {
			return { outcome: "failed", text: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Resume an in-flight agent node after a daemon restart: reattach the thread and wait for its
	 * current turn to end WITHOUT re-prompting (re-prompting would duplicate work — e.g. re-file the
	 * Plane issues). If the turn already finished while the daemon was down, advance immediately.
	 */
	async resumeAgent(node: WorkflowNode, ctx: RunContext): Promise<NodeResult> {
		// Cold resume (fresh thread): the prior host died, so there is no in-flight turn to wait on and the
		// new thread never received the goal. Re-execute the node via runAgent (which re-primes "Goal:" because
		// `primed` is false on a cold resume), instead of skipping it — the D2 soundness fix.
		if (this.opts.cold) return this.runAgent(node, ctx);
		try {
			const agent = await this.opts.acquireAgent(node);
			const st = await agent.getState();
			if (!st.isStreaming) return { outcome: "succeeded", text: "" };
			const timeoutMs = Number(node.attrs.timeout_ms) || this.opts.turnTimeoutMs || 600_000;
			const text = await this.awaitTurn(agent, undefined, timeoutMs);
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

	async humanGate(node: WorkflowNode, options: string[], ctx: RunContext): Promise<string> {
		const label = await this.opts.gate(node, options);
		this.gateJustPassed = true; // the next agent node folds in the review comments once
		// Persist the same intent in the run vars so the fold survives a cold restart between this gate
		// and the next agent node (the entry checkpoint captures vars; runAgent clears it on consume).
		ctx.vars[GATE_FOLD_VAR] = "1";
		return label;
	}

	/** A parallel branch: a fresh fleet agent (if `spawnBranch`) or, without a fleet, a sequential turn. */
	async runBranch(node: WorkflowNode, ctx: RunContext, signal?: AbortSignal, branchKey?: string): Promise<NodeResult> {
		if (!this.opts.spawnBranch) return this.runAgent(node, ctx);
		let body = node.prompt ?? node.label ?? "";
		if (body.startsWith("@")) body = await this.resolvePromptRef(body);
		const task = body ? `Goal: ${ctx.goal}\n\n${body}` : ctx.goal;
		return this.opts.spawnBranch(node, task, signal, branchKey);
	}

	private async resolvePromptRef(ref: string): Promise<string> {
		if (this.opts.readPromptRef) return this.opts.readPromptRef(ref);
		return fs.readFile(path.join(this.opts.cwd, ref.slice(1)), "utf8");
	}

	/**
	 * Send a turn and resolve with the assistant text once the agent loop ends.
	 * Primary signal: the `agent_end` frame. Fallback: the inner agent reports idle
	 * (isStreaming false) for IDLE_TICKS polls after it was seen active — so if `agent_end`
	 * is ever missed (e.g. after auto-compaction on a very long loop) a finished run can't
	 * hang on its node until the hours-long turn timeout. isStreaming stays true through tool
	 * calls, so a slow tool never trips the fallback.
	 */
	private awaitTurn(agent: AgentDriver, message: string | undefined, timeoutMs: number): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let buf = "";
		let settled = false;
		let sawStreaming = false;
		let idleTicks = 0;
		const onEvent = (frame: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } }) => {
			if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
				buf += frame.assistantMessageEvent.delta ?? "";
			} else if (frame.type === "agent_end") {
				finish();
			}
		};
		const onExit = () => { if (!settled) reject(new Error("agent exited mid-turn")); };
		const timer = setTimeout(() => { if (!settled) reject(new Error(`stage timed out after ${timeoutMs}ms`)); }, timeoutMs);
		const idleCheck = () => {
			void agent
				.getState()
				.then((st) => {
					if (st.isStreaming) {
						sawStreaming = true;
						idleTicks = 0;
					} else if (sawStreaming && ++idleTicks >= IDLE_TICKS) {
						finish();
					}
				})
				.catch(() => {});
		};
		const idle = (this.opts.scheduleIdleCheck ?? defaultIdleScheduler)(idleCheck, IDLE_POLL_MS);
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			idle.cancel();
			agent.off("event", onEvent);
			agent.off("exit", onExit);
			resolve(buf.trim());
		};
		agent.on("event", onEvent);
		agent.once("exit", onExit);
		if (message !== undefined) {
			agent.prompt(message).catch((err) => {
				if (!settled) reject(err);
			});
		}
		return promise;
	}
}

const defaultIdleScheduler: IdleScheduler = (check, intervalMs) => {
	const t: Timer = setInterval(check, intervalMs);
	t.unref?.();
	return { cancel: () => clearInterval(t) };
};

async function defaultExecCommand(script: string, cwd: string): Promise<CommandResult> {
	const proc = Bun.spawn(["bash", "-lc", script], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}
