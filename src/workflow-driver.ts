/**
 * WorkflowDriver — runs a workflow graph behind the AgentDriver contract, so a
 * graph-driven, gated, multi-stage process joins the roster / TUI / web /
 * federation exactly like an omp operator or a flue-service worker. New manager
 * code: a `kind`, a makeDriver branch, a poll-filter widen — the same footprint
 * that added flue-service.
 *
 * Phase A binds every agent node to ONE persistent omp thread (SingleAgentExecutor),
 * so a run is one steerable roster entry. Because the engine is pure and execution
 * is injected, a later executor can fan agent nodes out to real fleet agents
 * without touching this driver or the engine.
 *
 * Frame mapping (what the manager already understands):
 *   - one agent_start … agent_end around the whole run (inner per-turn
 *     agent_start/agent_end are swallowed so status stays "working" between stages);
 *   - stage transitions + command output as tool_execution_start / message frames;
 *   - a human gate as an extension_ui_request{select} → the manager's needs-input
 *     path; the inner agent's own approval prompts ride the same channel.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDriver } from "./agent-driver.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { ApprovalMode, RpcExtensionUIRequest, RpcSessionState, ThinkingLevel } from "./types.ts";
import { parseWorkflow } from "./workflow/dot.ts";
import { WorkflowCancelled, WorkflowEngine } from "./workflow/engine.ts";
import { type CommandResult, SingleAgentExecutor } from "./workflow/executor.ts";
import { parseStylesheet, resolveNodeStyle } from "./workflow/stylesheet.ts";
import type { EngineCheckpoint, NodeResult, RunContext, Workflow, WorkflowAutonomyMode, WorkflowJournalEvent, WorkflowNode, WorkflowProofState, WorkflowRunState } from "./workflow/types.ts";

/** A branch agent to spawn into the roster (one parallel branch = one fleet agent). */
export interface BranchSpec {
	name: string;
	task: string;
	model?: string;
	approvalMode?: ApprovalMode;
	autonomy?: WorkflowAutonomyMode;
	proof?: WorkflowProofState;
	sessionId?: string;
	/** The engine's deterministic `${nodeId}#${visitIndex}:${branchIndex}` identity for this branch — runId-free
	 *  so recorded outcomes survive a fork. Consumed by spawnFleetBranch to derive a collision-free agent id. */
	branchKey?: string;
	/** This workflow run's id, salted into the branch agent id hash so ids stay collision-free across runs/forks. */
	runId?: string;
	/** Aborts when the join short-circuits or a sibling branch threw; the fleet stops the agent so it isn't leaked. */
	signal?: AbortSignal;
}

/**
 * FNV-1a 32-bit hash, hex-encoded (8 chars) — used (with `slug`) to derive short, deterministic branch
 * agent ids from `runId + ":" + branchKey` so they stay well under socketPathFor's ~108-byte sun_path
 * limit regardless of workflow/nodeId length, and never carry `:`/`#` into socket filenames or branch names.
 */
export function hash8(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Slugify a node id into a short, filesystem/socket-safe suffix for a branch agent id. */
export function slug(s: string, maxLen: number): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, maxLen);
}

/**
 * Deterministic branch agent id: `br-<hash8(runId+":"+branchKey)>-<slug(nodeId,12)>`. Short and
 * `[a-z0-9-]`-only so it stays well under socketPathFor's ~108-byte sun_path limit and never carries
 * `:`/`#` into socket filenames, receipts paths, or branch names. `nodeId` is the branch node's own id
 * (the workflow-graph node the branch executes), NOT the fork node's id. The single source of truth for
 * this formula — spawnFleetBranch and squad-manager's reconcileParallelResume both call it so the two
 * derivations can never drift apart.
 */
export function deriveBranchAgentId(runId: string, branchKey: string, nodeId: string): string {
	return `br-${hash8(`${runId}:${branchKey}`)}-${slug(nodeId, 12)}`;
}

/** The fleet capability a workflow uses to fan out parallel branches into real, steerable roster agents. */
export interface WorkflowFleet {
	runBranch(spec: BranchSpec): Promise<NodeResult>;
}

export interface WorkflowDriverOptions {
	/** Roster id of this workflow agent (used to name the inner host socket). */
	id: string;
	/** Path to an authored workflow graph file (`.fabro` / `.dot`). Provide this or `workflow`. */
	workflowPath?: string;
	/** A pre-built graph (e.g. a synthesized verify loop), used instead of reading `workflowPath`. */
	workflow?: Workflow;
	/** Worktree the run operates in (inner agent cwd, command cwd, prompt-ref base). */
	cwd: string;
	model?: string;
	approvalMode?: ApprovalMode;
	thinking?: ThinkingLevel;
	bin?: string;
	autonomy?: WorkflowAutonomyMode;
	sessionId?: string;
	proof?: WorkflowProofState;
	/** Override inner-thread creation (tests). Default: a real RpcAgent. */
	createInnerDriver?: () => AgentDriver;
	/** Override command execution (tests). */
	execCommand?: (script: string, cwd: string) => Promise<CommandResult>;
	/** Spawn parallel-branch nodes as real roster agents. Absent → branches run sequentially on the inner thread. */
	fleet?: WorkflowFleet;
	/** Resume an interrupted run from this persisted position (after a daemon restart). Absent → fresh run. */
	resumeState?: WorkflowRunState;
	/** Feed-forward: fold context (e.g. unresolved plan-review comments) into the first agent node after
	 *  a gate. Passed straight to the executor. */
	decoratePrompt?: (node: WorkflowNode, ctx: RunContext) => Promise<string | undefined> | string | undefined;
	/** True when resuming on a FRESH inner thread (the adopt path, prior host dead) → the in-flight node
	 *  re-executes and re-primes the goal. Absent/false = warm reattach (reconnect), which never re-prompts. */
	cold?: boolean;
}

interface PendingGate {
	id: string;
	resolve: (label: string) => void;
	reject: (err: Error) => void;
}

export class WorkflowDriver extends EventEmitter implements AgentDriver {
	private readonly opts: WorkflowDriverOptions;
	private wf?: Workflow;
	private engine?: WorkflowEngine;
	private executor?: SingleAgentExecutor;
	private inner?: AgentDriver;
	private ready = false;
	private alive = true;
	private runActive = false;
	private gateSeq = 0;
	private pendingGate?: PendingGate;
	private runId = "";

	constructor(opts: WorkflowDriverOptions) {
		super();
		this.opts = opts;
	}

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.alive;
	}

	async start(): Promise<void> {
		if (this.opts.workflow) this.wf = this.opts.workflow;
		else if (this.opts.workflowPath) this.wf = parseWorkflow(await fs.readFile(this.opts.workflowPath, "utf8"));
		else throw new Error("WorkflowDriver needs either `workflow` or `workflowPath`");
		const wfDir = this.opts.workflowPath ? path.dirname(this.opts.workflowPath) : this.opts.cwd;
		const rules = parseStylesheet(this.wf.modelStylesheet ?? "");
		this.executor = new SingleAgentExecutor({
			cwd: this.opts.cwd,
			acquireAgent: () => this.acquireInner(),
			emit: (frame) => this.emit("event", frame),
			gate: (node, options) => this.raiseGate(node, options),
			execCommand: this.opts.execCommand,
			readPromptRef: (ref) => fs.readFile(path.join(wfDir, ref.slice(1)), "utf8"),
			resolveStyle: (node) => resolveNodeStyle(node, rules),
			spawnBranch: this.opts.fleet ? (node, task, signal, branchKey) => this.opts.fleet!.runBranch({ name: node.id, task, model: node.model, approvalMode: this.opts.approvalMode, autonomy: this.autonomy(), proof: this.opts.proof, sessionId: this.sessionId(), branchKey, runId: this.runId, signal }) : undefined,
			initialRollup: this.opts.resumeState?.rollup,
			decoratePrompt: this.opts.decoratePrompt,
			cold: this.opts.cold,
		});
		const baseOnStage = this.executor.onStage.bind(this.executor);
		this.executor.onStage = (ev) => {
			baseOnStage(ev);
			this.onStage(ev);
		};
		this.engine = new WorkflowEngine(this.wf, this.executor);
		this.ready = true;
		this.alive = true;
		this.emit("ready");
		if (this.opts.resumeState) {
			this.runActive = true;
			void this.execRun(this.opts.resumeState.goal, this.opts.resumeState);
		}
	}

	async stop(): Promise<void> {
		this.alive = false;
		this.ready = false;
		this.engine?.stop();
		this.pendingGate?.reject(new Error("workflow stopped"));
		this.pendingGate = undefined;
		await this.inner?.stop();
	}

	/** Leave the inner host running across a daemon restart (the run itself is not resumed in Phase A). */
	detach(): void {
		this.inner?.detach?.();
	}

	/** First prompt starts the run with the goal; later prompts steer the live agent. */
	async prompt(message: string): Promise<void> {
		if (!this.runActive) {
			this.runActive = true;
			void this.execRun(message);
			return;
		}
		await this.inner?.prompt(message).catch(() => {});
	}

	abort(): Promise<unknown> {
		this.engine?.stop();
		return this.inner?.abort() ?? Promise.resolve();
	}

	getState(): Promise<RpcSessionState> {
		const tasks = (this.executor?.rollup ?? []).map((r) => ({ content: r.label, status: r.status }));
		return Promise.resolve({
			thinkingLevel: undefined,
			isStreaming: this.runActive,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
			sessionId: this.wf?.name ?? "workflow",
			autoCompactionEnabled: false,
			messageCount: tasks.length,
			queuedMessageCount: 0,
			todoPhases: tasks.length ? [{ name: this.wf?.name ?? "workflow", tasks }] : [],
		});
	}

	async setSessionName(name: string): Promise<unknown> {
		return this.inner?.setSessionName?.(name) ?? Promise.resolve();
	}

	/** A gate answer resolves the gate; anything else is the inner agent's own request. */
	respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): void {
		if (this.pendingGate && requestId === this.pendingGate.id) {
			const gate = this.pendingGate;
			this.pendingGate = undefined;
			if (payload.cancelled) gate.reject(new Error("gate cancelled"));
			else gate.resolve(payload.value ?? "");
			return;
		}
		this.inner?.respondUi(requestId, payload);
	}

	respondHostTool(callId: string, text: string, isError?: boolean): void {
		this.inner?.respondHostTool(callId, text, isError);
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private async execRun(goal: string, resume?: WorkflowRunState): Promise<void> {
		this.runId = resume?.runId ?? `${this.opts.id}:${Date.now().toString(36)}`;
		this.emit("event", { type: "agent_start" });
		let outcome: "succeeded" | "failed" = "failed";
		try {
			// cold is a resume-time property (adopt = fresh thread), threaded onto the resume so the engine's
			// poison cap applies and the executor re-primes the goal. escalate surfaces a poison-cap stop to
			// the operator via the ordinary message channel (the manager renders it; the run then fails out).
			const resumeRun = resume ? { ...resume, cold: this.opts.cold ?? resume.cold } : undefined;
			const result = await this.engine!.run(goal, {
				resume: resumeRun,
				checkpoint: (c) => this.onCheckpoint(c),
				escalate: (reason, checkpoint) => {
					this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `⚠ ${reason}` } });
					this.emit("event", { type: "message_end" });
					// Lets the manager (concern 03) persist a workflowState.terminal marker and route it
					// through the existing catastrophe channel, regardless of which of the engine's four
					// terminal-failure sites fired.
					this.emit("event", { type: "workflow_terminal", reason, checkpoint });
				},
			});
			outcome = result.outcome;
			const mark = result.outcome === "succeeded" ? "✓" : "✗";
			this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${mark} workflow ${this.wf?.name}${resume ? " (resumed)" : ""}: ${result.reason}` } });
			this.emit("event", { type: "message_end" });
		} catch (err) {
			if (!(err instanceof WorkflowCancelled)) {
				this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `✗ workflow error: ${err instanceof Error ? err.message : String(err)}` } });
				this.emit("event", { type: "message_end" });
			}
		} finally {
			this.runActive = false;
			this.emit("event", { type: "workflow_done", outcome, proof: this.opts.proof });
			this.emit("event", { type: "agent_end" });
		}
	}

	/** Forward an engine checkpoint (+ the executor's rollup) so the manager can persist the resumable run position. */
	private onCheckpoint(c: EngineCheckpoint): void {
		this.emit("checkpoint", { ...c, rollup: [...(this.executor?.rollup ?? [])], runId: this.runId, autonomy: this.autonomy(), sessionId: this.sessionId(), proof: this.opts.proof } satisfies WorkflowRunState);
	}

	private autonomy(): WorkflowAutonomyMode {
		return this.opts.autonomy ?? this.opts.resumeState?.autonomy ?? "supervised";
	}

	private sessionId(): string {
		return this.opts.sessionId ?? this.opts.resumeState?.sessionId ?? this.wf?.name ?? "workflow";
	}

	private emitJournal(event: Omit<WorkflowJournalEvent, "at" | "workflow" | "runId">): void {
		this.emit("event", { type: "workflow_journal", event: { at: Date.now(), workflow: this.wf?.name ?? "workflow", runId: this.runId || `${this.opts.id}:pending`, ...event } satisfies WorkflowJournalEvent });
	}

	private onStage(ev: { nodeId: string; label: string; kind: WorkflowNode["kind"]; phase: "start" | "end"; outcome?: NodeResult["outcome"]; text?: string }): void {
		const isVerification = ev.kind === "command" || /verify|test|check/i.test(ev.label);
		this.emitJournal({ type: ev.kind === "parallel" ? `workflow.parallel.${ev.phase}` : `workflow.node.${ev.phase}`, nodeId: ev.nodeId, label: ev.label, kind: ev.kind, phase: ev.phase, outcome: ev.outcome, text: ev.text, proof: ev.phase === "end" && isVerification ? this.opts.proof : undefined });
		if (isVerification) this.emitJournal({ type: `workflow.verification.${ev.phase}`, nodeId: ev.nodeId, label: ev.label, kind: ev.kind, phase: ev.phase, outcome: ev.outcome, text: ev.text, proof: this.opts.proof });
	}

	private async acquireInner(): Promise<AgentDriver> {
		if (this.inner?.isAlive) return this.inner;
		const inner = this.opts.createInnerDriver
			? this.opts.createInnerDriver()
			: new RpcAgent({ id: `${this.opts.id}-wf`, cwd: this.opts.cwd, model: this.opts.model, approvalMode: this.opts.approvalMode, thinking: this.opts.thinking, bin: this.opts.bin });
		// Forward the inner thread's signal to surfaces, but swallow its per-turn
		// agent_start/agent_end so the manager sees one continuous working session.
		inner.on("event", (frame: { type?: string }) => {
			if (frame.type === "agent_start" || frame.type === "turn_start" || frame.type === "agent_end") return;
			this.emit("event", frame);
		});
		inner.on("ui", (req: RpcExtensionUIRequest) => this.emit("ui", req));
		inner.on("hosttool", (call: unknown) => this.emit("hosttool", call));
		inner.on("stderr", (line: string) => this.emit("stderr", line));
		inner.on("exit", ({ code }: { code: number }) => {
			if (this.runActive) this.emit("stderr", `inner agent exited (code ${code}) mid-run`);
		});
		this.inner = inner;
		await inner.start();
		if (inner.setSessionName) await inner.setSessionName(`workflow:${this.wf?.name}`).catch(() => {});
		return inner;
	}

	private raiseGate(node: WorkflowNode, options: string[]): Promise<string> {
		const id = `gate_${++this.gateSeq}`;
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.pendingGate = {
			id,
			resolve: (label) => {
				this.emitJournal({ type: "workflow.human_gate.end", nodeId: node.id, label: node.label ?? node.id, kind: node.kind, selected: label });
				resolve(label);
			},
			reject,
		};
		const req: RpcExtensionUIRequest = { type: "extension_ui_request", id, method: "select", title: node.label ?? node.id, options };
		this.emitJournal({ type: "workflow.human_gate.start", nodeId: node.id, label: node.label ?? node.id, kind: node.kind, options });
		this.emit("ui", req);
		return promise;
	}
}
