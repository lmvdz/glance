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
 *     agent_start/agent_end are swallowed DURING a run so status stays "working" between stages;
 *     OUTSIDE a run — an operator steering a finished unit — they are forwarded, because they are the
 *     only thing that can move the unit out of idle while its agent writes. See `prompt()`);
 *   - stage transitions + command output as tool_execution_start / message frames;
 *   - a human gate as an extension_ui_request{select} → the manager's needs-input
 *     path; the inner agent's own approval prompts ride the same channel.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDriver } from "./agent-driver.ts";
import { errText } from "./err-text.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { ApprovalMode, RpcExtensionUIRequest, RpcSessionState, ThinkingLevel } from "./types.ts";
import type { ReflectLlm } from "./reflection.ts";
import { parseWorkflow } from "./workflow/dot.ts";
import { WorkflowCancelled, WorkflowEngine } from "./workflow/engine.ts";
import { type CommandResult, SingleAgentExecutor } from "./workflow/executor.ts";
import { parseStylesheet, resolveNodeStyle } from "./workflow/stylesheet.ts";
import type { EngineCheckpoint, NodeResult, RunContext, Workflow, WorkflowAutonomyMode, WorkflowGraphSnapshot, WorkflowJournalEvent, WorkflowNode, WorkflowProofState, WorkflowRunState } from "./workflow/types.ts";

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
	/** The node in the PARENT's graph this branch executes — structural lineage, kept distinct from `name`
	 *  (mutable display string, identical across all siblings of one parallel node). */
	parentNodeId?: string;
	/** Distinguishes same-node siblings and cold-resume re-spawns of the same node. */
	branchIndex?: number;
	/** Aborts when the join short-circuits or a sibling branch threw; the fleet stops the agent so it isn't leaked. */
	signal?: AbortSignal;
}

/** Pure builder: the static topology snapshot journaled once per run (workflow.graph). */
function buildGraphSnapshot(wf: Workflow): WorkflowGraphSnapshot {
	return {
		version: 1,
		name: wf.name,
		start: wf.start,
		exit: wf.exit,
		maxNodeVisits: wf.maxNodeVisits,
		nodes: [...wf.nodes.values()].map((n) => ({
			id: n.id,
			kind: n.kind,
			label: n.label,
			maxVisits: n.maxVisits,
			overflow: n.overflow,
			goalGate: n.goalGate,
			retryTarget: n.retryTarget,
		})),
		edges: wf.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, condition: e.condition })),
	};
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

/**
 * The RpcAgent options for a workflow's inner thread. Pure + exported so the "the inner agent inherits
 * the unit's system-prompt context" rule is unit-tested — it silently did not, for every workflow unit.
 * The tester lineage takes its own model but the SAME context: it must know the spec it is writing a
 * test for.
 */
export function innerAgentOptions(opts: { id: string; cwd: string; model?: string; approvalMode?: ApprovalMode; thinking?: ThinkingLevel; bin?: string; appendSystemPrompt?: string }, role: "coder" | "tester", modelOverride?: string): { id: string; cwd: string; model?: string; approvalMode?: ApprovalMode; thinking?: ThinkingLevel; bin?: string; appendSystemPrompt?: string } {
	return {
		id: `${opts.id}-${role === "coder" ? "wf" : "tester"}`,
		cwd: opts.cwd,
		model: role === "tester" ? modelOverride : opts.model,
		approvalMode: opts.approvalMode,
		thinking: opts.thinking,
		bin: opts.bin,
		appendSystemPrompt: opts.appendSystemPrompt,
	};
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
	/**
	 * System-prompt context for the inner agent(s): profile memory, tool grants, the cold-start fabric
	 * primer, and the authored Tier-2 spec. `WorkflowDriverOptions` had NO such field, so a workflow unit
	 * — which is what `--verify` and every routed dispatch produce — ran with none of it, while
	 * `RpcAgent` has supported `--append-system-prompt` all along. The unit that most needed its spec was
	 * the one guaranteed not to get it. Found by cross-lineage review (gpt-5.6-sol).
	 */
	appendSystemPrompt?: string;
	autonomy?: WorkflowAutonomyMode;
	sessionId?: string;
	proof?: WorkflowProofState;
	/** Override inner-thread creation (tests). Default: a real RpcAgent. `role` distinguishes the shared
	 *  coder thread from the separate `tester` lineage that runs isolatedLineage nodes (TDD write-test). */
	createInnerDriver?: (role: "coder" | "tester") => AgentDriver;
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
	/** Reflexion (concern 04) wiring, forwarded to the executor with `runId` bound to THIS driver's
	 *  (lazily-minted) runId. Absent ⇒ the executor's fixup node never reflects (mirrors `fleet`). */
	reflection?: { stateDir: string; repo: string; agentId: string; llm?: ReflectLlm };
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
	/** Separate agent/context for isolatedLineage nodes (the TDD write-test author), distinct from `inner`
	 *  so the test author and the implementer are genuinely different lineages that cannot co-reason. */
	private tester?: AgentDriver;
	private ready = false;
	private alive = true;
	private runActive = false;
	/** A run has been STARTED (it may since have finished). Distinct from `runActive`: `prompt()` uses this
	 *  to tell "this is the goal" from "this is a steer", so a prompt to a finished unit never re-runs the
	 *  graph. See `prompt()`. */
	private hasRun = false;
	/**
	 * Busy-ness of a POST-RUN steer, split in two because one boolean cannot express it safely.
	 * `getState().isStreaming` used to be `runActive` alone, which is false once the graph exits — so a
	 * unit being steered reported IDLE while its agent was writing files, and the orchestrator could
	 * sweep-commit, verify and land a half-written tree (grok-4.5).
	 *
	 * - `promptInFlight`: set SYNCHRONOUSLY in `prompt()`, before the agent's own `agent_start` can race a
	 *   poll tick; cleared when `inner.prompt()` settles.
	 * - `innerTurnOpen`: the coder's turn is live (`agent_start` → `agent_end`).
	 *
	 * One flag was wrong both ways (gpt-5.6-sol): clearing it when `inner.prompt()` REJECTS after the
	 * agent already emitted `agent_start` reports idle over a live turn; never clearing it when
	 * `agent_end` is missed strands the unit "working" forever, never verified, never landed. Hence:
	 * a rejection only clears `promptInFlight`, the turn owns `innerTurnOpen`, a dead inner ends it, and
	 * `execRun`'s finally resets it (the graph owns turns during a run; nothing may leak past it).
	 * Only the CODER inner drives these — the isolatedLineage `tester` runs solely inside a run, where
	 * `runActive` already covers it, and letting its delayed `agent_end` clear a later coder steer was a
	 * real cross-agent bug.
	 */
	private promptInFlight = false;
	private innerTurnOpen = false;
	private gateSeq = 0;
	private pendingGate?: PendingGate;
	private runId = "";
	/**
	 * Per-driver-instance branch counter keyed by TARGET node id — survives across a run's repeated
	 * visits to a parallel node (e.g. a fix-up loop that re-fans-out to the same node), so branchIndex
	 * stays monotonic per node. Topology review finding 5: this counter starts at 0 on every FRESH driver
	 * instance, including one built for a cold resume/fork — so a re-spawned branch that resumes a
	 * still-in-progress fan-out would otherwise duplicate a still-rostered sibling's persisted branchIndex
	 * from an EARLIER visit of the same node (`seedFromResume` below closes that by replaying the resumed
	 * fan-out's own visit count into this map before the engine ever calls `nextBranchIndex` again).
	 */
	private branchIndexByNode = new Map<string, number>();

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
			acquireAgent: (node) => this.acquireInner(node),
			emit: (frame) => this.emit("event", frame),
			gate: (node, options) => this.raiseGate(node, options),
			execCommand: this.opts.execCommand,
			readPromptRef: (ref) => fs.readFile(path.join(wfDir, ref.slice(1)), "utf8"),
			resolveStyle: (node) => resolveNodeStyle(node, rules),
			spawnBranch: this.opts.fleet ? (node, task, signal, branchKey) => this.opts.fleet!.runBranch({ name: node.id, task, model: node.model, approvalMode: this.opts.approvalMode, autonomy: this.autonomy(), proof: this.opts.proof, sessionId: this.sessionId(), branchKey, runId: this.runId, signal, parentNodeId: node.id, branchIndex: this.nextBranchIndex(node.id) }) : undefined,
			initialRollup: this.opts.resumeState?.rollup,
			decoratePrompt: this.opts.decoratePrompt,
			cold: this.opts.cold,
			reflection: this.opts.reflection ? { ...this.opts.reflection, runId: () => this.runId } : undefined,
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
			this.seedBranchIndexFromResume(this.opts.resumeState);
			this.hasRun = true; // a resumed run has already started — later prompts steer, never re-run the graph
			this.runActive = true;
			void this.execRun(this.opts.resumeState.goal, this.opts.resumeState);
		}
	}

	/**
	 * Topology review finding 5: reconstruct this fresh driver's `branchIndexByNode` counts from a
	 * resumed run's IN-PROGRESS fan-out, so a re-spawned branch picks up counting where the dead driver
	 * left off instead of colliding with an already-rostered sibling's persisted branchIndex.
	 *
	 * `branchOutcomes` is populated ONLY while a parallel node is actively fanning out (self-clears on
	 * join — see EngineCheckpoint.branchOutcomes), one entry per branch regardless of eventual disposition,
	 * keyed `${forkId}#${visitIndex}:${i}` where `i` indexes the fork's branch target ids in the FIXED
	 * order `this.wf.edges` gives them (the same list on every visit, since the graph is static). That
	 * makes `visitIndex` double as "how many times has branchIds[i] already been fanned into BY THIS FORK"
	 * — exactly what `nextBranchIndex` needs seeded so the next call for that target node returns
	 * `visitIndex`, matching what the original (dead) driver would have assigned had it not crashed.
	 * Every branch in the map is seeded, not just a `not_attempted` one that's about to be re-spawned now
	 * — a LATER revisit of the same fork (another fix-up loop iteration) must keep counting from the true
	 * history, not just from whatever this one resume happens to re-run.
	 */
	private seedBranchIndexFromResume(resume: WorkflowRunState): void {
		const outcomes = resume.branchOutcomes;
		if (!outcomes || !this.wf) return;
		const branchIdsByFork = new Map<string, string[]>();
		for (const key of Object.keys(outcomes)) {
			const m = /^(.+)#(\d+):(\d+)$/.exec(key);
			if (!m) continue;
			const [, forkId, visitStr, iStr] = m as unknown as [string, string, string, string];
			let branchIds = branchIdsByFork.get(forkId);
			if (!branchIds) {
				branchIds = this.wf.edges.filter((e) => e.from === forkId).map((e) => e.to);
				branchIdsByFork.set(forkId, branchIds);
			}
			const targetId = branchIds[Number(iStr)];
			if (targetId === undefined) continue;
			const seeded = Number(visitStr) - 1; // nextBranchIndex's next call returns seeded+1 === visitIndex
			const current = this.branchIndexByNode.get(targetId) ?? -1;
			if (seeded > current) this.branchIndexByNode.set(targetId, seeded);
		}
	}

	async stop(): Promise<void> {
		this.alive = false;
		this.ready = false;
		this.engine?.stop();
		this.pendingGate?.reject(new Error("workflow stopped"));
		this.pendingGate = undefined;
		await this.inner?.stop();
		await this.tester?.stop();
	}

	/** Leave the inner host running across a daemon restart (the run itself is not resumed in Phase A). */
	detach(): void {
		this.inner?.detach?.();
		this.tester?.detach?.();
	}

	/**
	 * The FIRST prompt is the run's goal and starts it. Every prompt after that — during the run or long
	 * after it exits — steers the live inner agent. It must never start a second run.
	 *
	 * The old guard was `if (!this.runActive)`, which is also true once a run has FINISHED. So an operator
	 * steering a completed unit silently re-entered `execRun(message)`: a whole new graph traversal with
	 * the steer text as its "goal". Observed live (2026-07-09) while telling a finished unit it had never
	 * committed — the workflow re-ran `Implement`, the inner agent (which remembers the original task)
	 * answered "the goal is complete", `Verify` re-ran, and the run exited. The instruction was never
	 * executed and nothing reported that it had been swallowed. This is the founding brief's R4 — there
	 * is no channel for steering, iteration, or taste, "and that's most of the real work".
	 *
	 * `hasRun` (not `runActive`) is the latch: once a run has begun, prompts belong to the agent.
	 */
	async prompt(message: string): Promise<void> {
		if (!this.hasRun) {
			this.hasRun = true;
			this.runActive = true;
			void this.execRun(message);
			return;
		}
		// No inner agent to steer (the run never reached an agent node, or it died): starting a run is the
		// only thing left that can act on the message. Preserves the pre-fix behavior for that one case.
		if (!this.inner?.isAlive) {
			if (this.runActive) return; // a run is mid-flight without an agent node yet — dropping is correct
			this.runActive = true;
			void this.execRun(message);
			return;
		}
		// Mark busy BEFORE handing the message over: the agent's own `agent_start` arrives asynchronously,
		// and a poll tick landing in that window would read the unit as idle and let the orchestrator
		// sweep-commit/verify/land the tree the agent is about to write into.
		this.promptInFlight = true;
		try {
			await this.inner.prompt(message);
		} catch (err) {
			// Never black-hole a steer: the operator typed it and is watching for an effect. `.catch(() => {})`
			// here used to swallow the failure silently. NOTE: only `promptInFlight` clears (in the finally) —
			// if the agent already emitted `agent_start`, its turn is live and `innerTurnOpen` still holds the
			// unit "working". A rejected send does not mean a stopped agent.
			this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `⚠ steer not delivered: ${errText(err)}` } });
			this.emit("event", { type: "message_end" });
		} finally {
			this.promptInFlight = false;
		}
	}

	abort(): Promise<unknown> {
		this.engine?.stop();
		return this.inner?.abort() ?? Promise.resolve();
	}

	getState(): Promise<RpcSessionState> {
		const tasks = (this.executor?.rollup ?? []).map((r) => ({ content: r.label, status: r.status }));
		return Promise.resolve({
			thinkingLevel: undefined,
			// `runActive` alone reported IDLE while a post-run steer was mid-turn — see `promptInFlight`/`innerTurnOpen`.
			// A turn only counts while its agent is alive: a dead inner cannot be mid-turn, and stranding the unit
			// "working" means it is never swept, verified, or landed.
			isStreaming: this.runActive || this.promptInFlight || (this.innerTurnOpen && (this.inner?.isAlive ?? false)),
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

	/** Monotonic per-node branch counter, keyed so re-fanning-out the same node across visits keeps distinguishing siblings. */
	private nextBranchIndex(nodeId: string): number {
		const n = (this.branchIndexByNode.get(nodeId) ?? -1) + 1;
		this.branchIndexByNode.set(nodeId, n);
		return n;
	}

	private async execRun(goal: string, resume?: WorkflowRunState): Promise<void> {
		this.runId = resume?.runId ?? `${this.opts.id}:${Date.now().toString(36)}`;
		// Emitted here (not in start()) so it always carries the real runId — assigned only just above — and
		// fires exactly once per run including resumes/second runs on a reused driver. this.wf is guaranteed
		// set: start() assigns it before execRun can be reached via either prompt() or the resume branch.
		this.emitJournal({ type: "workflow.graph", graph: buildGraphSnapshot(this.wf!) });
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
			// The graph owned every turn inside the run. A node whose `agent_end` was missed (host crash, lost
			// frame) must not leak `innerTurnOpen` past the run and strand the unit "working" forever.
			this.innerTurnOpen = false;
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

	private async acquireInner(node?: WorkflowNode): Promise<AgentDriver> {
		// isolatedLineage nodes (the TDD write-test author) run on a SEPARATE agent/context so the author
		// and the implementer cannot co-reason — the implementer inherits only the on-disk red test.
		if (node?.isolatedLineage) return this.acquireTester();
		if (this.inner?.isAlive) return this.inner;
		const inner = this.opts.createInnerDriver
			? this.opts.createInnerDriver("coder")
			: new RpcAgent(innerAgentOptions(this.opts, "coder"));
		this.wireInner(inner);
		this.inner = inner;
		await inner.start();
		if (inner.setSessionName) await inner.setSessionName(`workflow:${this.wf?.name}`).catch(() => {});
		return inner;
	}

	/**
	 * The isolated test-author thread — a DISTINCT agent/context from the shared coder `inner`, so the TDD
	 * write-test author and the implementer are genuinely separate lineages that cannot co-reason (the
	 * implementer inherits only the committed red test on disk, not the author's conversation — the whole
	 * point of the tester role). Given its own (optionally stronger) model via OMP_SQUAD_TDD_TESTER_MODEL
	 * when set. Cached for the run and torn down with the driver, like `inner`.
	 */
	private async acquireTester(): Promise<AgentDriver> {
		if (this.tester?.isAlive) return this.tester;
		const model = process.env.OMP_SQUAD_TDD_TESTER_MODEL || this.opts.model;
		const tester = this.opts.createInnerDriver
			? this.opts.createInnerDriver("tester")
			: new RpcAgent(innerAgentOptions(this.opts, "tester", model));
		this.wireInner(tester, "tester");
		this.tester = tester;
		await tester.start();
		if (tester.setSessionName) await tester.setSessionName(`workflow:${this.wf?.name}:test-author`).catch(() => {});
		return tester;
	}

	/**
	 * Forward an inner thread's signal to surfaces, but swallow its per-turn agent_start/agent_end so the
	 * manager sees one continuous working session. Shared by the coder `inner` and the `tester` lineage.
	 */
	private wireInner(agent: AgentDriver, role: "coder" | "tester" = "coder"): void {
		agent.on("event", (frame: { type?: string }) => {
			// The turn lifecycle is TRACKED (coder only) and FORWARDED only outside a run. During a run the
			// graph owns the roster lifecycle — execRun emits one agent_start/agent_end per run — so
			// forwarding per-node turns would flap the unit working↔idle on every node. Outside a run (an
			// operator steering a finished unit) these frames are the only thing that can move it out of
			// idle, and `innerTurnOpen` is what keeps the orchestrator off a tree being written into.
			if (frame.type === "agent_start" || frame.type === "turn_start") {
				if (role === "coder") this.innerTurnOpen = true;
				if (!this.runActive) this.emit("event", frame);
				return;
			}
			if (frame.type === "agent_end") {
				if (role === "coder") this.innerTurnOpen = false;
				if (!this.runActive) this.emit("event", frame);
				return;
			}
			this.emit("event", frame);
		});
		agent.on("ui", (req: RpcExtensionUIRequest) => this.emit("ui", req));
		agent.on("hosttool", (call: unknown) => this.emit("hosttool", call));
		agent.on("stderr", (line: string) => this.emit("stderr", line));
		agent.on("exit", ({ code }: { code: number }) => {
			// A dead agent has no live turn. Without this a missed `agent_end` (host crash, lost frame)
			// would strand the unit "working" forever: never idle ⇒ never swept, verified, or landed.
			if (role === "coder") this.innerTurnOpen = false;
			if (this.runActive) this.emit("stderr", `inner agent exited (code ${code}) mid-run`);
		});
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
