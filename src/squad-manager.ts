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
import type {
	Actor,
	AgentDTO,
	AgentStatus,
	ClientCommand,
	CreateAgentOptions,
	OperatorPresence,
	PendingRequest,
	PersistedAgent,
	RpcExtensionUIRequest,
	RpcSessionState,
	SquadEvent,
	TranscriptEntry,
	TranscriptKind,
} from "./types.ts";
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
	agent: RpcAgent;
	options: PersistedAgent;
	transcript: TranscriptEntry[];
	/** Accumulated streaming text since the last flush. */
	assistantBuf: string;
	/** True between agent_start/turn_start and agent_end. */
	streaming: boolean;
}

export interface SquadManagerOptions {
	operator?: Actor;
	bus?: FederationBus;
	stateDir?: string;
	/** omp binary override (passed to each RpcAgent). */
	bin?: string;
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
	}

	async stop(): Promise<void> {
		clearInterval(this.pollTimer);
		await this.persist();
		await Promise.all([...this.agents.values()].map((r) => r.agent.stop()));
		await this.bus.stop();
	}

	list(): AgentDTO[] {
		return [...this.agents.values()].map((r) => r.dto);
	}

	getTranscript(id: string): TranscriptEntry[] {
		return this.agents.get(id)?.transcript ?? [];
	}

	// ── Roster mutation ───────────────────────────────────────────────────────

	async create(opts: CreateAgentOptions): Promise<AgentDTO> {
		const name = opts.name?.trim() || `agent-${++this.idSeq}`;
		const id = `${name}-${Date.now().toString(36)}`;
		const branch = opts.branch ?? `squad/${name}`;
		const approvalMode = opts.approvalMode ?? "write";
		const thinking = opts.thinking ?? "low";

		let cwd: string;
		let resolvedBranch: string | undefined;
		let repo: string;
		if (opts.existingPath) {
			cwd = opts.existingPath;
			repo = opts.repo;
			resolvedBranch = (await worktreeStatus(cwd).catch(() => ({ branch: undefined }))).branch;
		} else {
			const wt = await addWorktree({ repo: opts.repo, branch });
			cwd = wt.worktree;
			repo = wt.repo;
			resolvedBranch = wt.branch;
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
		};

		const agent = new RpcAgent({ cwd, model: opts.model, approvalMode, thinking, bin: this.bin });
		const rec: AgentRecord = { dto, agent, options: persisted, transcript: [], assistantBuf: "", streaming: false };
		this.agents.set(id, rec);
		this.wire(rec);
		this.emitAgent(rec);

		try {
			await agent.start();
			rec.dto.status = "idle";
			if (resolvedBranch) await agent.setSessionName(`squad:${name}`).catch(() => {});
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
		const fresh = new RpcAgent({
			cwd: rec.options.worktree,
			model: rec.options.model,
			approvalMode: rec.options.approvalMode,
			thinking: rec.options.thinking,
			bin: this.bin,
		});
		rec.agent = fresh;
		rec.dto.status = "starting";
		rec.dto.pending = [];
		rec.dto.error = undefined;
		rec.streaming = false;
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
		const live = [...this.agents.values()].filter((r) => r.agent.isReady && r.agent.isAlive);
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
			await this.create({
				name: p.name,
				repo: p.repo,
				existingPath: p.worktree,
				branch: p.branch,
				model: p.model,
				approvalMode: p.approvalMode,
				thinking: p.thinking,
			}).catch((err) => this.log("error", `restore ${p.name} failed: ${String(err)}`));
		}
		return list.length;
	}
}

function truncate(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
