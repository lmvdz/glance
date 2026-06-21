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
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type FederationBus, LOCAL_ACTOR, NullFederationBus, type RemoteCommand } from "./federation.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { AgentDriver } from "./agent-driver.ts";
import { FlueServiceDriver } from "./flue-service-driver.ts";
import { type BranchSpec, WorkflowDriver, type WorkflowFleet } from "./workflow-driver.ts";
import { SandboxAgentDriver } from "./sandbox-agent-driver.ts";
import { type Architect, OmpArchitect } from "./architect.ts";
import { validateWorker } from "./validate.ts";
import { CommissionExecutor } from "./workflow/commission-executor.ts";
import { WorkflowEngine } from "./workflow/engine.ts";
import { parseWorkflow } from "./workflow/dot.ts";
import type { NodeResult, Workflow, WorkflowRunState } from "./workflow/types.ts";
import { buildVerifyWorkflow } from "./workflow/verify-workflow.ts";
import { type Classify, ompClassify, routeIntake } from "./intake.ts";
import { Dispatcher } from "./dispatch.ts";
import { closePlaneIssue, listPlaneIssues, planeRepos } from "./plane.ts";
import { buildFeatures, featureLandStatus, type LandMember, landOrder } from "./features.ts";
import { landAgent } from "./land.ts";
import type {
	Actor,
	IssueRef,
	AgentDTO,
	FeatureDTO,
	PersistedFeature,
	FeatureStage,
	AgentStatus,
	CommandInfo,
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
	SandboxConfig,
	SquadEvent,
	TranscriptEntry,
	TranscriptKind,
} from "./types.ts";
import { type SubagentNode, SubagentTracker } from "./subagents.ts";
import { hostAlive, pruneStaleSockets, socketPathFor } from "./agent-host.ts";
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
	/** Available slash commands (builtin + skills + extensions) reported by the agent. */
	commands?: CommandInfo[];
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
	private readonly featureStore = new Map<string, PersistedFeature>();
	private readonly bin?: string;
	private pollTimer?: Timer;
	private dispatcher?: Dispatcher;
	private closeOnDone = false;
	private llmClassify?: Classify;
	private readonly closedIssues = new Set<string>();
	/** Agent ids the daemon reattached to (surviving hosts) this run. */
	private readonly reattached = new Set<string>();
	private idSeq = 0;

	constructor(opts: SquadManagerOptions = {}) {
		super();
		this.operator = opts.operator ?? LOCAL_ACTOR;
		this.bus = opts.bus ?? new NullFederationBus();
		this.stateDir = opts.stateDir ?? path.join(os.homedir(), ".omp", "squad");
		this.stateFile = path.join(this.stateDir, "state.json");
		this.bin = opts.bin;
		this.llmClassify = process.env.OMP_SQUAD_LLM_ROUTER ? ompClassify(this.bin) : undefined;
	}

	async start(): Promise<void> {
		await this.reconnectLive();
		await pruneStaleSockets().catch(() => []);
		await this.bus.start();
		this.bus.onRemoteCommand((remote: RemoteCommand) => {
			// Phase 2 authorization (delegation / availability policy) hooks in here,
			// before the command reaches a live agent. v1's NullFederationBus never fires this.
			void this.applyCommand(remote.cmd, remote.actor);
		});
		this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
		if (process.env.OMP_SQUAD_AUTODISPATCH) {
			this.closeOnDone = !!process.env.OMP_SQUAD_AUTOCLOSE;
			const interval = Number(process.env.OMP_SQUAD_DISPATCH_INTERVAL_MS) || 60_000;
			const maxActive = Number(process.env.OMP_SQUAD_DISPATCH_MAX) || 3;
			this.dispatcher = new Dispatcher({
				repos: planeRepos,
				listIssues: listPlaneIssues,
				spawn: (repo, issue) => this.dispatchSpawn(repo, issue),
				claimed: () => new Set([...this.agents.values()].map((r) => r.dto.issue?.id).filter((x): x is string => !!x)),
				activeCount: () => [...this.agents.values()].filter((r) => !!r.dto.issue && (r.dto.status === "working" || r.dto.status === "starting" || r.dto.status === "input")).length,
				log: (m) => this.log("info", `auto-dispatch: ${m}`),
				maxActive,
			});
			this.dispatcher.start(interval);
			this.log("info", `auto-dispatch on (every ${Math.round(interval / 1000)}s, max ${maxActive}${this.closeOnDone ? ", auto-close" : ""})`);
		}
		await this.reconnectLive();
	}

	/** Spawn a routed agent for a Plane issue — the auto-dispatch entry point (intent → process). */
	private async dispatchSpawn(repo: string, issue: IssueRef): Promise<void> {
		const task = `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.name}`;
		await this.create({ repo, name: issue.identifier?.toLowerCase(), task, issue, autoRoute: true, approvalMode: "yolo" });
	}

	async stop(): Promise<void> {
		clearInterval(this.pollTimer);
		this.dispatcher?.stop();
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
		const parsed = JSON.parse(raw) as { agents?: PersistedAgent[]; transcripts?: Record<string, TranscriptEntry[]>; features?: PersistedFeature[] };
		for (const f of parsed.features ?? []) this.featureStore.set(f.id, f);
		let n = 0;
		for (const p of parsed.agents ?? []) {
			if (this.agents.has(p.id)) continue;
			if (p.kind === "flue-service") continue; // flue workers are not reattached
			if (p.kind === "workflow") {
				// A workflow run survives a restart only if its inner thread is still alive AND we have a
				// checkpoint to resume the graph from; otherwise the orchestration is unrecoverable.
				const innerAlive = await hostAlive(socketPathFor(`${p.id}-wf`));
				if (innerAlive && p.workflowState) {
					await this.attachExisting(p, parsed.transcripts?.[p.id] ?? []).catch((err) => this.log("warn", `resume ${p.name} failed: ${String(err)}`));
					n++;
				} else if (innerAlive) {
					this.log("warn", `workflow ${p.name} has a live thread but no checkpoint — cannot resume the graph`);
				}
				continue;
			}
			if (!(await hostAlive(socketPathFor(p.id)))) continue;
			await this.attachExisting(p, parsed.transcripts?.[p.id] ?? []).catch((err) => this.log("warn", `reattach ${p.name} failed: ${String(err)}`));
			n++;
		}
		if (n) this.log("info", `reattached ${n} live agent(s)`);
		return n;
	}

	/** Rebuild an AgentRecord for a persisted agent and attach to its live host. */
	private async attachExisting(p: PersistedAgent, transcript: TranscriptEntry[] = []): Promise<void> {
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
			parentId: p.parentId,
			featureId: p.featureId,
		};
		const agent = this.makeDriver(p);
		const rec: AgentRecord = { dto, agent, options: p, transcript, assistantBuf: "", streaming: false, subs: new SubagentTracker() };
		dto.messageCount = transcript.length;
		this.agents.set(p.id, rec);
		this.wire(rec);
		this.emitAgent(rec);
		await agent.start();
		rec.dto.status = this.derive(rec);
		this.reattached.add(p.id);
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

	/** True if this agent was reattached to a surviving host (vs freshly spawned this run). */
	wasReattached(id: string): boolean {
		return this.reattached.has(id);
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

	/** Feature view: persisted features + derived plan-dir/agent features with live land status, per repo. */
	async features(repo?: string): Promise<FeatureDTO[]> {
		const list = this.list();
		const persisted = [...this.featureStore.values()];
		const repos = repo !== undefined ? [repo] : [...new Set([...list.map((a) => a.repo), ...persisted.map((f) => f.repo)])];
		const out: FeatureDTO[] = [];
		for (const r of repos) out.push(...(await buildFeatures(r, list.filter((a) => a.repo === r), persisted)));
		return out;
	}

	createFeature(opts: { title: string; repo: string; planDir?: string; stageOverride?: FeatureStage }): PersistedFeature {
		const id = `feat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const now = Date.now();
		const pf: PersistedFeature = { id, title: opts.title.trim() || "feature", repo: opts.repo, stageOverride: opts.stageOverride, origin: opts.planDir ? { planDir: opts.planDir } : undefined, createdAt: now, updatedAt: now };
		this.featureStore.set(id, pf);
		this.emitFeaturesChanged();
		return pf;
	}

	/** Spawn a research-plan-implement workflow agent and wrap it in a feature whose stage tracks the live run. */
	async createAutoFeature(opts: { title: string; repo: string; goal: string; model?: string }): Promise<{ feature: PersistedFeature; agent: AgentDTO }> {
		const pf = this.createFeature({ title: opts.title, repo: opts.repo });
		const name = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || undefined;
		const agent = await this.create({ repo: opts.repo, name, workflow: "research-plan-implement", task: opts.goal, featureId: pf.id, approvalMode: "yolo", model: opts.model });
		pf.workflowAgentId = agent.id;
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return { feature: pf, agent };
	}

	updateFeature(id: string, patch: { title?: string; stageOverride?: FeatureStage | null; archived?: boolean }): PersistedFeature | undefined {
		const pf = this.featureStore.get(id);
		if (!pf) return undefined;
		if (patch.title !== undefined) pf.title = patch.title;
		if (patch.stageOverride !== undefined) pf.stageOverride = patch.stageOverride ?? undefined;
		if (patch.archived !== undefined) pf.archived = patch.archived;
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return pf;
	}

	/** Attach (or detach) an agent to a feature; membership lives on the agent. */
	linkAgent(featureId: string, agentId: string, unlink = false): boolean {
		const pf = this.featureStore.get(featureId);
		const rec = this.agents.get(agentId);
		if (!pf || !rec) return false;
		rec.dto.featureId = unlink ? undefined : featureId;
		rec.options.featureId = unlink ? undefined : featureId;
		this.snapshotBranches(featureId);
		pf.updatedAt = Date.now();
		this.emitAgent(rec);
		this.emitFeaturesChanged();
		return true;
	}

	/** Cache the current member branches so land status survives an agent being killed. */
	private snapshotBranches(featureId: string): void {
		const pf = this.featureStore.get(featureId);
		if (!pf) return;
		pf.branches = [...this.agents.values()].filter((r) => r.dto.featureId === featureId).map((r) => ({ branch: r.dto.branch, worktree: r.dto.worktree, agentId: r.dto.id }));
	}

	/** Land all member branches: fast-forward-safe first, stop on a diverged/failed branch (unless force). */
	async landFeature(id: string, force = false): Promise<{ ok: boolean; stopped?: string; results: { agentId?: string; branch?: string; ok: boolean; detail?: string }[] }> {
		const pf = this.featureStore.get(id);
		if (!pf) return { ok: false, stopped: "no such feature", results: [] };
		this.snapshotBranches(id);
		const members: LandMember[] = [...this.agents.values()].filter((r) => r.dto.featureId === id).map((r) => ({ agentId: r.dto.id, agentName: r.dto.name, branch: r.dto.branch, worktree: r.dto.worktree, repo: pf.repo }));
		for (const b of pf.branches ?? []) if (!members.some((m) => m.agentId === b.agentId)) members.push({ agentId: b.agentId, branch: b.branch, worktree: b.worktree, repo: pf.repo });
		const wts = await featureLandStatus(members);
		if (!force && wts.some((w) => w.readiness === "diverged")) return { ok: false, stopped: "a branch is diverged — resolve it (or force)", results: [] };
		const results: { agentId?: string; branch?: string; ok: boolean; detail?: string }[] = [];
		for (const w of landOrder(wts)) {
			const rec = w.agentId ? this.agents.get(w.agentId) : undefined;
			const busy = rec ? rec.dto.status === "working" || rec.dto.status === "starting" || rec.dto.status === "input" : false;
			const res = await landAgent({ repo: pf.repo, worktree: w.worktree, branch: w.branch, message: `feature(${pf.title}): land ${w.branch ?? "changes"}`, commitWip: !busy });
			results.push({ agentId: w.agentId, branch: w.branch, ok: res.ok, detail: res.detail });
			if (!res.ok) { this.emitFeaturesChanged(); return { ok: false, stopped: `land failed on ${w.branch}`, results }; }
		}
		this.emitFeaturesChanged();
		return { ok: true, results };
	}

	private emitFeaturesChanged(): void {
		void this.persist();
		this.emit("event", { type: "features-changed" } satisfies SquadEvent);
	}

	// ── Roster mutation ───────────────────────────────────────────────────────

	async create(opts: CreateAgentOptions): Promise<AgentDTO> {
		const name = opts.name?.trim() || `agent-${++this.idSeq}`;
		const id = `${name}-${Date.now().toString(36)}`;
		const branch = opts.branch ?? `squad/${name}`;
		if (opts.task && opts.autoRoute !== false && !opts.workflow && !opts.verify && !opts.sandbox) {
			const decision = await routeIntake(opts.task, opts.repo, this.llmClassify);
			opts = { ...opts, workflow: decision.workflow, verify: decision.verify, thinking: decision.thinking ?? opts.thinking };
			this.log("info", `routed "${name}": ${decision.reason}`);
		}
		const approvalMode = opts.approvalMode ?? "write";
		const thinking = opts.thinking ?? "low";
		const kind = opts.workflow || opts.verify ? "workflow" : "omp-operator";

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
			workflow: opts.workflow ? { path: opts.workflow } : opts.verify ? { verify: { command: opts.verify } } : undefined,
			sandbox: opts.sandbox,
			parentId: opts.parentId,
			featureId: opts.featureId,
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
			parentId: opts.parentId,
			featureId: opts.featureId,
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
			const workflow = p.workflow.verify ? buildVerifyWorkflow(p.workflow.verify) : undefined;
			const fleet: WorkflowFleet = { runBranch: (spec) => this.spawnFleetBranch(p.repo, p.id, spec) };
			return new WorkflowDriver({ id: p.id, workflow, workflowPath: p.workflow.path ? resolveWorkflowPath(p.workflow.path) : undefined, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, bin: this.bin, fleet, resumeState: p.workflowState });
		}
		if (p.sandbox) {
			return new SandboxAgentDriver({ id: p.id, image: p.sandbox.image, workdir: p.sandbox.workdir, mount: p.sandbox.mountWorktree === false ? undefined : p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, runArgs: p.sandbox.runArgs });
		}
		return new RpcAgent({ id: p.id, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, bin: this.bin });
	}

	/** Spawn a real roster agent for a workflow's parallel branch, run the task, resolve with its result. The agent stays in the roster. */
	private async spawnFleetBranch(repo: string, parentId: string, spec: BranchSpec): Promise<NodeResult> {
		const dto = await this.create({ repo, name: spec.name, model: spec.model, parentId, autoRoute: false });
		const rec = this.agents.get(dto.id);
		if (!rec) return { outcome: "failed", text: "branch agent not created" };
		return this.runAgentTask(rec, spec.task);
	}

	/** Prompt an agent and resolve once its turn ends, collecting the assistant text. */
	private runAgentTask(rec: AgentRecord, task: string): Promise<NodeResult> {
		const { promise, resolve } = Promise.withResolvers<NodeResult>();
		let buf = "";
		const onEvent = (frame: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } }) => {
			if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") buf += frame.assistantMessageEvent.delta ?? "";
			else if (frame.type === "agent_end") finish("succeeded");
		};
		const onExit = () => finish("failed");
		const timer = setTimeout(() => finish("failed"), 30 * 60_000);
		const finish = (outcome: "succeeded" | "failed"): void => {
			clearTimeout(timer);
			rec.agent.off("event", onEvent);
			rec.agent.off("exit", onExit);
			resolve({ outcome, text: buf.trim() });
		};
		rec.agent.on("event", onEvent);
		rec.agent.once("exit", onExit);
		this.append(rec, "user", task);
		rec.streaming = true;
		rec.dto.status = "working";
		this.emitAgent(rec);
		void rec.agent.prompt(task).catch(() => finish("failed"));
		return promise;
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
		// The author → validate → onboard process is a workflow graph now, not an imperative
		// sequence: a failed gate loops back to re-author (bounded), feeding the failure forward.
		const executor = new CommissionExecutor({
			author: (feedback) => architect.author(spec, dir, feedback),
			install: opts.install ? () => this.installWorker(dir) : undefined,
			validate: () => validateWorker(dir, spec, { requireAcceptance: opts.requireAcceptance }),
			onboard: (report) => this.onboardFlueWorker(spec, dir, report),
		});
		await new WorkflowEngine(await loadCommissionWorkflow(), executor).run(spec.purpose);
		const report = executor.report;
		if (report) this.log(report.ok ? "info" : "warn", `gate "${spec.name}": ${report.checks.map((c) => `${c.name}=${c.status}`).join(" ")}`);
		if (!executor.member || !report) return { ok: false, report: report ?? { ok: false, checks: [] }, dir };
		return { ok: true, report, member: executor.member, dir };
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
		a.on("ready", () => this.refreshCommands(rec));
		a.on("ui", (req: RpcExtensionUIRequest) => this.onUi(rec, req));
		a.on("hosttool", (call: { id: string; toolName: string; arguments: unknown }) => this.onHostTool(rec, call));
		a.on("stderr", (line: string) => this.log("warn", `[${rec.dto.name}] ${line}`));
		a.on("checkpoint", (state: WorkflowRunState) => {
			rec.options.workflowState = state;
			void this.persist();
		});
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
		if (frame.type === "available_commands_update") {
			this.storeCommands(rec, frame.commands);
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
				this.maybeCloseIssue(rec);
				break;
			}
		}
		rec.dto.status = this.derive(rec);
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
	}

	/** When auto-close is on, mark a dispatched issue done once its agent's run passed a verification gate. */
	private maybeCloseIssue(rec: AgentRecord): void {
		const issue = rec.dto.issue;
		if (!this.closeOnDone || !issue || this.closedIssues.has(issue.id)) return;
		const passed = rec.transcript.slice(-6).some((e) => e.kind === "assistant" && e.text.includes("✓ workflow"));
		if (!passed) return;
		this.closedIssues.add(issue.id);
		this.log("info", `auto-dispatch: closing ${issue.identifier ?? issue.id} (verification passed)`);
		void closePlaneIssue(issue).then((ok) => {
			if (!ok) this.log("warn", `auto-dispatch: could not close ${issue.identifier ?? issue.id}`);
		});
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

	/** Available slash commands for an agent (builtin + skills + extensions), if known. */
	commandsFor(id: string): CommandInfo[] | undefined {
		return this.agents.get(id)?.commands;
	}

	/** Proactively pull commands on (re)connect — omp's startup push may predate our wiring. */
	private refreshCommands(rec: AgentRecord): void {
		const drv = rec.agent as { getAvailableCommands?: () => Promise<{ commands?: unknown[] }> };
		if (typeof drv.getAvailableCommands !== "function") return;
		void drv
			.getAvailableCommands()
			.then((res) => this.storeCommands(rec, res?.commands))
			.catch(() => {
				/* transient; the push frame or a later refresh will fill it in */
			});
	}

	/** Normalize + store the agent's command list, emitting a `commands` event only on change. */
	private storeCommands(rec: AgentRecord, raw: unknown): void {
		const commands = normalizeCommands(raw);
		if (commands.length === 0) return;
		const prev = rec.commands;
		if (prev && prev.length === commands.length && prev.every((c, i) => c.name === commands[i].name)) return;
		rec.commands = commands;
		this.emit("event", { type: "commands", id: rec.dto.id, commands } satisfies SquadEvent);
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

	private writeChain: Promise<void> = Promise.resolve();

	/**
	 * Serialized + atomic writer. Each call chains its write after the previous one (so two writes
	 * never interleave), and resolves only once ITS write completes — making `await persist()` a real
	 * durability barrier that stop()/upgrade depend on. persistNow()'s temp+rename prevents partials.
	 */
	private async persist(): Promise<void> {
		const next = this.writeChain.then(
			() => this.persistNow(),
			() => this.persistNow(),
		);
		this.writeChain = next.catch(() => {});
		return next;
	}

	/** Atomic write: serialize into a temp file then rename, so a reader (or a restart) never sees a partial file. */
	private async persistNow(): Promise<void> {
		const agents = [...this.agents.values()].map((r) => r.options);
		const transcripts: Record<string, TranscriptEntry[]> = {};
		for (const r of this.agents.values()) if (r.transcript.length) transcripts[r.dto.id] = r.transcript;
		const features = [...this.featureStore.values()];
		const tmp = `${this.stateFile}.tmp`;
		try {
			await fs.writeFile(tmp, JSON.stringify({ version: 1, agents, transcripts, features }, null, 2));
			await fs.rename(tmp, this.stateFile);
		} catch {
			await fs.rm(tmp, { force: true }).catch(() => {});
		}
	}

	/** Re-spawn agents persisted from a previous run. Returns how many were restored. */
	async loadPersisted(): Promise<number> {
		let raw: string;
		try {
			raw = await fs.readFile(this.stateFile, "utf8");
		} catch {
			return 0;
		}
		const parsed = JSON.parse(raw) as { agents?: PersistedAgent[]; features?: PersistedFeature[] };
		for (const f of parsed.features ?? []) this.featureStore.set(f.id, f);
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
				parentId: p.parentId,
				featureId: p.featureId,
				workflow: p.workflow?.path,
				verify: p.workflow?.verify?.command,
				sandbox: p.sandbox,
				autoRoute: false,
			}).catch((err) => this.log("error", `restore ${p.name} failed: ${String(err)}`));
		}
		return list.length;
	}
}

function truncate(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** Map omp's raw command metadata (from `available_commands_update` / `get_available_commands`) to CommandInfo. */
function normalizeCommands(raw: unknown): CommandInfo[] {
	if (!Array.isArray(raw)) return [];
	const out: CommandInfo[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const c = item as { name?: unknown; description?: unknown; aliases?: unknown; source?: unknown; input?: unknown };
		if (typeof c.name !== "string") continue;
		const input = c.input && typeof c.input === "object" ? (c.input as { hint?: unknown }) : undefined;
		out.push({
			name: c.name,
			description: typeof c.description === "string" ? c.description : undefined,
			aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string") : undefined,
			hint: input && typeof input.hint === "string" ? input.hint : undefined,
			source: typeof c.source === "string" ? c.source : undefined,
		});
	}
	return out;
}

/**
 * Resolve a `--workflow` spec to a graph file: an existing path is used as-is;
 * otherwise a bare name resolves to a bundled graph (`<pkg>/workflows/<name>/workflow.fabro`),
 * making `--workflow research-plan-implement` (and plan-implement / fan-out) first-class.
 */
export function resolveWorkflowPath(spec: string): string {
	if (existsSync(spec)) return spec;
	const bundledDir = path.join(import.meta.dir, "..", "workflows", spec, "workflow.fabro");
	if (existsSync(bundledDir)) return bundledDir;
	const bundledFile = path.join(import.meta.dir, "..", "workflows", spec.endsWith(".fabro") ? spec : `${spec}.fabro`);
	if (existsSync(bundledFile)) return bundledFile;
	return spec;
}

let commissionWorkflow: Workflow | undefined;

/** Parse (once) the bundled commission graph that drives author → validate → onboard. */
async function loadCommissionWorkflow(): Promise<Workflow> {
	if (!commissionWorkflow) {
		const file = path.join(import.meta.dir, "..", "workflows", "commission", "workflow.fabro");
		commissionWorkflow = parseWorkflow(await fs.readFile(file, "utf8"));
	}
	return commissionWorkflow;
}
