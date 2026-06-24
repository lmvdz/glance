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
import { assessHealth, defaultHealthLimits, type HealthSample } from "./watchdog.ts";
import { estimateEta } from "./eta.ts";
import { FlueServiceDriver } from "./flue-service-driver.ts";
import { type BranchSpec, WorkflowDriver, type WorkflowFleet } from "./workflow-driver.ts";
import { SandboxAgentDriver } from "./sandbox-agent-driver.ts";
import { AcpAgentDriver } from "./acp-agent-driver.ts";
import { type Architect, OmpArchitect } from "./architect.ts";
import { validateWorker } from "./validate.ts";
import { CommissionExecutor } from "./workflow/commission-executor.ts";
import { WorkflowEngine } from "./workflow/engine.ts";
import { parseWorkflow } from "./workflow/dot.ts";
import type { NodeResult, Workflow, WorkflowRunState } from "./workflow/types.ts";
import { buildVerifyWorkflow } from "./workflow/verify-workflow.ts";
import { type Classify, detectVerify, ompClassify, routeIntake } from "./intake.ts";
import { Dispatcher } from "./dispatch.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Observer } from "./observer.ts";
import { Scout, unscannedReasoning } from "./scout.ts";
import { hardenedGitSync } from "./git-harden.ts";
import { Scheduler, liveAgents, occupyingAgents } from "./scheduler.ts";
import { RateLimitGate } from "./rate-limit.ts";
import { closePlaneIssue, createPlaneIssue, ensureFeatureModule, featureTickets, listPlaneIssues, planeRepos, startPlaneIssue } from "./plane.ts";
import { buildFeatures, featureLandStatus, type LandMember, landOrder } from "./features.ts";
import { landAgent, type LandOpts, type LandResult, withRepoLandLock } from "./land.ts";
import { autoLandOnSuccess } from "./autoland.ts";
import { ownershipConflict } from "./ownership.ts";
import { proofGate, runProof, sweepProofs } from "./proof.ts";
import { sweepLeases } from "./leases.ts";
import { sweepPresence } from "./presence.ts";
import { chooseFallback } from "./supervisor.ts";
import type {
	Actor,
	AuditEntry,
	IssueRef,
	PlaneTicket,
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
	RunReceipt,
	SandboxConfig,
	SquadEvent,
	TranscriptEntry,
	TranscriptKind,
} from "./types.ts";
import { type SubagentNode, SubagentTracker } from "./subagents.ts";
import { commandRole, effectiveRole, RbacDenied, roleAtLeast } from "./auth.ts";
import { hostAlive, pruneStaleSockets, reapOrphanHosts, socketPathFor } from "./agent-host.ts";
import { addWorktree, branchAhead, deleteBranchIfMerged, isGitRepo, listWorktrees, primaryBranch, removeWorktree, repoRoot, resolveWorktree, worktreeBase, worktreeStatus } from "./worktree.ts";
import { selectReapable, type WorktreeInfo } from "./worktree-reaper.ts";
import { changedFiles } from "./explore.ts";
import { appendReceipt, readReceipts, RunAccumulator } from "./receipts.ts";
import { appendAudit, type AuditQuery, makeAuditEntry, readAudit } from "./audit.ts";
import { landFailureCount, readLandLedger, recordLandOutcome } from "./land-ledger.ts";
import { buildDigest, fenceUntrusted, readDigest, writeDigest } from "./digest.ts";
import { redact } from "./redact.ts";
import { FileStore, type StateSnapshot, type Store } from "./dal/store.ts";

const MAX_TRANSCRIPT = 800;
const POLL_MS = 2500;
/**
 * Consecutive failed auto-lands before the manager PARKS a branch instead of re-merging it. The
 * count is read from the persistent audit log (consecutiveLandFailures), so it survives daemon
 * restarts — unlike the orchestrator's in-memory cap, whose reset on every restart let a
 * gate-failing branch be merged + rolled-back forever (the workflow_done auto-land path had no cap
 * at all). Override with OMP_SQUAD_AUTOLAND_FAIL_CAP. The Observer turns a parked branch into a
 * dedup'd bug issue so the fleet re-does the work on a fresh branch.
 */
function autoLandFailCap(): number {
	return Number(process.env.OMP_SQUAD_AUTOLAND_FAIL_CAP) || 3;
}

// liveAgents + the WIP cap live in ./scheduler.ts now; re-export keeps the public import path stable.
export { liveAgents };

/** Absolute live-agent ceiling that even bypass-cap (fan-out) spawns respect, so runaway fan-out can't
 *  melt the host. Default ≈ the host's CPU count (min 3) so a bare launch is bounded; override with OMP_SQUAD_MAX_AGENTS. */
export function hardAgentCeiling(): number {
	return Number(process.env.OMP_SQUAD_MAX_AGENTS) || Math.max(os.cpus().length || 2, 3);
}

/** Persisted agents to take over on restart: not already reattached (live), not flue, and whose worktree
 *  still holds context on disk. Live hosts are reattached by reconnectLive; a gone worktree re-dispatches. */
export function agentsToAdopt<T extends { id: string; kind?: string; worktree?: string }>(
	persisted: T[],
	rosterIds: ReadonlySet<string>,
	worktreeExists: (worktree: string) => boolean,
): T[] {
	return persisted.filter((p) => p.kind !== "flue-service" && !rosterIds.has(p.id) && !!p.worktree && worktreeExists(p.worktree));
}

/**
 * From the adoptable set, resume only agents that still have UNLANDED work, capped at `cap`. A restart
 * otherwise re-spawned EVERY orphaned worktree at once (adoptOrphanedAgents uses bypassCap, so MAX_AGENTS
 * didn't hold) — N simultaneous omp hosts that OOM the box. Done/clean agents are skipped (their open
 * issue, if any, is re-dispatched gradually under the WIP cap); `cap<=0` ⇒ adopt none.
 */
export function selectAdoptable<T extends { id: string }>(eligible: T[], hasWork: (a: T) => boolean, cap: number): T[] {
	if (cap <= 0) return [];
	return eligible.filter(hasWork).slice(0, cap);
}

/**
 * Unique agent id: name + time + random suffix. The branch and worktree derive from this id (NOT the
 * agent's display name), so two agents — even same name, even spawned in the same millisecond or across
 * a daemon restart — never share a branch or worktree. (The name alone collides: dispatched agents fall
 * back to `agent-N` whose counter resets every restart, so "agent-1" gets reused.)
 */
export function newAgentId(name: string): string {
	return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** UI methods that block the agent on a human decision. */
const BLOCKING_UI_METHODS: Record<string, true> = {
	confirm: true,
	input: true,
	select: true,
	editor: true,
};

/** Actor stamped on auto-supervised answers so the transcript/audit log shows they weren't human. */
const AUTO_ACTOR: Actor = { id: "auto-supervise", displayName: "auto-supervise", origin: "local" };

/**
 * Destructive / irreversible / blast-radius-escaping signals that must NEVER be auto-answered
 * (OMP_SQUAD_AUTOSUPERVISE). Matched case-insensitively against a request's title + message +
 * options; any hit leaves the request for a human. Intentionally broad — false positives only
 * cost a human glance, false negatives can wreck main / prod.
 */
const RISKY_RE =
	/force[- ]?push|--force\b|reset --hard|\bdelete\b|\bdestroy\b|\bdrop\b|rm\s+-rf|\bpublish\b|\bdeploy\b|\brelease\b|\bproduction\b|\bprod\b|\bmainnet\b|\bsecret\b|\bcredential\b|\bpassword\b|\bwipe\b|\btruncate\b|\boverwrite\b|push.*\bmain\b|merge.*\bmain\b/i;

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
	/** Live receipt accumulator for the in-flight run (one per agent_start..end). */
	run?: RunAccumulator;
}

export interface SquadManagerOptions {
	operator?: Actor;
	bus?: FederationBus;
	stateDir?: string;
	/** omp binary override (passed to each RpcAgent). */
	bin?: string;
	/** Autonomous-land mode: a workflow run that succeeds lands its own branch (OMP_SQUAD_AUTOLAND). */
	autoLand?: boolean;
	/** Org-scoped worktree base (DB mode). Default: worktree.ts's global worktreeBase(). */
	worktreeBase?: string;
	/** Persistence seam. Default: FileStore(stateDir) — today's state.json behavior. */
	store?: Store;
	/** When the registry owns machine-global janitors (reap orphan hosts / sockets / registries over
	 *  the union of all orgs), the per-org manager skips them so it can't reap another org's hosts. */
	skipGlobalJanitors?: boolean;
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
	private readonly featureStore = new Map<string, PersistedFeature>();
	private readonly bin?: string;
	private readonly autoLand: boolean;
	/** Org-scoped worktree base override (DB mode); undefined ⇒ global worktreeBase(). */
	private readonly worktreeBaseDir?: string;
	/** Persistence seam (FileStore in file mode, DbStore in DB mode). */
	private readonly store: Store;
	/** True when the registry owns the machine-global janitors (DB mode). */
	private readonly skipGlobalJanitors: boolean;
	/** Safety valve (OMP_SQUAD_LAND_CONFIRM, default ON; set =0 to auto-merge): a GREEN verify stages a one-tap Land instead of blind-merging into the shared checkout. */
	private readonly landConfirm = process.env.OMP_SQUAD_LAND_CONFIRM !== "0";
	private pollTimer?: Timer;
	/** Throttle counter for the periodic orphan-host reap in poll(). */
	private reapTicks = 0;
	/** Last logged warning set, so a persistent warning logs once (on change), not every poll. */
	private lastWarnKey = "";
	private dispatcher?: Dispatcher;
	private readonly scheduler = new Scheduler();
	/** Pauses auto-dispatch while the model subscription is rate-limited (5h/weekly cap). Fed by agents'
	 *  auto_retry_start usage-limit events; consulted by the dispatcher before it spawns. */
	private readonly rateLimit = new RateLimitGate();
	private orchestrator?: Orchestrator;
	private observer?: Observer;
	/** Scout (sibling to the Observer) — semantic backlog harvester over agent reasoning. */
	private scout?: Scout;
	/** Per-agent scout scan cursor (agentId → last-scanned transcript ts); advanced by takeScoutReasoning. */
	private readonly scoutCursor = new Map<string, number>();
	/** OMP_SQUAD_AUTOCLOSE (default ON): close a tracking issue when its branch LANDS — never on a bare gate-pass. */
	private readonly closeOnDone = process.env.OMP_SQUAD_AUTOCLOSE !== "0";
	private llmClassify?: Classify;
	private readonly closedIssues = new Set<string>();
	/** Per-agent count of auto-supervised answers spent this run (OMP_SQUAD_AUTOSUPERVISE attempt budget). */
	private readonly superviseBudget = new Map<string, number>();
	/** Agent ids the daemon reattached to (surviving hosts) this run. */
	private readonly reattached = new Set<string>();
	private idSeq = 0;

	constructor(opts: SquadManagerOptions = {}) {
		super();
		this.operator = opts.operator ?? LOCAL_ACTOR;
		this.bus = opts.bus ?? new NullFederationBus();
		this.stateDir = opts.stateDir ?? path.join(os.homedir(), ".omp", "squad");
		this.bin = opts.bin;
		this.autoLand = opts.autoLand ?? false;
		this.worktreeBaseDir = opts.worktreeBase;
		this.store = opts.store ?? new FileStore(this.stateDir);
		this.skipGlobalJanitors = opts.skipGlobalJanitors ?? false;
		this.llmClassify = process.env.OMP_SQUAD_LLM_ROUTER ? ompClassify(this.bin) : undefined;
	}

	async start(): Promise<void> {
		// Recovery only matters for a daemon with prior state. A fresh start has nothing to reconnect,
		// reap, or adopt — and a fresh-state manager must NOT reap the shared sockets dir out from under
		// a concurrent daemon (or test). reconnectLive (use live) → reapOrphans → adopt worktree context.
		const snapshot = (await this.store.hasState()) ? await this.store.load() : undefined;
		if (snapshot) {
			await this.reconnectLive(snapshot);
			if (!this.skipGlobalJanitors) await this.reapOrphans();
			await this.adoptOrphanedAgents(snapshot);
		}
		// DB mode: the registry runs pruneStaleSockets once over all orgs (a per-org manager must not).
		if (!this.skipGlobalJanitors) await pruneStaleSockets().catch(() => []);
		await this.bus.start();
		this.bus.onRemoteCommand((remote: RemoteCommand) => {
			// RBAC authorization happens inside applyCommand against remote.actor's tier (a role-less
			// peer is read-only). NullFederationBus never fires this; a denied command is logged there,
			// so swallow the rejection here rather than crash the bus listener.
			void this.applyCommand(remote.cmd, remote.actor).catch((err) => {
				if (!(err instanceof RbacDenied)) this.log("error", `remote command failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		});
		this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
		// Auto-dispatch + auto-land (Orchestrator) live in start(), so they are per-org for free in DB
		// mode (one loop per SquadManager). ponytail: Plane repo config (planeRepos) is still read
		// daemon-global, so every org would dispatch the same repos — meaningful only for single-org
		// self-host. Ceiling: no per-tenant Plane wiring. Upgrade path: thread per-org Plane config
		// through RegistryDeps and pass it into each manager (deferred follow-up, out of P2 scope).
		if (process.env.OMP_SQUAD_AUTODISPATCH !== "0" && planeRepos().length > 0) {
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
				liveCount: () => occupyingAgents(this.list()), // only starting/working/input occupy a slot — idle/done agents must not pin the cap
				maxWip: this.scheduler.cap(),
				paused: () => this.rateLimit.paused(),
			});
			this.dispatcher.start(interval);
			this.log("info", `auto-dispatch on (every ${Math.round(interval / 1000)}s, max ${maxActive}${this.closeOnDone ? ", auto-close" : ""})`);
		}
		this.orchestrator = new Orchestrator({
			listAgents: () => this.list(),
			spawn: (opts) => this.create(opts),
			verify: async (id) => (await this.verifyFeature(id))?.ok ?? false,
			land: async (id) => (await this.landFeature(id)).ok,
			verifyAgent: (id) => this.verifyAgentWork(id),
			landAgentWork: async (id) => (await this.land(id)).ok,
			agentHasWork: (id) => this.agentHasUnlandedWork(id),
			holdForConfirm: this.landConfirm,
			notifyReady: (id) => this.markLandReady(id),
			log: (m) => this.log("info", `orchestrator: ${m}`),
		});
		this.orchestrator.start();

		// Observer (OMPSQ-52) — periodic self-audit sibling to the orchestrator. File mode only for now:
		// it observes the first configured Plane repo. ponytail: a multi-repo / per-org observer (one per
		// SquadManager in DB mode) is a later follow-up — wire per-org Plane config through and loop repos.
		const observeRepos = planeRepos();
		if (process.env.OMP_SQUAD_OBSERVE !== "0" && observeRepos.length > 0) {
			const repo = observeRepos[0];
			this.observer = new Observer({
				listAgents: () => this.list(),
				listIssues: () => listPlaneIssues(repo),
				fileIssue: (title) => createPlaneIssue(repo, title),
				closeIssue: (ref) => closePlaneIssue(ref),
				removeAgent: (id) => this.remove(id, false),
				runGate: () => this.runMainGate(repo),
				gitAheadOfMain: (a) => this.aheadOfMain(a),
				untrackedInMain: () => this.untrackedInMain(repo),
				filesOnAgentBranch: (a) => this.filesOnAgentBranch(a),
				landLedger: () => readLandLedger(this.stateDir),
				stateDir: this.stateDir,
				log: (m) => this.log("info", `observer: ${m}`),
			});
			this.observer.start();
			this.log("info", `observer on (auditing ${repo})`);
		}

		// Scout (sibling to the Observer) — semantic harvest, not operational audit: it reads agents'
		// reasoning and files the latent items they surfaced but didn't do. Mid-run via the periodic sweep
		// (liveReasoning) + run-end via finalizeRun. On when Plane is configured; OMP_SQUAD_SCOUT=0 to disable.
		if (process.env.OMP_SQUAD_SCOUT !== "0" && observeRepos.length > 0) {
			const repo = observeRepos[0];
			this.scout = new Scout({
				extract: ompClassify(this.bin),
				listIssues: () => listPlaneIssues(repo),
				fileIssue: (title, body) => createPlaneIssue(repo, title, body),
				liveReasoning: () =>
					[...this.agents.values()]
						.filter((r) => r.dto.status === "working")
						.map((r) => ({ agent: r.dto.name, task: r.options.task, issue: r.dto.issue?.identifier ?? r.dto.issue?.name, text: this.takeScoutReasoning(r) }))
						.filter((s) => s.text.length > 0),
				stateDir: this.stateDir,
				log: (m) => this.log("info", `scout: ${m}`),
			});
			this.scout.start();
			this.log("info", `scout on (harvesting reasoning → ${repo})`);
		}
	}

	/** Spawn a routed agent for a Plane issue — the auto-dispatch entry point (intent → process). */
	private async dispatchSpawn(repo: string, issue: IssueRef): Promise<void> {
		const task = `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.name}`;
		await this.create({ repo, name: issue.identifier?.toLowerCase(), task, issue, autoRoute: true, approvalMode: "yolo" });
	}

	async stop(): Promise<void> {
		clearInterval(this.pollTimer);
		this.dispatcher?.stop();
		this.orchestrator?.stop();
		this.observer?.stop();
		this.scout?.stop();
		await this.persist();
		// Detach (don't kill): leave each agent's detached host + omp running so a
		// restart/upgrade reconnects to live agents with full context.
		for (const r of this.agents.values()) r.agent.detach?.();
		await this.bus.stop();
	}

	/** On daemon start, reattach to any agent whose detached host survived (upgrade/restart). */
	private async reconnectLive(snapshot: StateSnapshot): Promise<number> {
		for (const f of snapshot.features) this.featureStore.set(f.id, f);
		let n = 0;
		for (const p of snapshot.agents) {
			if (this.agents.has(p.id)) continue;
			if (p.kind === "flue-service") continue; // flue workers are not reattached
			if (p.kind === "workflow") {
				// A workflow run survives a restart only if its inner thread is still alive AND we have a
				// checkpoint to resume the graph from; otherwise the orchestration is unrecoverable.
				const innerAlive = await hostAlive(socketPathFor(`${p.id}-wf`));
				if (innerAlive && p.workflowState) {
					await this.attachExisting(p, snapshot.transcripts[p.id] ?? []).catch((err) => this.log("warn", `resume ${p.name} failed: ${String(err)}`));
					n++;
				} else if (innerAlive) {
					this.log("warn", `workflow ${p.name} has a live thread but no checkpoint — cannot resume the graph`);
				}
				continue;
			}
			if (!(await hostAlive(socketPathFor(p.id)))) continue;
			await this.attachExisting(p, snapshot.transcripts[p.id] ?? []).catch((err) => this.log("warn", `reattach ${p.name} failed: ${String(err)}`));
			n++;
		}
		if (n) this.log("info", `reattached ${n} live agent(s)`);
		return n;
	}

	/** After live reattach + orphan reap: take over persisted agents whose host is gone but whose worktree
	 *  still holds built-up context — re-create them in place (idle; the orchestrator then verifies/lands).
	 *  So a restart RESUMES the issue with its context instead of re-dispatching a fresh worktree. */
	private async adoptOrphanedAgents(snapshot: StateSnapshot): Promise<number> {
		const eligible = agentsToAdopt(snapshot.agents, new Set(this.agents.keys()), (wt) => existsSync(wt));
		// Probe each for unlanded work, then cap re-adoption at the agent ceiling. Re-spawning EVERY
		// orphaned worktree at once (bypassCap) is what OOM'd the host on restart. Resume only agents with
		// work to continue; done/clean ones are dropped (a still-open issue re-dispatches gradually under
		// the WIP cap), and at most (ceiling - already-live) are taken over this boot.
		const work = new Map<string, boolean>();
		for (const p of eligible) work.set(p.id, await this.persistedHasWork(p));
		const adopt = selectAdoptable(eligible, (p) => work.get(p.id) ?? false, hardAgentCeiling() - this.agents.size);
		const skipped = eligible.length - adopt.length;
		let n = 0;
		for (const p of adopt) {
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
				owns: p.owns,
				workflow: p.workflow?.path,
				verify: p.workflow?.verify?.command,
				// Resume the graph from its checkpoint; without this the adopted workflow restarts from
				// scratch — re-running completed stages and re-committing their work (OMPSQ-165).
				workflowState: p.workflowState,
				sandbox: p.sandbox,
				autoRoute: false,
				bypassCap: true,
				adopted: true, // OMPSQ-164: re-adopted with complete work ⇒ orchestrator auto-lands it directly
			}).then(() => { n++; }).catch((err) => this.log("warn", `take over ${p.name} failed: ${String(err)}`));
		}
		if (n || skipped) this.log("info", `took over ${n} orphaned worktree(s) with work; skipped ${skipped} (done/clean or over the ${hardAgentCeiling()}-agent cap)`);
		return n;
	}

	/** Does a persisted (pre-adoption) agent still have local work to resume — uncommitted edits or commits
	 *  ahead of base? Mirrors agentHasUnlandedWork for a record not yet in the roster. */
	private async persistedHasWork(p: { repo: string; branch?: string; worktree?: string }): Promise<boolean> {
		if (!p.worktree) return false;
		const st = await worktreeStatus(p.worktree).catch(() => ({ branch: undefined, dirtyFiles: [] as string[] }));
		if (st.dirtyFiles.length > 0) return true;
		if (!p.branch) return false;
		const r = Bun.spawnSync(["git", "-C", p.repo, "rev-list", "--count", `HEAD..${p.branch}`], { stdout: "pipe", stderr: "ignore" });
		return r.exitCode === 0 && Number(r.stdout.toString().trim()) > 0;
	}

	/** Rebuild an AgentRecord for a persisted agent and attach to its live host. */
	private async attachExisting(p: PersistedAgent, transcript: TranscriptEntry[] = []): Promise<void> {
		const dto: AgentDTO = {
			id: p.id,
			name: p.name,
			status: "starting",
			startedAt: Date.now(),
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
			owns: p.owns,
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

	/** Resolve a feature's associated Plane tickets (status + deep link) for display. */
	async featurePlaneTickets(id: string): Promise<{ tickets: PlaneTicket[] | null; moduleUrl?: string }> {
		const pf = this.featureStore.get(id);
		let idents = pf?.plane?.issueIdentifiers ?? [];
		let repo = pf?.repo;
		if (!idents.length) {
			// derived feature (identifiers live in plan docs) — fall back to the full build
			const f = (await this.features()).find((x) => x.id === id);
			idents = f?.issueIdentifiers ?? [];
			repo = f?.repo ?? repo;
		}
		const tickets = idents.length && repo ? await featureTickets(repo, idents) : [];
		return { tickets, moduleUrl: pf?.plane?.moduleUrl };
	}

	/** Create a Plane module for a feature and group its issues under it; persists the link. */
	async createFeatureModule(id: string): Promise<{ moduleUrl: string } | null> {
		const pf = this.featureStore.get(id);
		if (!pf) return null;
		const f = (await this.features(pf.repo)).find((x) => x.id === id);
		const idents = f?.issueIdentifiers ?? pf.plane?.issueIdentifiers ?? [];
		const mod = await ensureFeatureModule(pf.repo, pf.title, idents);
		if (!mod) return null;
		pf.plane = { ...(pf.plane ?? {}), moduleId: mod.moduleId, moduleUrl: mod.moduleUrl, issueIdentifiers: idents };
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return { moduleUrl: mod.moduleUrl };
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
		if (!force) {
			for (const m of members) {
				const reason = await proofGate(pf.repo, m.worktree, m.branch);
				if (reason) return { ok: false, stopped: `${m.agentName ?? m.branch ?? "member"}: ${reason}`, results: [] };
			}
		}
		const results: { agentId?: string; branch?: string; ok: boolean; detail?: string }[] = [];
		for (const w of landOrder(wts)) {
			const rec = w.agentId ? this.agents.get(w.agentId) : undefined;
			const busy = rec ? rec.dto.status === "working" || rec.dto.status === "starting" || rec.dto.status === "input" : false;
			const res = await landAgent({ repo: pf.repo, worktree: w.worktree, branch: w.branch, message: `feature(${pf.title}): land ${w.branch ?? "changes"}`, commitWip: !busy });
			results.push({ agentId: w.agentId, branch: w.branch, ok: res.ok, detail: res.detail });
			if (!res.ok) { this.emitFeaturesChanged(); void this.recordAudit(LOCAL_ACTOR, "land", id, "error", `feature land failed on ${w.branch}`); void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land", target: id, detail: { outcome: "error", branch: w.branch } }).catch(() => {}); return { ok: false, stopped: `land failed on ${w.branch}`, results }; }
			void this.closeLandedIssue(rec?.dto.issue); // landed branch ⇒ close its tracking issue (idempotent)
		}
		this.emitFeaturesChanged();
		void this.recordAudit(LOCAL_ACTOR, "land", id, "ok", `landed ${results.length} branch(es)`);
		void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land", target: id, detail: { outcome: "ok", branches: results.length } }).catch(() => {});
		return { ok: true, results };
	}

	/**
	 * Single-agent land path: commit + merge ONE agent's branch, then close its tracking issue on
	 * success. The web Land button / server `/api/agents/:id/land` land via the same land.ts primitive
	 * and already call `closeLandedIssue`; this method owns BOTH steps in the manager so close-on-land
	 * is guaranteed for the single-agent path too — not only the multi-branch `landFeature`. Close is
	 * idempotent (`closedIssues`) and best-effort. Busy-aware `commitWip` mirrors the feature path.
	 */
	async land(id: string, message?: string, opts: { auto?: boolean } = {}): Promise<LandResult> {
		const rec = this.agents.get(id);
		if (!rec) return { ok: false, committed: false, merged: false, message: "no such agent", detail: "no such agent" };
		const dto = rec.dto;
		const auto = opts.auto ?? true;
		// Restart-safe auto-land cap: a branch whose merge keeps failing the gate is parked rather than
		// re-merged + rolled-back forever. The streak is keyed by BRANCH (stable across re-adoption,
		// unlike the agent id which create() re-mints) and persisted, so it holds across daemon restarts.
		// Operator lands (server /api/agents/:id/land → landAgent directly) bypass this method, so a human
		// is never blocked; the Observer files a dedup'd bug issue for a parked branch so the fleet re-does
		// the work on a fresh branch.
		if (auto && dto.branch) {
			const fails = landFailureCount(this.stateDir, dto.branch);
			if (fails >= autoLandFailCap()) {
				this.log("warn", `auto-land parked for ${dto.branch} — ${fails} consecutive failed lands; awaiting a fix (the observer files a bug issue)`);
				return { ok: false, committed: false, merged: false, message: "auto-land parked", detail: `auto-land parked: ${fails} consecutive failed lands on ${dto.branch} — not re-merging until the branch is fixed` };
			}
		}
		const busy = dto.status === "working" || dto.status === "starting" || dto.status === "input";
		const result = await this.landBranch({
			repo: dto.repo,
			worktree: dto.worktree,
			branch: dto.branch,
			message: message ?? `squad(${dto.name}): land ${dto.branch ?? "changes"}`,
			commitWip: !busy,
		});
		// Update the branch's failure streak: an auto-land failure bumps it (drives the cap above), any
		// success clears it. A manual (auto:false) failure is the operator's call — never penalized.
		if (auto || result.ok) recordLandOutcome(this.stateDir, dto.branch, result.ok, result.detail ?? result.message);
		if (result.ok) {
			rec.dto.landReady = false; // merged ⇒ clear the confirm-mode staged flag
			this.emitAgent(rec);
			await this.closeLandedIssue(dto.issue); // landed ⇒ close its tracking issue (idempotent, best-effort)
		}
		void this.recordAudit(LOCAL_ACTOR, "land", id, result.ok ? "ok" : "error", result.detail ?? result.message);
		void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land", target: id, detail: { outcome: result.ok ? "ok" : "error" } }).catch(() => {});
		return result;
	}

	/**
	 * Confirm-mode (OMP_SQUAD_LAND_CONFIRM): the auto-land loop verified GREEN but is holding the
	 * merge. Flag the agent ready-to-land so the UI surfaces a one-tap Land, and emit an update.
	 */
	private markLandReady(id: string): void {
		const rec = this.agents.get(id);
		if (!rec) return;
		rec.dto.landReady = true;
		this.emitAgent(rec);
		this.log("info", `land-confirm: ${id} verified — ready to land`);
	}

	/** Seam over the land.ts primitive so the single-agent land path is unit-testable (inject a fake land). */
	protected landBranch(opts: LandOpts): Promise<LandResult> {
		return landAgent(opts);
	}

	/**
	 * Synthetic DTO returned when a spawn is parked at the WIP cap (OMP_SQUAD_QUEUE_ON_FULL). It is
	 * NOT added to the roster — the `queued: true` flag is the signal to the caller (status is a
	 * placeholder); the orchestrator drains the scheduler queue and spawns the real agent once a
	 * slot frees.
	 */
	private queuedDto(name: string, opts: CreateAgentOptions): AgentDTO {
		return {
			id: `queued-${name}-${Date.now().toString(36)}`,
			name,
			status: "starting",
			queued: true,
			kind: opts.workflow || opts.verify ? "workflow" : "omp-operator",
			repo: opts.repo,
			worktree: opts.existingPath ?? opts.repo,
			branch: opts.branch ?? `squad/${name}`,
			model: opts.model,
			approvalMode: opts.approvalMode ?? "write",
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
			issue: opts.issue,
			featureId: opts.featureId,
			owns: opts.owns,
		};
	}

	/** Run the feature's acceptance command in each member worktree, recording a land proof per branch. */
	async verifyFeature(id: string): Promise<{ ok: boolean; command?: string; results: { agentId?: string; branch?: string; ok: boolean; detail?: string; artifacts: number }[] } | null> {
		const pf = this.featureStore.get(id);
		if (!pf) return null;
		const command = pf.acceptance ?? (await detectVerify(pf.repo));
		if (!command) return { ok: false, results: [{ ok: false, detail: "no acceptance command — set the feature's acceptance or add a test script to the repo", artifacts: 0 }] };
		this.snapshotBranches(id);
		const members: LandMember[] = [...this.agents.values()].filter((r) => r.dto.featureId === id).map((r) => ({ agentId: r.dto.id, agentName: r.dto.name, branch: r.dto.branch, worktree: r.dto.worktree, repo: pf.repo }));
		for (const b of pf.branches ?? []) if (!members.some((m) => m.agentId === b.agentId)) members.push({ agentId: b.agentId, branch: b.branch, worktree: b.worktree, repo: pf.repo });
		const results: { agentId?: string; branch?: string; ok: boolean; detail?: string; artifacts: number }[] = [];
		for (const m of members) {
			const proof = await runProof({ repo: pf.repo, worktree: m.worktree, command });
			results.push({ agentId: m.agentId, branch: m.branch, ok: proof.ok, detail: proof.detail, artifacts: proof.artifacts.length });
		}
		this.emitFeaturesChanged();
		return { ok: results.every((r) => r.ok), command, results };
	}

	/**
	 * Cheap "has unlanded work" probe for the auto-land loop — uncommitted edits, or commits ahead
	 * of the repo's checked-out base. Gates the costly acceptance run so it never fires on an idle
	 * agent with nothing to merge.
	 */
	private async agentHasUnlandedWork(id: string): Promise<boolean> {
		const rec = this.agents.get(id);
		if (!rec?.dto.branch) return false;
		const st = await worktreeStatus(rec.dto.worktree).catch(() => ({ branch: undefined, dirtyFiles: [] as string[] }));
		if (st.dirtyFiles.length > 0) return true;
		const r = Bun.spawnSync(["git", "-C", rec.dto.repo, "rev-list", "--count", `HEAD..${rec.dto.branch}`], { stdout: "pipe", stderr: "ignore" });
		return r.exitCode === 0 && Number(r.stdout.toString().trim()) > 0;
	}

	// ── Observer edges (OMPSQ-52) — read-only git probes + the main gate, injected into Observer. ──

	/** Commits on an agent's branch not in main's HEAD: 0 ⇒ landed; >0 ⇒ unlanded; -1 ⇒ no branch / unknown. */
	private aheadOfMain(a: AgentDTO): number {
		if (!a.branch) return -1;
		const r = hardenedGitSync(["-C", a.repo, "rev-list", "--count", `HEAD..${a.branch}`]);
		return r.code === 0 ? Number(r.stdout.trim()) || 0 : -1;
	}

	/** Untracked file paths in the main checkout (the auto-land hazard surface). */
	private untrackedInMain(repo: string): string[] {
		const r = hardenedGitSync(["-C", repo, "status", "--porcelain", "--untracked-files=all"]);
		if (r.code !== 0) return [];
		return r.stdout
			.split("\n")
			.filter((l) => l.startsWith("??"))
			.map((l) => l.slice(3).trim())
			.filter((f) => f.length > 0);
	}

	/** Tracked files on an agent's branch; `[]` when no branch / not a repo. */
	private filesOnAgentBranch(a: AgentDTO): string[] {
		if (!a.branch) return [];
		const r = hardenedGitSync(["-C", a.repo, "ls-tree", "-r", "--name-only", a.branch]);
		return r.code === 0 ? r.stdout.split("\n").filter((f) => f.length > 0) : [];
	}

	/**
	 * Run the acceptance gate (the repo's `check` + `test` scripts) on main → {ok, firstFailure?}.
	 * Total by contract: any spawn failure yields ok:false, never a throw (the observer tick must not crash).
	 * Serialized against lands via withRepoLandLock: the gate reads the same main tree a land mutates
	 * (merge / reset --hard), so running it concurrently makes it `(fail)` against a half-merged main and
	 * file a false `regression:` bug (OMPSQ-168). The lock makes the gate and lands mutually exclusive.
	 * ponytail: runs the full gate per observer tick; the Observer's own overlap guard prevents pile-up,
	 * but a long suite makes ticks costly — throttle (run every Nth tick) if it ever bites.
	 */
	private runMainGate(repo: string): Promise<{ ok: boolean; firstFailure?: string }> {
		return withRepoLandLock(repo, async () => {
			try {
				const proc = Bun.spawn(["bash", "-lc", "bun run check && bun test"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
				const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
				if (code === 0) return { ok: true };
				// First failing test name from bun's "(fail) <name>" lines; fall back to the tsc/first error line.
				const text = `${out}\n${err}`;
				const failLine = text.split("\n").find((l) => l.includes("(fail)"));
				const firstFailure = failLine ? failLine.replace(/.*\(fail\)\s*/, "").trim() : text.split("\n").find((l) => l.trim().length > 0)?.trim();
				return { ok: false, firstFailure: firstFailure?.slice(0, 200) };
			} catch (e) {
				return { ok: false, firstFailure: e instanceof Error ? e.message : String(e) };
			}
		});
	}

	/**
	 * Acceptance gate for a single agent's worktree — the featureless mirror of verifyFeature. No
	 * acceptance command in the repo ⇒ false, so the loop never auto-merges unverified work.
	 */
	async verifyAgentWork(id: string): Promise<boolean> {
		const rec = this.agents.get(id);
		if (!rec) return false;
		const command = await detectVerify(rec.dto.repo);
		if (!command) return false;
		const proof = await runProof({ repo: rec.dto.repo, worktree: rec.dto.worktree, command });
		return proof.ok;
	}

	private emitFeaturesChanged(): void {
		void this.persist();
		this.emit("event", { type: "features-changed" } satisfies SquadEvent);
	}

	// ── Roster mutation ───────────────────────────────────────────────────────

	async create(opts: CreateAgentOptions, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		if (opts.owns?.length) {
			const conflict = ownershipConflict([...this.agents.values()].map((r) => r.dto), opts.repo, opts.owns);
			if (conflict) throw new Error(`path ownership conflict: ${conflict.paths.join(", ")} held by agent "${conflict.agent}" — narrow the scope or stop that agent`);
		}
		// Global concurrency ceiling (see Scheduler). Restore / fan-out recreate already-counted agents → bypassCap.
		if (!opts.bypassCap) {
			// WIP cap counts only agents OCCUPYING a slot (starting/working/input); idle/landed agents must not block new dispatch.
			const live = occupyingAgents(this.list());
			if (!this.scheduler.canAdmit(live)) {
				// Denied by the count ceiling OR by host resource pressure (CPU/RAM): the count cap
				// bounds agents, but each is several processes, so admission also backs off when the
				// host is actually loaded (Scheduler.canAdmit → resource.ts). With OMP_SQUAD_QUEUE_ON_FULL
				// the spawn is parked and the orchestrator drains it once a slot frees AND pressure clears;
				// flag off ⇒ the historical hard error. Count-path behaviour is unchanged.
				const reason = this.scheduler.pressured()
					? "host under resource pressure"
					: `WIP cap reached (${live}/${this.scheduler.cap()})`;
				if (process.env.OMP_SQUAD_QUEUE_ON_FULL) {
					this.scheduler.enqueue(opts);
					const qname = opts.name?.trim() || `agent-${++this.idSeq}`;
					this.log("info", `${reason} — queued "${qname}" (${this.scheduler.queued} waiting)`);
					void this.recordAudit(actor, "create", qname, "ok", `queued — ${reason}`);
					return this.queuedDto(qname, opts);
				}
				throw new Error(`${reason} — finish or remove an agent before spawning`);
			}
		}
		const name = opts.name?.trim() || `agent-${++this.idSeq}`;
		const id = newAgentId(name);
		const branch = opts.branch ?? `squad/${id}`;
		if (opts.task && opts.autoRoute !== false && !opts.workflow && !opts.verify && !opts.sandbox) {
			const decision = await routeIntake(opts.task, opts.repo, this.llmClassify);
			opts = { ...opts, workflow: decision.workflow, verify: decision.verify, thinking: decision.thinking ?? opts.thinking };
			this.log("info", `routed "${name}": ${decision.reason}`);
		}
		// work → Plane: a freshly-spawned, issue-less task self-registers as a tracked Plane issue,
		// so the fleet is observable from the backlog without a manual plan-to-plane step. No-ops when
		// Plane is unconfigured; restore / fan-out / flue paths never set `track`.
		if (opts.track && !opts.issue && opts.task) {
			const ref = await createPlaneIssue(opts.repo, opts.task.split("\n")[0].slice(0, 120).trim() || name);
			if (ref) {
				opts = { ...opts, issue: ref };
				this.log("info", `tracked "${name}" as Plane ${ref.identifier ?? ref.id}`);
				void startPlaneIssue(ref); // backlog → started immediately; best-effort, never throws
			}
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
			const wt = await resolveWorktree(opts.repo, branch, addWorktree, isGitRepo, this.worktreeBaseDir);
			cwd = wt.cwd;
			repo = wt.repo;
			resolvedBranch = wt.branch;
			if (wt.inPlace) {
				// Non-git target dir: no isolation, but "spawn anywhere" still works. A real git checkout
				// that fails worktree creation now throws instead (OMPSQ-40) — never run on the shared tree.
				this.log("warn", `${opts.repo} is not a git repo — running agent in place (no isolation)`);
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
			runtime: opts.runtime,
			workflow: opts.workflow ? { path: opts.workflow } : opts.verify ? { verify: { command: opts.verify } } : undefined,
			// Carry the resumable checkpoint so an adopted/restored workflow continues its graph from the
			// last node boundary instead of re-running completed stages (and duplicating their commits).
			workflowState: opts.workflowState,
			sandbox: opts.sandbox,
			parentId: opts.parentId,
			featureId: opts.featureId,
			owns: opts.owns,
		};

		const dto: AgentDTO = {
			id,
			name,
			status: "starting",
			startedAt: Date.now(),
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
			owns: opts.owns,
			adopted: opts.adopted,
		};

		const agent = this.makeDriver(persisted);
		const rec: AgentRecord = { dto, agent, options: persisted, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() };
		this.agents.set(id, rec);
		this.wire(rec);
		this.emitAgent(rec);

		let started = false;
		try {
			await agent.start();
			started = true;
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
			// start() (or its handshake) threw: the driver may have spawned a backing
			// child/container before failing. Tear it down so it doesn't leak — nothing
			// reaps ACP children or sandbox containers (OMPSQ-163, OMPSQ-146).
			if (!started) await agent.stop().catch(() => {});
			this.fail(rec, err);
		}

		await this.persist();
		const failed = rec.dto.status === "error";
		void this.recordAudit(actor, "create", rec.dto.id, failed ? "error" : "ok", failed ? rec.dto.error : truncate(opts.task ?? rec.dto.name, 80));
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
		if (p.runtime === "acp") {
			return new AcpAgentDriver({ id: p.id, cwd: p.worktree, model: p.model });
		}
		return new RpcAgent({ id: p.id, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, bin: this.bin });
	}

	/** Spawn a real roster agent for a workflow's parallel branch, run the task, resolve with its result. The agent stays in the roster. */
	private async spawnFleetBranch(repo: string, parentId: string, spec: BranchSpec): Promise<NodeResult> {
		// Hard ceiling even bypass-cap fan-out respects: a workflow may spawn its declared branches,
		// but never past an absolute live-agent ceiling — runaway/looping fan-out otherwise melts the
		// host (observed: 88 omp procs at load 160). ponytail: counts roster agents, not OS PIDs (each
		// agent is several processes), so keep the ceiling conservative. Upgrade path: count host PIDs.
		const live = liveAgents(this.list());
		if (live >= hardAgentCeiling()) {
			return { outcome: "failed", text: `agent ceiling reached (${live}/${hardAgentCeiling()}) — branch "${spec.name}" not spawned` };
		}
		const dto = await this.create({ repo, name: spec.name, model: spec.model, parentId, autoRoute: false, bypassCap: true });
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
		if (!executor.member || !report) {
			void this.recordAudit(actor, "commission", spec.name, "error", report ? "gate failed" : "no candidate");
			return { ok: false, report: report ?? { ok: false, checks: [] }, dir };
		}
		void this.recordAudit(actor, "commission", spec.name, "ok", truncate(spec.purpose, 80));
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
		// RBAC chokepoint: every surface (TUI, web, REST, future federation peers) routes through
		// here, so the tier check lives here too — nothing can mutate state below its granted tier.
		const need = commandRole(cmd);
		const have = effectiveRole(actor);
		if (!roleAtLeast(have, need)) {
			this.log("warn", `rbac: ${actor.id} (${have}) denied "${cmd.type}" — needs ${need}`);
			void this.store
				.appendAudit({ actor: actor.id, action: `denied:${cmd.type}`, target: "id" in cmd ? cmd.id : undefined, detail: { need, have } })
				.catch(() => {});
			throw new RbacDenied(need, have, cmd.type);
		}
		// Security trail: record every accepted mutation (reads — snapshot/subscribe — are need=viewer
		// and not audited). DB mode persists to the per-org `audit` table; FileStore is a no-op.
		if (need !== "viewer") {
			await this.store
				.appendAudit({ actor: actor.id, action: cmd.type, target: "id" in cmd ? cmd.id : undefined })
				.catch((err) => this.log("warn", `audit write failed for "${cmd.type}": ${err instanceof Error ? err.message : String(err)}`));
		}
		if (cmd.type === "create") {
			await this.create(cmd.options, actor);
			return;
		}
		if (cmd.type === "snapshot") {
			// version is stamped by SquadServer.broadcast (the manager doesn't own the served assets).
			this.emit("event", { type: "roster", agents: this.list(), version: "" } satisfies SquadEvent);
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
				void this.recordAudit(actor, "prompt", cmd.id, "ok", truncate(cmd.message, 80));
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
				void this.recordAudit(actor, "interrupt", cmd.id);
				break;
			case "kill":
				await rec.agent.stop();
				rec.dto.status = "stopped";
				this.emitAgent(rec);
				void this.recordAudit(actor, "kill", cmd.id);
				break;
			case "restart":
				await this.restart(rec);
				void this.recordAudit(actor, "restart", cmd.id);
				break;
			case "remove":
				await this.remove(cmd.id, cmd.deleteWorktree ?? false);
				void this.recordAudit(actor, "remove", cmd.id, "ok", cmd.deleteWorktree ? "deleted worktree" : undefined);
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
		void this.recordAudit(actor, "answer", rec.dto.id, "ok", `${truncate(req.title, 48)} → ${truncate(value, 40)}`);
	}

	/**
	 * Bounded, opt-in auto-answer for a freshly-added pending request (OMP_SQUAD_AUTOSUPERVISE).
	 * Resolves only LOW-RISK routine approvals so the fleet keeps moving without a human, but:
	 *   - NEVER answers a request flagged risky/destructive (see `isRiskyRequest`) — left for a human;
	 *   - stops once an agent spends its per-agent attempt budget (OMP_SQUAD_AUTOSUPERVISE_BUDGET, default 5);
	 *   - only answers what `chooseFallback` can decide deterministically (host-tool calls yield "" → skipped).
	 * Every auto-answer (and every skip with a reason) is logged for audit.
	 *
	 * ponytail: deterministic risk gate + chooseFallback, no LLM. Auto-approval is safe ONLY because
	 * squad agents live in reviewed-before-merge worktrees. Upgrade path: route to the model-backed
	 * supervisor (`decide` in supervisor.ts) for nuanced calls if the deterministic gate proves too blunt.
	 */
	private maybeAutoSupervise(rec: AgentRecord, req: PendingRequest): void {
		if (process.env.OMP_SQUAD_AUTOSUPERVISE === "0") return;
		const value = chooseFallback(req);
		if (!value) return; // nothing safe + deterministic to answer (e.g. a host-tool call) → leave for a human
		if (this.isRiskyRequest(req)) {
			this.log("info", `autosupervise: SKIP risky "${req.title}" on ${rec.dto.name} (left for human)`);
			return;
		}
		const budget = Number(process.env.OMP_SQUAD_AUTOSUPERVISE_BUDGET) || 5;
		const used = this.superviseBudget.get(rec.dto.id) ?? 0;
		if (used >= budget) {
			this.log("info", `autosupervise: budget ${budget} spent for ${rec.dto.name} — "${req.title}" left for human`);
			return;
		}
		this.superviseBudget.set(rec.dto.id, used + 1);
		this.log("info", `autosupervise: auto-answered ${rec.dto.name} [${req.kind}] "${req.title}" -> ${value} (${used + 1}/${budget})`);
		this.answerPending(rec, req, value, AUTO_ACTOR);
		void this.store
			.appendAudit({ actor: AUTO_ACTOR.id, action: "auto-supervise", target: rec.dto.id, detail: { kind: req.kind, title: req.title, value } })
			.catch(() => {});
	}

	/** True if a pending request must NEVER be auto-answered: a host-tool side-effect, or text matching RISKY_RE. */
	private isRiskyRequest(req: PendingRequest): boolean {
		if (req.source === "tool") return true; // host-tool calls run real side effects — only a human/agent answers
		return RISKY_RE.test(`${req.title} ${req.message ?? ""} ${(req.options ?? []).join(" ")}`);
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
		// Surface the prior session's digest, fenced as untrusted data, so the operator immediately
		// sees where they left off. Surfacing only — never auto-prompt the live agent (no silent spend).
		// ponytail: no dedicated TUI/web treatment yet (YAGNI) — getDigest() + this entry suffice.
		const digest = await readDigest(this.stateDir, rec.dto.id);
		if (digest) this.append(rec, "system", "📒 Resume digest — prior session memory:\n" + fenceUntrusted("resume digest", digest));
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
		this.scoutCursor.delete(id);
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
			void this.finalizeRun(rec);
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
				rec.dto.adopted = false; // OMPSQ-164: it ran ⇒ no longer a never-re-run adopted agent; resume normal verify→land
				if (!rec.run) {
					rec.run = new RunAccumulator({
						agentId: rec.dto.id,
						name: rec.dto.name,
						repo: rec.dto.repo,
						branch: rec.dto.branch,
						model: rec.dto.model,
					});
				}
				rec.run.start(rec.dto.model);
				break;
			case "message_update": {
				const ev = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (ev?.type === "text_delta" && typeof ev.delta === "string") rec.assistantBuf += ev.delta;
				break;
			}
			case "message_end": {
				const msg = frame.message as
					| { role?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } } }
					| undefined;
				if (msg?.role === "assistant" && msg.usage) rec.run?.onAssistantUsage(msg.usage);
				if (rec.assistantBuf.trim()) {
					this.append(rec, "assistant", rec.assistantBuf.trim());
					rec.assistantBuf = "";
				}
				break;
			}
			case "tool_execution_start": {
				const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
				const intent = typeof frame.intent === "string" ? frame.intent : "";
				rec.run?.onTool(toolName);
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
				void this.finalizeRun(rec);
				break;
			}
			case "workflow_done":
				// Autonomous loop closer: a successful workflow auto-lands its own branch (no operator) —
				// UNLESS the LAND_CONFIRM valve is on, where the orchestrator stages a one-tap Land instead.
				// The valve gates EVERY autonomous land path, not just the orchestrator tick.
				void autoLandOnSuccess(this.autoLand && !this.landConfirm, frame.outcome as string | undefined, { id: rec.dto.id, name: rec.dto.name }, { land: (id) => this.land(id), log: (m) => this.log("info", m) });
				break;
			case "auto_retry_start": {
				// A usage-limit retry means the model subscription is rate-limited (5h/weekly cap). Note it so the
				// dispatcher pauses; log once per episode (only on the not-paused → paused transition) to avoid spam
				// when several agents trip the same cap. delayMs is omp's parsed retry hint (when the cap frees up).
				const wasPaused = this.rateLimit.paused();
				if (this.rateLimit.note(frame.errorMessage, frame.delayMs) && !wasPaused) {
					const mins = Math.ceil((this.rateLimit.until - Date.now()) / 60_000);
					this.log("warn", `model subscription rate-limited (${rec.dto.name}) — pausing auto-dispatch ~${mins}m: ${this.rateLimit.reason}`);
				}
				break;
			}
		}
		rec.dto.receipt = rec.run?.rollup();
		rec.dto.status = this.derive(rec);
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
	}

	/**
	 * Close an agent/member's Plane issue once its branch successfully LANDS — the only close path now
	 * (no premature close-on-gate-pass). Gated by OMP_SQUAD_AUTOCLOSE (closeOnDone). Idempotent via
	 * `closedIssues` (a closed id is never re-closed) and best-effort (`closePlaneIssue` swallows
	 * transport errors). A failed close leaves the id unmarked so a later land retries it.
	 */
	async closeLandedIssue(issue: IssueRef | undefined): Promise<void> {
		if (!this.closeOnDone || !issue || this.closedIssues.has(issue.id)) return;
		this.log("info", `closing ${issue.identifier ?? issue.id} (branch landed)`);
		if (await closePlaneIssue(issue)) this.closedIssues.add(issue.id);
		else this.log("warn", `could not close ${issue.identifier ?? issue.id} (branch landed)`);
	}

	/**
	 * Persist one JSONL receipt line for a completed/terminated run, then clear
	 * the accumulator so the next turn starts fresh. Idempotent per run via the
	 * accumulator's `finalized` flag (agent_end + exit can both fire).
	 */
	private async finalizeRun(rec: AgentRecord): Promise<void> {
		const run = rec.run;
		if (!run || run.finalized) return;
		run.finalized = true;
		run.finish(rec.dto.status, await changedFiles(rec.dto.worktree));
		const receipt = run.snapshot();
		await appendReceipt(this.stateDir, receipt); // full receipt on disk (both modes)
		// Queryable per-org cost/token ledger (DB mode); FileStore is a no-op since the receipt is on disk.
		await this.store.appendUsage(receipt).catch((err) => this.log("warn", `usage write failed for ${rec.dto.name}: ${err instanceof Error ? err.message : String(err)}`));
		// Best-effort cold-start digest: a failure here must never break run completion.
		try {
			const md = buildDigest({ transcript: rec.transcript, receipts: await readReceipts(this.stateDir, rec.dto.id) });
			await writeDigest(this.stateDir, rec.dto.id, md);
		} catch (err) {
			this.log("warn", `digest failed for ${rec.dto.name}: ${err}`);
		}
		// Scout: harvest latent backlog items from this run's final reasoning delta. Fire-and-forget +
		// best-effort — must never block or break run completion (scan() also catches internally).
		if (this.scout) {
			const reasoning = this.takeScoutReasoning(rec);
			if (reasoning)
				void this.scout
					.scan(reasoning, { agent: rec.dto.name, task: rec.options.task, issue: rec.dto.issue?.identifier ?? rec.dto.issue?.name })
					.catch((err) => this.log("warn", `scout scan failed for ${rec.dto.name}: ${err instanceof Error ? err.message : String(err)}`));
		}
		rec.dto.receipt = run.rollup();
		rec.run = undefined;
		this.emitAgent(rec);
	}

	/**
	 * Reasoning (assistant+thinking) an agent has produced since its last scout scan; advances the
	 * per-agent cursor so each chunk is scanned at most once. Returns "" until ≥ MIN_SCAN_CHARS of new
	 * reasoning has accrued (the cursor stays put), so a slow trickle is never skipped past unscanned.
	 */
	private takeScoutReasoning(rec: AgentRecord): string {
		const { text, cursor } = unscannedReasoning(rec.transcript, this.scoutCursor.get(rec.dto.id) ?? 0);
		if (text) this.scoutCursor.set(rec.dto.id, cursor);
		return text;
	}

	/** Durable receipt history for one agent (server reads this; keeps stateDir private). */
	async receipts(id: string): Promise<RunReceipt[]> {
		return readReceipts(this.stateDir, id);
	}

	/**
	 * Append one fleet-action audit record (actor / action / target / outcome) and
	 * broadcast it live to any open Audit view. The single recorder for every
	 * surface (TUI, web, REST, federation peers) — public so the server can stamp
	 * actions it runs outside applyCommand (per-agent + feature land). Best-effort:
	 * a disk failure must never break the action it records, so we log and move on.
	 */
	async recordAudit(actor: Actor | string, action: string, target: string | null, outcome: "ok" | "error" = "ok", detail?: string): Promise<void> {
		const entry = makeAuditEntry({ actor, action, target, outcome, detail });
		this.emit("event", { type: "audit", entry } satisfies SquadEvent);
		try {
			await appendAudit(this.stateDir, entry);
		} catch (err) {
			this.log("warn", `audit append failed (${action}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Fleet-action audit log, newest first (server reads this; keeps stateDir private). */
	async auditLog(query: AuditQuery = {}): Promise<AuditEntry[]> {
		return readAudit(this.stateDir, query);
	}

	/** Saved cold-start resume digest for an agent ("" if none yet). */
	async getDigest(id: string): Promise<string> {
		return readDigest(this.stateDir, id);
	}

	/** Route an extension UI request to a pending entry (and opt-in auto-answer). Protected so a test can drive it. */
	protected onUi(rec: AgentRecord, req: RpcExtensionUIRequest): void {
		let added: PendingRequest | undefined;
		if (req.method === "cancel") {
			rec.dto.pending = rec.dto.pending.filter((p) => p.id !== req.targetId);
		} else if (req.method === "notify") {
			this.append(rec, "system", `(${req.notifyType ?? "info"}) ${req.message}`);
		} else if (BLOCKING_UI_METHODS[req.method]) {
			added = {
				id: req.id,
				source: "ui",
				kind: req.method,
				title: "title" in req ? req.title : req.method,
				message: req.method === "confirm" ? req.message : undefined,
				options: req.method === "select" ? req.options : undefined,
				placeholder: req.method === "input" ? req.placeholder : req.method === "editor" ? req.prefill : undefined,
				createdAt: Date.now(),
			};
			rec.dto.pending = [...rec.dto.pending.filter((p) => p.id !== req.id), added];
			this.append(rec, "system", `⛔ needs input: ${added.title}`);
		}
		rec.dto.status = this.derive(rec);
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
		if (added) this.maybeAutoSupervise(rec, added); // opt-in bounded auto-answer (registers the request first, above)
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

	/** Shut down agent-hosts no longer in the roster (orphans from a crash / re-exec / re-spawn). */
	private async reapOrphans(): Promise<void> {
		const reaped = await reapOrphanHosts(new Set(this.agents.keys())).catch(() => [] as string[]);
		if (reaped.length) this.log("info", `reaped ${reaped.length} orphan agent host(s): ${reaped.join(", ")}`);
	}

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
		// Periodically (~every 30s) reap detached hosts the roster no longer owns. Safe because an
		// agent is in this.agents before its host spawns, so a just-spawned agent is never reaped.
		// In DB mode the registry owns the machine-global reaps (over the union of all orgs) so a
		// per-org manager never kills another org's hosts; reapDeadWorktrees stays per-org (worktrees
		// are org-scoped, so each manager only sees its own).
		if (++this.reapTicks % 12 === 0) {
			if (!this.skipGlobalJanitors) {
				void this.reapOrphans();
				void this.sweepRegistries();
			}
			void this.reapDeadWorktrees();
		}
		void this.sampleHealth().then((h) => {
			const key = h.warnings.join("|");
			if (key && key !== this.lastWarnKey) this.log("warn", `watchdog: ${h.warnings.join("; ")}`);
			this.lastWarnKey = key;
		});
	}

	/** Snapshot daemon health (memory/load/agents/detached hosts) and judge it. Polled + served at /api/health. */
	async sampleHealth(): Promise<{ sample: HealthSample; warnings: string[]; at: number }> {
		const ncpu = os.cpus().length || 1;
		let hosts = 0;
		try {
			hosts = (await fs.readdir(path.dirname(socketPathFor("_")))).filter((f) => f.endsWith(".sock")).length;
		} catch {
			/* sockets dir absent ⇒ no hosts */
		}
		const sample: HealthSample = {
			rssMb: process.memoryUsage().rss / 1e6,
			load1: os.loadavg()[0] ?? 0,
			ncpu,
			freeRatio: os.totalmem() > 0 ? os.freemem() / os.totalmem() : 1,
			agents: liveAgents(this.list()),
			hosts,
		};
		const warnings = assessHealth(sample, defaultHealthLimits(ncpu, hardAgentCeiling()));
		return { sample, warnings, at: Date.now() };
	}

	/** Periodically remove stale per-repo/worktree dirs from the leases/presence/proof registries — each
	 *  unique worktree mints a fresh key, so without this they accumulate one folder per agent forever. */
	private async sweepRegistries(): Promise<void> {
		try {
			const [l, p, pr] = await Promise.all([sweepLeases(), sweepPresence(), sweepProofs()]);
			if (l + p + pr > 0) this.log("info", `swept stale registry dirs — ${l} leases, ${p} presence, ${pr} proofs`);
		} catch {
			/* best-effort cleanup */
		}
	}

	/** Free disk + git admin entries for squad worktrees whose agent is gone and whose work is safely in
	 *  the base branch or whose Plane issue is closed — repeated re-dispatch otherwise leaks one worktree
	 *  per attempt. Lossless (abandoned WIP committed to its branch; only merged+clean branches deleted)
	 *  and never touches a live agent's worktree or one created within the spawn grace. Opt out with
	 *  OMP_SQUAD_WORKTREE_REAP=0; tune the freshness window with OMP_SQUAD_WORKTREE_GRACE_MS. */
	private async reapDeadWorktrees(): Promise<void> {
		if (process.env.OMP_SQUAD_WORKTREE_REAP === "0") return;
		const graceMs = Number(process.env.OMP_SQUAD_WORKTREE_GRACE_MS) || 120_000;
		const owned = new Set([...this.agents.values()].map((r) => r.options.worktree).filter((w): w is string => !!w));
		const repos = new Set<string>([...planeRepos(), ...[...this.agents.values()].map((r) => r.options.repo)]);
		for (const repo of repos) {
			if (!repo || repo.startsWith("(")) continue; // synthetic / no-repo agents have no worktrees to reap
			try {
				const root = await repoRoot(repo);
				const base = await primaryBranch(root);
				const wts = await listWorktrees(root);
				const infos: WorktreeInfo[] = await Promise.all(
					wts.map(async (w) => {
						const stat = await fs.stat(w.worktree).catch(() => undefined);
						return {
							worktree: w.worktree,
							branch: w.branch ?? "",
							isPrimary: w.isPrimary,
							aheadOfBase: w.isPrimary || !w.branch ? 0 : await branchAhead(root, w.branch, base),
							dirty: !w.isPrimary && (await worktreeStatus(w.worktree)).dirtyFiles.length > 0,
							mtimeMs: stat ? stat.mtimeMs : 0, // dir gone ⇒ ancient ⇒ eligible (removeWorktree prunes the stale entry)
						};
					}),
				);
				const issues = await listPlaneIssues(repo);
				const openIdentifiers = issues
					? new Set(issues.map((i) => i.identifier).filter((x): x is string => !!x).map((s) => s.toUpperCase()))
					: null;
				const managedBase = this.worktreeBaseDir ?? worktreeBase();
				const decisions = selectReapable({ worktrees: infos, owned, managedBase, openIdentifiers, now: Date.now(), graceMs });
				for (const d of decisions) {
					await removeWorktree(root, d.worktree).catch(() => {});
					if (d.deleteBranch) await deleteBranchIfMerged(root, d.branch).catch(() => {});
				}
				if (decisions.length) {
					const merged = decisions.filter((d) => d.reason === "merged").length;
					this.log("info", `reaped ${decisions.length} dead worktree(s) — ${merged} merged, ${decisions.length - merged} issue-closed`);
				}
			} catch {
				/* best-effort cleanup */
			}
		}
	}

	private applyState(rec: AgentRecord, state: RpcSessionState): void {
		const tasks = state.todoPhases.flatMap((p) => p.tasks);
		const done = tasks.filter((t) => t.status === "completed").length;
		const active = tasks.find((t) => t.status === "in_progress")?.content;
		const next: AgentDTO["todo"] = tasks.length ? { done, total: tasks.length, active } : undefined;
		rec.dto.todo = next;
		// Rough completion estimate from progress rate (tasks done/total over elapsed). A hint, not a deadline.
		const elapsed = rec.dto.startedAt ? Date.now() - rec.dto.startedAt : 0;
		const remaining = next ? estimateEta(next.done, next.total, elapsed) : undefined;
		rec.dto.etaAt = remaining !== undefined ? Date.now() + remaining : undefined;
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
		// ponytail: append() is the single transcript chokepoint — redact here so secrets reach
		// neither the in-memory buffer, persisted state.json, nor the emitted transcript event.
		// Receipt fields carry paths/tallies (not free text), so they need no separate redaction.
		const entry: TranscriptEntry = { kind, text: redact(text), ts: Date.now() };
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

	/** Atomic write through the store: file mode → state.json temp+rename; DB mode → roster/feature tables + on-disk transcripts. */
	private async persistNow(): Promise<void> {
		const agents = [...this.agents.values()].map((r) => r.options);
		const transcripts: Record<string, TranscriptEntry[]> = {};
		for (const r of this.agents.values()) if (r.transcript.length) transcripts[r.dto.id] = r.transcript;
		const features = [...this.featureStore.values()];
		await this.store.save({ agents, transcripts, features });
	}

	/** Re-spawn agents persisted from a previous run. Returns how many were restored. */
	async loadPersisted(): Promise<number> {
		const snapshot = await this.store.load();
		for (const f of snapshot.features) this.featureStore.set(f.id, f);
		const list = snapshot.agents;
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
				owns: p.owns,
				workflow: p.workflow?.path,
				verify: p.workflow?.verify?.command,
				workflowState: p.workflowState, // resume the graph from its checkpoint, never restart from scratch (OMPSQ-165)
				sandbox: p.sandbox,
				autoRoute: false,
				bypassCap: true, // restore re-creates already-counted agents — never gated by the live cap
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
