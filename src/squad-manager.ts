/**
 * SquadManager — authoritative roster of managed agents.
 *
 * Owns each RpcAgent, derives human-meaningful status from its event stream,
 * buffers a transcript, persists roster config, and exposes a single
 * `applyCommand(cmd, actor)` entry point shared by every surface (local TUI /
 * web today, federation peers in Phase 2). Emits a `SquadEvent` stream.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FederationBus, LOCAL_ACTOR, NullFederationBus, type RemoteCommand } from "./federation.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { AgentDriver } from "./agent-driver.ts";
import { FlueServiceDriver } from "./flue-service-driver.ts";
import { WorkflowDriver } from "./workflow-driver.ts";
import { type Architect, OmpArchitect } from "./architect.ts";
import { validateWorker } from "./validate.ts";
import type {
	Actor,
	AgentDTO,
	AgentStatus,
	ClientCommand,
	CreateAgentOptions,
	CommissionResult,
	CommissionSpec,
	FlueMemberConfig,
	GateReport,
	OperatorPresence,
	PendingRequest,
	PersistedAgent,
	ProjectDTO,
	RpcExtensionUIRequest,
	RpcSessionState,
	SquadEvent,
	TranscriptEntry,
	TranscriptKind,
} from "./types.ts";
import { type SubagentNode, SubagentTracker } from "./subagents.ts";
import { hostAlive, socketPathFor } from "./agent-host.ts";
import { addWorktree, removeWorktree, worktreeStatus } from "./worktree.ts";

const MAX_TRANSCRIPT = 800;
const POLL_MS = 2500;

/** UI methods that block the agent on a human decision. */
const BLOCKING_UI_METHODS: Record<string, true> = {
	confirm: true,
	input: true,
	select: true,
	editor: true,
};

interface AgentRecord {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: TranscriptEntry[];
	/** Accumulated streaming text since the last flush. */
	assistantBuf: string;
	/** True between agent_start/turn_start and agent_end. */
	streaming: boolean;
	/** Live subagent (task-spawned children) tree for this agent. */
	subs: SubagentTracker;
}

export interface SquadManagerOptions {
	operator?: Actor;
	bus?: FederationBus;
	stateDir?: string;
	/** omp binary override (passed to each RpcAgent). */
	bin?: string;
}

export interface CommissionOptions {
	/** Authoring strategy. Default: OmpArchitect (drive a real omp agent). */
	architect?: Architect;
	/** Run `bun install` in the worker before validating (enables typecheck/acceptance tiers). */
	install?: boolean;
	/** Reject the candidate if the acceptance check can't run (no flue toolchain). */
	requireAcceptance?: boolean;
	/** Worker dir override. Default: <stateDir>/workers/<name>. */
	dir?: string;
}

export class SquadManager extends EventEmitter {
	readonly agents = new Map<string, AgentRecord>();
	private readonly bus: FederationBus;
	private readonly operator: Actor;
	private availability: OperatorPresence["availability"] = "active";
	private readonly stateDir: string;
	private readonly stateFile: string;
	private readonly bin?: string;
	private pollTimer?: Timer;
	private idSeq = 0;

	constructor(opts: SquadManagerOptions = {}) {
		super();
		this.operator = opts.operator ?? LOCAL_ACTOR;
		this.bus = opts.bus ?? new NullFederationBus();
		this.stateDir = opts.stateDir ?? path.join(os.homedir(), ".omp", "squad");
		this.stateFile = path.join(this.stateDir, "state.json");
		this.bin = opts.bin;
	}

	async start(): Promise<void> {
		await fs.mkdir(this.stateDir, { recursive: true });
		await this.bus.start();
		this.bus.onRemoteCommand((remote: RemoteCommand) => {
			// Phase 2 authorization (delegation / availability policy) hooks in here,
			// before the command reaches a live agent. v1's NullFederationBus never fires this.
			void this.applyCommand(remote.cmd, remote.actor);
		});
		this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
		await this.reconnectLive();
	}

	async stop(): Promise<void> {
		clearInterval(this.pollTimer);
		await this.persist();
		// Detach (don't kill): leave each agent's detached host + omp running so a
		// restart/upgrade reconnects to live agents with full context.
		for (const r of this.agents.values()) r.agent.detach?.();
		await this.bus.stop();
	}

	/** On daemon start, reattach to any agent whose detached host survived (upgrade/restart). */
	private async reconnectLive(): Promise<number> {
		let raw: string;
		try {
			raw = await fs.readFile(this.stateFile, "utf8");
		} catch {
			return 0;
		}
		const parsed = JSON.parse(raw) as { agents?: PersistedAgent[] };
		let n = 0;
		for (const p of parsed.agents ?? []) {
			if (p.kind === "flue-service" || p.kind === "workflow" || this.agents.has(p.id)) continue;
			if (!(await hostAlive(socketPathFor(p.id)))) continue;
			await this.attachExisting(p).catch((err) => this.log("warn", `reattach ${p.name} failed: ${String(err)}`));
			n++;
		}
		if (n) this.log("info", `reattached ${n} live agent(s)`);
		return n;
	}

	/** Rebuild an AgentRecord for a persisted agent and attach to its live host. */
	private async attachExisting(p: PersistedAgent): Promise<void> {
		const dto: AgentDTO = {
			id: p.id,
			name: p.name,
			status: "starting",
			repo: p.repo,
			worktree: p.worktree,
			branch: p.branch,
			model: p.model,
			approvalMode: p.approvalMode,
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
			issue: p.issue,
			kind: p.kind ?? "omp-operator",
		};
		const agent = this.makeDriver(p);
		const rec: AgentRecord = { dto, agent, options: p, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() };
		this.agents.set(p.id, rec);
		this.wire(rec);
		this.emitAgent(rec);
		await agent.start();
		rec.dto.status = this.derive(rec);
		this.emitAgent(rec);
	}

	list(): AgentDTO[] {
		return [...this.agents.values()].map((r) => r.dto);
	}

	getTranscript(id: string): TranscriptEntry[] {
		return this.agents.get(id)?.transcript ?? [];
	}

	getAgent(id: string): AgentDTO | undefined {
		return this.agents.get(id)?.dto;
	}

	subagents(id: string): SubagentNode[] {
		return this.agents.get(id)?.subs.list() ?? [];
	}

	/** Group agents into projects (by repo root) with status rollups — the command-center top level. */
	projects(): ProjectDTO[] {
		const byRepo = new Map<string, ProjectDTO>();
		for (const { dto } of this.agents.values()) {
			let p = byRepo.get(dto.repo);
			if (!p) {
				p = { id: dto.repo, name: path.basename(dto.repo) || dto.repo, repo: dto.repo, agentCount: 0, statusCounts: {}, pendingCount: 0, lastActivity: 0 };
				byRepo.set(dto.repo, p);
			}
			p.agentCount++;
			p.statusCounts[dto.status] = (p.statusCounts[dto.status] ?? 0) + 1;
			p.pendingCount += dto.pending.length;
			p.lastActivity = Math.max(p.lastActivity, dto.lastActivity);
		}
		return [...byRepo.values()].sort((a, b) => b.lastActivity - a.lastActivity);
	}

	// ── Roster mutation ───────────────────────────────────────────────────────

	async create(opts: CreateAgentOptions): Promise<AgentDTO> {
		const name = opts.name?.trim() || `agent-${++this.idSeq}`;
		const id = `${name}-${Date.now().toString(36)}`;
		const branch = opts.branch ?? `squad/${name}`;
		const approvalMode = opts.approvalMode ?? "write";
		const thinking = opts.thinking ?? "low";
		const kind = opts.workflow ? "workflow" : "omp-operator";

		let cwd: string;
		let resolvedBranch: string | undefined;
		let repo: string;
		if (opts.existingPath) {
			cwd = opts.existingPath;
			repo = opts.repo;
			resolvedBranch = (await worktreeStatus(cwd).catch(() => ({ branch: undefined }))).branch;
		} else {
			try {
				const wt = await addWorktree({ repo: opts.repo, branch });
				cwd = wt.worktree;
				repo = wt.repo;
				resolvedBranch = wt.branch;
			} catch (err) {
				// Not a git repo (or worktree creation failed): run the agent directly in the
				// target directory. No isolation, but "spawn anywhere" still works.
				cwd = opts.repo;
				repo = opts.repo;
				resolvedBranch = undefined;
				this.log("warn", `no worktree for ${opts.repo} (${err instanceof Error ? err.message : String(err)}); running in place`);
			}
		}

		const persisted: PersistedAgent = {
			id,
			name,
			repo,
			worktree: cwd,
			branch: resolvedBranch,
			model: opts.model,
			approvalMode,
			task: opts.task,
			thinking,
			issue: opts.issue,
			kind,
			workflow: opts.workflow ? { path: opts.workflow } : undefined,
		};

		const dto: AgentDTO = {
			id,
			name,
			status: "starting",
			repo,
			worktree: cwd,
			branch: resolvedBranch,
			model: opts.model,
			approvalMode,
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
			issue: opts.issue,
			kind,
		};

		const agent = this.makeDriver(persisted);
		const rec: AgentRecord = { dto, agent, options: persisted, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() };
		this.agents.set(id, rec);
		this.wire(rec);
		this.emitAgent(rec);

		try {
			await agent.start();
			rec.dto.status = "idle";
			if (agent.setSessionName) await agent.setSessionName(`squad:${name}`).catch(() => {});
			this.emitAgent(rec);
			if (opts.task) {
				this.append(rec, "user", opts.task);
				rec.streaming = true;
				rec.dto.status = "working";
				this.emitAgent(rec);
				await agent.prompt(opts.task).catch((err) => this.fail(rec, err));
			}
		} catch (err) {
			this.fail(rec, err);
		}

		await this.persist();
		return rec.dto;
	}

	private makeDriver(p: PersistedAgent): AgentDriver {
		if (p.kind === "flue-service" && p.flue) {
			return new FlueServiceDriver({ dir: p.flue.dir, workflow: p.flue.workflow, target: p.flue.target });
		}
		if (p.kind === "workflow" && p.workflow) {
			return new WorkflowDriver({ id: p.id, workflowPath: p.workflow.path, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, bin: this.bin });
		}
		return new RpcAgent({ id: p.id, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, bin: this.bin });
	}

	/**
	 * Author → validate → onboard a Flue worker (an agent that fills a job).
	 * On a failed gate nothing is onboarded — the candidate is rejected.
	 */
	async commission(spec: CommissionSpec, opts: CommissionOptions = {}, actor: Actor = LOCAL_ACTOR): Promise<CommissionResult> {
		const dir = opts.dir ?? path.join(this.stateDir, "workers", spec.name);
		await fs.mkdir(dir, { recursive: true });
		this.log("info", `${actor.id} commissioning "${spec.name}" → ${truncate(spec.purpose, 80)}`);
		const architect = opts.architect ?? new OmpArchitect({ bin: this.bin });
		await architect.author(spec, dir);
		if (opts.install) await this.installWorker(dir);
		const report = await validateWorker(dir, spec, { requireAcceptance: opts.requireAcceptance });
		this.log(report.ok ? "info" : "warn", `gate "${spec.name}": ${report.checks.map((c) => `${c.name}=${c.status}`).join(" ")}`);
		if (!report.ok) return { ok: false, report, dir };
		const member = await this.onboardFlueWorker(spec, dir, report);
		return { ok: true, report, member, dir };
	}

	private async installWorker(dir: string): Promise<void> {
		const proc = Bun.spawn(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		if ((await proc.exited) !== 0) throw new Error(`worker install failed: ${err.trim().slice(0, 200)}`);
	}

	private async onboardFlueWorker(spec: CommissionSpec, dir: string, report: GateReport): Promise<AgentDTO> {
		const id = `${spec.name}-${Date.now().toString(36)}`;
		const target = spec.deployTarget ?? "node";
		const model = typeof spec.model === "string" ? spec.model : undefined;
		const verified = report.checks.some((c) => c.name === "acceptance" && c.status === "pass");
		const flue: FlueMemberConfig = { dir, workflow: spec.name, target };
		const persisted: PersistedAgent = { id, name: spec.name, repo: "(flue-service)", worktree: dir, approvalMode: "yolo", model, kind: "flue-service", flue };
		const dto: AgentDTO = {
			id,
			name: spec.name,
			status: "idle",
			kind: "flue-service",
			verified,
			repo: "(flue-service)",
			worktree: dir,
			approvalMode: "yolo",
			model,
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
		};
		const rec: AgentRecord = { dto, agent: this.makeDriver(persisted), options: persisted, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() };
		this.agents.set(id, rec);
		this.wire(rec);
		await rec.agent.start();
		this.append(rec, "system", `commissioned · gate ${report.checks.map((c) => `${c.name}=${c.status}`).join(" ")}${verified ? " · verified" : ""}`);
		this.emitAgent(rec);
		await this.persist();
		return dto;
	}

	private async restoreFlueMember(p: PersistedAgent): Promise<void> {
		if (!p.flue) return;
		const dto: AgentDTO = {
			id: p.id,
			name: p.name,
			status: "idle",
			kind: "flue-service",
			repo: p.repo,
			worktree: p.worktree,
			approvalMode: p.approvalMode,
			model: p.model,
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
		};
		const rec: AgentRecord = { dto, agent: this.makeDriver(p), options: p, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() };
		this.agents.set(p.id, rec);
		this.wire(rec);
		await rec.agent.start();
		this.emitAgent(rec);
	}

	async applyCommand(cmd: ClientCommand, actor: Actor = LOCAL_ACTOR): Promise<void> {
		if (cmd.type === "create") {
			await this.create(cmd.options);
			return;
		}
		if (cmd.type === "snapshot") {
			this.emit("event", { type: "roster", agents: this.list() } satisfies SquadEvent);
			return;
		}
		if (cmd.type === "subscribe") {
			const rec = this.agents.get(cmd.id);
			if (rec) for (const entry of rec.transcript) this.emit("event", { type: "transcript", id: cmd.id, entry } satisfies SquadEvent);
			return;
		}
		if (cmd.type === "commission") {
			await this.commission(cmd.spec, {}, actor);
			return;
		}

		const rec = this.agents.get(cmd.id);
		if (!rec) return;

		switch (cmd.type) {
			case "prompt": {
				this.log("info", `${actor.id} → ${rec.dto.name}: ${truncate(cmd.message, 80)}`);
				this.append(rec, "user", cmd.message);
				rec.streaming = true;
				rec.dto.status = "working";
				this.emitAgent(rec);
				await rec.agent.prompt(cmd.message).catch((err) => this.fail(rec, err));
				break;
			}
			case "answer": {
				const req = rec.dto.pending.find((p) => p.id === cmd.requestId);
				if (!req) break;
				this.answerPending(rec, req, cmd.value, actor);
				break;
			}
			case "interrupt":
				await rec.agent.abort().catch(() => {});
				break;
			case "kill":
				await rec.agent.stop();
				rec.dto.status = "stopped";
				this.emitAgent(rec);
				break;
			case "restart":
				await this.restart(rec);
				break;
			case "remove":
				await this.remove(cmd.id, cmd.deleteWorktree ?? false);
				break;
		}
	}

	private answerPending(rec: AgentRecord, req: PendingRequest, value: string, actor: Actor): void {
		if (req.source === "ui") {
			if (req.kind === "confirm") rec.agent.respondUi(req.id, { confirmed: value === "yes" || value === "true" });
			else rec.agent.respondUi(req.id, { value });
		} else {
			rec.agent.respondHostTool(req.id, value);
		}
		rec.dto.pending = rec.dto.pending.filter((p) => p.id !== req.id);
		this.append(rec, "system", `${actor.id} answered "${req.title}": ${truncate(value, 60)}`);
		rec.streaming = true;
		rec.dto.status = this.derive(rec);
		this.emitAgent(rec);
	}

	private async restart(rec: AgentRecord): Promise<void> {
		await rec.agent.stop();
		const fresh = this.makeDriver(rec.options);
		rec.agent = fresh;
		rec.dto.status = "starting";
		rec.dto.pending = [];
		rec.dto.error = undefined;
		rec.streaming = false;
		rec.subs.clear();
		this.wire(rec);
		this.emitAgent(rec);
		try {
			await fresh.start();
			rec.dto.status = "idle";
		} catch (err) {
			this.fail(rec, err);
		}
		this.emitAgent(rec);
	}

	private async remove(id: string, deleteWorktree: boolean): Promise<void> {
		const rec = this.agents.get(id);
		if (!rec) return;
		await rec.agent.stop();
		if (deleteWorktree && !rec.options.repo.startsWith("(")) {
			await removeWorktree(rec.options.repo, rec.options.worktree).catch(() => {});
		}
		this.agents.delete(id);
		this.emit("event", { type: "removed", id } satisfies SquadEvent);
		await this.persist();
	}

	// ── Event wiring ──────────────────────────────────────────────────────────

	private wire(rec: AgentRecord): void {
		const a = rec.agent;
		a.removeAllListeners();
		a.on("event", (frame: { type?: string; [k: string]: unknown }) => this.onAgentEvent(rec, frame));
		a.on("ui", (req: RpcExtensionUIRequest) => this.onUi(rec, req));
		a.on("hosttool", (call: { id: string; toolName: string; arguments: unknown }) => this.onHostTool(rec, call));
		a.on("stderr", (line: string) => this.log("warn", `[${rec.dto.name}] ${line}`));
		a.on("exit", ({ code }: { code: number }) => {
			if (rec.dto.status !== "stopped") {
				rec.dto.status = code === 0 ? "stopped" : "error";
				if (code !== 0) rec.dto.error = `agent exited (code ${code})`;
				this.emitAgent(rec);
			}
		});
	}

	private onAgentEvent(rec: AgentRecord, frame: { type?: string; [k: string]: unknown }): void {
		if (frame.type?.startsWith("subagent_")) {
			rec.subs.ingest(frame as { type: string; payload?: unknown });
			return;
		}
		switch (frame.type) {
			case "agent_start":
			case "turn_start":
				rec.streaming = true;
				break;
			case "message_update": {
				const ev = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (ev?.type === "text_delta" && typeof ev.delta === "string") rec.assistantBuf += ev.delta;
				break;
			}
			case "message_end": {
				if (rec.assistantBuf.trim()) {
					this.append(rec, "assistant", rec.assistantBuf.trim());
					rec.assistantBuf = "";
				}
				break;
			}
			case "tool_execution_start": {
				const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
				const intent = typeof frame.intent === "string" ? frame.intent : "";
				rec.dto.activity = intent ? `${toolName}: ${truncate(intent, 60)}` : toolName;
				this.append(rec, "tool", `▸ ${rec.dto.activity}`);
				break;
			}
			case "agent_end": {
				if (rec.assistantBuf.trim()) {
					this.append(rec, "assistant", rec.assistantBuf.trim());
					rec.assistantBuf = "";
				}
				rec.streaming = false;
				rec.dto.activity = undefined;
				break;
			}
		}
		rec.dto.status = this.derive(rec);
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
	}

	private onUi(rec: AgentRecord, req: RpcExtensionUIRequest): void {
		if (req.method === "cancel") {
			rec.dto.pending = rec.dto.pending.filter((p) => p.id !== req.targetId);
		} else if (req.method === "notify") {
			this.append(rec, "system", `(${req.notifyType ?? "info"}) ${req.message}`);
		} else if (BLOCKING_UI_METHODS[req.method]) {
			const pending: PendingRequest = {
				id: req.id,
				source: "ui",
				kind: req.method,
				title: "title" in req ? req.title : req.method,
				message: req.method === "confirm" ? req.message : undefined,
				options: req.method === "select" ? req.options : undefined,
				placeholder: req.method === "input" ? req.placeholder : req.method === "editor" ? req.prefill : undefined,
				createdAt: Date.now(),
			};
			rec.dto.pending = [...rec.dto.pending.filter((p) => p.id !== req.id), pending];
			this.append(rec, "system", `⛔ needs input: ${pending.title}`);
		}
		rec.dto.status = this.derive(rec);
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
	}

	private onHostTool(rec: AgentRecord, call: { id: string; toolName: string; arguments: unknown }): void {
		const pending: PendingRequest = {
			id: call.id,
			source: "tool",
			kind: call.toolName,
			title: `tool: ${call.toolName}`,
			message: truncate(JSON.stringify(call.arguments ?? {}), 200),
			createdAt: Date.now(),
		};
		rec.dto.pending = [...rec.dto.pending.filter((p) => p.id !== call.id), pending];
		this.append(rec, "system", `⛔ tool call needs host: ${call.toolName}`);
		rec.dto.status = this.derive(rec);
		this.emitAgent(rec);
	}

	private derive(rec: AgentRecord): AgentStatus {
		if (rec.dto.status === "stopped" || rec.dto.status === "error") return rec.dto.status;
		if (rec.dto.pending.length > 0) return "input";
		if (rec.streaming) return "working";
		return "idle";
	}

	private fail(rec: AgentRecord, err: unknown): void {
		rec.dto.status = "error";
		rec.dto.error = err instanceof Error ? err.message : String(err);
		rec.streaming = false;
		this.log("error", `[${rec.dto.name}] ${rec.dto.error}`);
		this.emitAgent(rec);
	}

	// ── Polling (todos / context / streaming truth) ───────────────────────────

	private async poll(): Promise<void> {
		const live = [...this.agents.values()].filter((r) => (r.dto.kind === "omp-operator" || r.dto.kind === "workflow") && r.agent.isReady && r.agent.isAlive);
		await Promise.all(
			live.map(async (rec) => {
				try {
					const state = await rec.agent.getState();
					this.applyState(rec, state);
				} catch {
					/* transient; next tick */
				}
			}),
		);
		this.publishPresence();
	}

	private applyState(rec: AgentRecord, state: RpcSessionState): void {
		const tasks = state.todoPhases.flatMap((p) => p.tasks);
		const done = tasks.filter((t) => t.status === "completed").length;
		const active = tasks.find((t) => t.status === "in_progress")?.content;
		const next: AgentDTO["todo"] = tasks.length ? { done, total: tasks.length, active } : undefined;
		rec.dto.todo = next;
		// RpcSessionState.contextUsage.percent is a 0..100 percentage; AgentDTO.contextPct is a 0..1 fraction.
		rec.dto.contextPct = state.contextUsage ? state.contextUsage.percent / 100 : rec.dto.contextPct;
		if (state.model) rec.dto.model = `${state.model.provider}/${state.model.id}`;
		// Reconcile streaming truth without clobbering a pending-input state.
		if (rec.dto.pending.length === 0) {
			rec.streaming = state.isStreaming;
			if (rec.dto.status !== "stopped" && rec.dto.status !== "error") rec.dto.status = this.derive(rec);
		}
		this.emitAgent(rec);
	}

	// ── Transcript + emission ─────────────────────────────────────────────────

	private append(rec: AgentRecord, kind: TranscriptKind, text: string): void {
		const entry: TranscriptEntry = { kind, text, ts: Date.now() };
		rec.transcript.push(entry);
		if (rec.transcript.length > MAX_TRANSCRIPT) rec.transcript.shift();
		rec.dto.messageCount = rec.transcript.length;
		this.emit("event", { type: "transcript", id: rec.dto.id, entry } satisfies SquadEvent);
	}

	private emitAgent(rec: AgentRecord): void {
		this.emit("event", { type: "agent", agent: rec.dto } satisfies SquadEvent);
		this.publishPresence();
	}

	private log(level: "info" | "warn" | "error", text: string): void {
		this.emit("event", { type: "log", level, text } satisfies SquadEvent);
	}

	private publishPresence(): void {
		const presence: OperatorPresence = {
			operator: this.operator,
			availability: this.availability,
			host: os.hostname(),
			agents: this.list(),
			updatedAt: Date.now(),
		};
		this.bus.publishPresence(presence);
	}

	setAvailability(a: OperatorPresence["availability"]): void {
		this.availability = a;
		this.publishPresence();
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private async persist(): Promise<void> {
		const agents = [...this.agents.values()].map((r) => r.options);
		await fs.writeFile(this.stateFile, JSON.stringify({ version: 1, agents }, null, 2)).catch(() => {});
	}

	/** Re-spawn agents persisted from a previous run. Returns how many were restored. */
	async loadPersisted(): Promise<number> {
		let raw: string;
		try {
			raw = await fs.readFile(this.stateFile, "utf8");
		} catch {
			return 0;
		}
		const parsed = JSON.parse(raw) as { agents?: PersistedAgent[] };
		const list = parsed.agents ?? [];
		for (const p of list) {
			if (p.kind === "flue-service" && p.flue) {
				await this.restoreFlueMember(p).catch((err) => this.log("error", `restore ${p.name} failed: ${String(err)}`));
				continue;
			}
			await this.create({
				name: p.name,
				repo: p.repo,
				existingPath: p.worktree,
				branch: p.branch,
				model: p.model,
				approvalMode: p.approvalMode,
				thinking: p.thinking,
				issue: p.issue,
				workflow: p.workflow?.path,
			}).catch((err) => this.log("error", `restore ${p.name} failed: ${String(err)}`));
		}
		return list.length;
	}
}

function truncate(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
