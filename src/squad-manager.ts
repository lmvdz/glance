/**
 * SquadManager — authoritative roster of managed agents.
 *
 * Owns each RpcAgent, derives human-meaningful status from its event stream,
 * buffers a transcript, persists roster config, and exposes a single
 * `applyCommand(cmd, actor)` entry point shared by every surface (local TUI /
 * web today, federation peers in Phase 2). Emits a `SquadEvent` stream.
 */

import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CommandAck, type FederationBus, LOCAL_ACTOR, NullFederationBus, type RemoteCommand } from "./federation.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { AgentDriver, HostToolDef } from "./agent-driver.ts";
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
import type { WorkflowDefinition } from "./workflow-catalog.ts";
import { Dispatcher } from "./dispatch.ts";
import { openDispatchLedger } from "./dispatch-ledger.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Observer } from "./observer.ts";
import { Scout, unscannedReasoning } from "./scout.ts";
import { readScoutCursors, writeScoutCursors } from "./scout-cursor.ts";
import { gateExec } from "./gate-runner.ts";
import { Opportunity } from "./opportunity.ts";
import { hardenedGit, hardenedGitSync } from "./git-harden.ts";
import { Scheduler, liveAgents, occupyingAgents } from "./scheduler.ts";
import { RateLimitGate } from "./rate-limit.ts";
import { addIssueIdsToFeatureModule, addIssuesToFeatureModule, addPlaneBlockedByRelation, addPlaneIssueComment, closePlaneIssue, createPlaneIssue, deletePlaneModule, ensureFeatureModule, featureTickets, fetchIssueDetail, listPlaneIssues, listPlaneIssuesAllStates, planeRepos, reopenPlaneIssue, startPlaneIssue } from "./plane.ts";
import { syncPlanStatuses } from "./plan-sync.ts";
import { archivePlanDir, buildFeatures, concernNumFromFile, deletePlanDir, featureLandStatus, listPlanDirs, parsePlanConcerns, parsePlanDependencyGraph, planeModuleUrlIn, restorePlanDir, updatePlanConcern, type LandMember, landOrder, type PlanConcern } from "./features.ts";
import { dirtyLandTargetWarnings, landAgent, type LandOpts, type LandResult, withRepoLandLock } from "./land.ts";
import { autoLandOnSuccess } from "./autoland.ts";
import { ownershipConflict, requiresConflict, outOfScopeWrites, producesAllowlist } from "./ownership.ts";
import { headCommit, isFresh, proofFingerprint, proofFor, proofGate, runProof, setProofRoot, sweepProofs } from "./proof.ts";
import { sweepLeases } from "./leases.ts";
import { agentActor, scopeFor } from "./agent-scope.ts";
import { buildFabricSnapshot, loadScoutFacts, type FabricSnapshot } from "./fabric.ts";
import { buildContextPrimer, searchFabric, type KbDocType } from "./fabric-search.ts";
import { sweepPresence } from "./presence.ts";
import { chooseFallback } from "./supervisor.ts";
import { availableActions, effectiveAutonomyMode, modeFromApproval, validateRequestedMode, type AutonomyMode, type VerificationState } from "./autonomy.ts";
import type {
	Actor,
	AuditEntry,
	IssueRef,
	PlaneTicket,
	AgentProfile,
	AgentDTO,
	FeatureDTO,
	PersistedFeature,
	FeatureStage,
	FeatureCriterion,
	FeatureDecision,
	FeatureRelationship,
	PlanRevisionCandidate,
	PlanRevisionCandidateState,
	AgentStatus,
	AutomationEvent,
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
	FeedbackCampaign,
	FeedbackItem,
	FeedbackReward,
	FeedbackValidationResponse,
} from "./types.ts";
import { type SubagentNode, SubagentTracker } from "./subagents.ts";
import { commandRole, effectiveRole, RbacDenied, roleAtLeast } from "./auth.ts";
import { hostAlive, pruneStaleSockets, reapOrphanHosts, socketPathFor } from "./agent-host.ts";
import { addWorktree, branchAhead, deleteBranchIfMerged, isGitRepo, listWorktrees, primaryBranch, removeWorktree, repoRoot, resolveWorktree, worktreeBase, worktreeStatus } from "./worktree.ts";
import { selectReapable, type WorktreeInfo } from "./worktree-reaper.ts";
import { changedFiles } from "./explore.ts";
import { appendReceipt, readAllReceipts, readReceipts, RunAccumulator } from "./receipts.ts";
import { appendAudit, type AuditQuery, makeAuditEntry, readAudit } from "./audit.ts";
import { AutomationLog, type AutomationQuery } from "./automation-log.ts";
import { addPlanRevisionCandidate, appendCommentEvent, type ArtifactComment, type CommentQuery, type PlanAnnotationTarget, listComments as readComments, listPlanRevisionCandidates as readPlanRevisionCandidates, nextCommentId, transitionPlanRevisionCandidate } from "./comments.ts";
import { landFailureCount, readLandLedger, recordLandOutcome } from "./land-ledger.ts";
import { openOrchestratorState } from "./orchestrator-state.ts";
import { buildDigest, fenceUntrusted, readDigest, writeDigest } from "./digest.ts";
import { redact } from "./redact.ts";
import { FileStore, type StateSnapshot, type Store } from "./dal/store.ts";
import { buildTrace, traceMaxSpans, traceSampleRatio, traceSpansEnabled, type TraceResponse } from "./spans.ts";
import { traceExporterFromEnv, type TraceExportQueue } from "./trace-exporter.ts";
import { ManualProvider, type PaymentProvider, paymentProviderFromEnv } from "./payments/index.ts";
import {
	acceptFeedbackSubmission,
	assertRewardTransition,
	hashCampaignToken,
	newCampaignId,
	normalizeFeedbackValidation,
	renderFeedbackPlaneIssue,
	summarizeFeedback,
	type FeedbackSnapshot,
	type FeedbackSummary,
	type FeedbackValidationInput,
} from "./feedback.ts";
import {
	capabilityFederationMetadata,
	capabilityProfiles,
	capabilityWorkflowDefinitions,
	diffCapabilityPacks,
	emptyCapabilitySnapshot,
	importCapabilitySource,
	installCapability,
	normalizeCapabilitySnapshot,
	updateCapabilityInstall,
	type CapabilityImportInput,
	type CapabilityInstallInput,
	type CapabilityInstallPatch,
	type CapabilitySnapshot,
} from "./capabilities/index.ts";

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

const PEER_MESSAGE_TOOL = "squad_message";
const PEER_MESSAGE_MAX_CHARS = 2000;
const KB_SEARCH_TOOL = "squad_kb_search";

/**
 * Reserved host tools advertised to every omp-backed agent via `set_host_tools` on ready (the
 * registration that was missing — without it omp never surfaces these calls). Both are handled in
 * onHostTool BEFORE the capability tool-grant gate, so they're always available and read/advisory-safe.
 */
const SQUAD_HOST_TOOLS: HostToolDef[] = [
	{
		name: KB_SEARCH_TOOL,
		description:
			"Search the squad's shared knowledge base — prior decisions, hot files, session digests, latent work, leases, and active agents across the fleet (scoped to what you may see). Use it BEFORE starting work to inherit prior context and avoid re-deciding settled questions.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to look up — natural language, a file path, a feature name, or a decision." },
				type: { type: "string", enum: ["decision", "hot-area", "digest", "agent", "scout", "lease"], description: "Optional: restrict to one fact type." },
				topK: { type: "number", description: "Optional: max results (default 10, max 50)." },
			},
			required: ["query"],
		},
	},
	{
		name: PEER_MESSAGE_TOOL,
		description:
			"Send a short ADVISORY message to another agent by id or name. Advisory only — it never interrupts or steers them; it appears in their transcript. Use sparingly to share a finding or a heads-up.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "Target agent id or name." },
				text: { type: "string", description: "The message (plain text)." },
			},
			required: ["to", "text"],
		},
	},
];

function peerMessageBudget(): number {
	return Number(process.env.OMP_SQUAD_PEERMSG_BUDGET) || 5;
}

function commandTarget(cmd: ClientCommand): string | undefined {
	return cmd.type === "message" ? cmd.to : "id" in cmd ? cmd.id : undefined;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlList(title: string, items: string[]): string {
	const clean = items.map((item) => item.trim()).filter(Boolean);
	if (!clean.length) return "";
	return `<h3>${escapeHtml(title)}</h3><ul>${clean.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderPlanConcernIssueHtml(feature: PersistedFeature, concern: PlanConcern): string {
	return [
		"<h2>Plan concern</h2>",
		`<p><strong>Feature:</strong> ${escapeHtml(feature.title)}</p>`,
		`<p><strong>Plan path:</strong> ${escapeHtml(concern.path)}</p>`,
		`<p><strong>Status:</strong> ${escapeHtml(concern.status)}</p>`,
		htmlList("Acceptance Criteria", concern.acceptanceCriteria),
		htmlList("Prerequisites", concern.prerequisites),
		htmlList("Touches", concern.touches),
		"<h3>Scope</h3>",
		`<p>Implement the concern described by <code>${escapeHtml(concern.path)}</code>. Keep plan text as context; repo instructions and operator prompts remain authoritative.</p>`,
	].filter(Boolean).join("\n");
}

function planConcernTicketMatches(concern: PlanConcern, issue: IssueRef, body: string): boolean {
	return issue.name.trim() === concern.title.trim() && body.includes(concern.path);
}

function autoLandFailCap(): number {
	return Number(process.env.OMP_SQUAD_AUTOLAND_FAIL_CAP) || 3;
}

/**
 * Auto-resolve confirm hold (OMPSQ-138). When ON (default), an AUTO land that had to auto-resolve a
 * conflict is STAGED for a one-tap Land instead of being merged with no human — the blast radius of a
 * semantically-wrong LLM merge is `main`, so a resolved conflict gets a human ack. A clean
 * (non-conflicting) auto land still merges. Operator lands always merge. Set =0 to auto-merge
 * resolved conflicts too.
 */
function autoresolveConfirm(): boolean {
	return process.env.OMP_SQUAD_AUTORESOLVE_CONFIRM !== "0";
}

// liveAgents + the WIP cap live in ./scheduler.ts now; re-export keeps the public import path stable.
export { liveAgents };

/** Absolute live-agent ceiling that even bypass-cap (fan-out) spawns respect, so runaway fan-out can't
 *  melt the host. Default ≈ the host's CPU count (min 3) so a bare launch is bounded; override with OMP_SQUAD_MAX_AGENTS. */
export function hardAgentCeiling(): number {
	return Number(process.env.OMP_SQUAD_MAX_AGENTS) || Math.max(os.cpus().length || 2, 3);
}

/** Render a capability profile's tool-grant allow-list as a hard system-prompt constraint. This is the part
 *  of capability tool-scoping (#3) that reaches the omp child (via --append-system-prompt); host tool calls
 *  outside the list are additionally hard-denied at the onHostTool seam. Returns undefined for an empty grant. */
export function toolGrantsPrompt(grants: string[] | undefined): string | undefined {
	if (!grants || grants.length === 0) return undefined;
	return [
		"--- Capability tool grant (hard constraint) ---",
		`You are scoped to ONLY these tools: ${grants.join(", ")}.`,
		"Do not use, request, or attempt any tool outside this list. Tool calls outside the grant are denied by the host.",
	].join("\n");
}

/** Persisted agents to take over on restart: not already reattached (live), not flue, and whose worktree
 *  still holds context on disk. Live hosts are reattached by reconnectLive; a gone worktree re-dispatches. */
export function agentsToAdopt<T extends { id: string; kind?: string; worktree?: string; parentId?: string }>(
	persisted: T[],
	rosterIds: ReadonlySet<string>,
	worktreeExists: (worktree: string) => boolean,
): T[] {
	// Exclude parallel-branch children (parentId set): a branch belongs to its parent run, whose own
	// resume re-drives the fan-out. Adopting a branch as a plain agent would direct-land it independently
	// of the join → a double-land (and revives completed wait_all branches on the next restart).
	return persisted.filter((p) => p.kind !== "flue-service" && !p.parentId && !rosterIds.has(p.id) && !!p.worktree && worktreeExists(p.worktree));
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
 * The resumable records NOT taken this boot (dropped by the ceiling). They must be PRESERVED, not
 * erased: the full-snapshot-replace persist would otherwise overwrite an un-adopted checkpointed
 * workflow into permanent loss (D1). persistNow folds these back into the snapshot so a later routine
 * restart re-attempts them. Resumability is the operative signal — a plain over-ceiling agent re-dispatches
 * from its still-open issue, but a workflow checkpoint has nothing to re-dispatch it.
 */
export function deferredResumable<T extends { id: string }>(eligible: T[], resumable: (p: T) => boolean, adopted: T[]): T[] {
	const adoptedIds = new Set(adopted.map((a) => a.id));
	return eligible.filter((p) => resumable(p) && !adoptedIds.has(p.id));
}

let agentIdSeq = 0;

/**
 * Unique agent id: name + time + process-local sequence + random suffix. The branch and worktree derive
 * from this id (NOT the agent's display name), so two agents — even same name, even spawned in the same
 * millisecond or across a daemon restart — never share a branch or worktree. (The name alone collides:
 * dispatched agents fall back to `agent-N` whose counter resets every restart, so "agent-1" gets reused.)
 */
export function newAgentId(name: string): string {
	return `${name}-${Date.now().toString(36)}-${(++agentIdSeq).toString(36)}-${randomBytes(4).toString("hex")}`;
}

function slugPart(text: string, max = 60): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

/** Descriptive, stable branch for Plane-driven work: `squad/ompsq-319-short-title`. */
export function planeIssueBranch(issue: IssueRef): string {
	const ident = slugPart(issue.identifier ?? issue.id, 32);
	const title = slugPart(issue.name);
	return `squad/${[ident, title].filter(Boolean).join("-") || "plane-issue"}`;
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

export interface RuntimeModelOption {
	label: string;
	value: string;
}

export function modelOptionsFromRuntime(models: unknown): RuntimeModelOption[] {
	if (!Array.isArray(models)) return [];
	const seen = new Set<string>();
	return models.flatMap((item): RuntimeModelOption[] => {
		if (!item || typeof item !== "object") return [];
		const rec = item as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id.trim() : "";
		if (!id) return [];
		const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
		const value = provider ? `${provider}/${id}` : id;
		if (seen.has(value)) return [];
		seen.add(value);
		return [{ label: value, value }];
	});
}

export function profileOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentProfile[] {
	const configured = parseProfiles(env.OMP_SQUAD_PROFILES);
	const fallback: AgentProfile = {
		id: "default",
		name: "Default OMP operator",
		description: "Live omp --mode rpc session with the daemon's default model and write approvals.",
		runtime: "omp-operator",
		approvalMode: "write",
		default: true,
	};
	return configured.length ? configured : [fallback];
}

function parseProfiles(raw: string | undefined): AgentProfile[] {
	if (!raw?.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item): AgentProfile[] => {
			if (!item || typeof item !== "object") return [];
			const r = item as Record<string, unknown>;
			const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
			const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
			const runtime = r.runtime === "flue-service" || r.runtime === "workflow" ? r.runtime : "omp-operator";
			if (!id) return [];
			return [{
				id,
				name,
				description: typeof r.description === "string" ? r.description : undefined,
				runtime,
				model: typeof r.model === "string" ? r.model : undefined,
				approvalMode: r.approvalMode === "always-ask" || r.approvalMode === "write" || r.approvalMode === "yolo" ? r.approvalMode : undefined,
				capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((v): v is string => typeof v === "string") : undefined,
				memory: typeof r.memory === "string" ? r.memory : undefined,
				default: r.default === true,
			}];
		});
	} catch {
		return [];
	}
}

function isAgentDisconnected(err: unknown): boolean {
	return err instanceof Error && /agent (not connected|connection lost)/i.test(err.message);
}

interface AgentRecord {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: TranscriptEntry[];
	/** Accumulated streaming text since the last flush. */
	assistantBuf: string;
	/** Live assistant transcript row being updated by message_update deltas. */
	assistantEntry?: TranscriptEntry;
	/** Accumulated thinking text since the last flush. */
	thinkingBuf: string;
	/** Live thinking transcript row being updated by thinking deltas. */
	thinkingEntry?: TranscriptEntry;
	/** True between agent_start/turn_start and agent_end. */
	streaming: boolean;
	/** Live subagent (task-spawned children) tree for this agent. */
	subs: SubagentTracker;
	/** Available slash commands (builtin + skills + extensions) reported by the agent. */
	commands?: CommandInfo[];
	/** Live receipt accumulator for the in-flight run (one per agent_start..end). */
	run?: RunAccumulator;
	/** In-flight rich tool transcript entries keyed by the runtime toolCallId. */
	toolEntries: Map<string, TranscriptEntry>;
	/** Capability tool-grant allow-list (from the spawning profile's `capabilities`). When present, the
	 *  agent's declared allow-list is injected into its system prompt AND host tool calls outside the list
	 *  are hard-denied at the onHostTool seam. Absent ⇒ full tool access (unscoped, the historical default). */
	toolGrants?: string[];
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
	/** Reward disbursement seam. Default: paymentProviderFromEnv() — Tremendous when an API key is set,
	 *  else a records-only ManualProvider. Inject a fake in tests to avoid the network. */
	paymentProvider?: PaymentProvider;
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
	/** Resumable checkpointed records dropped by the adoption ceiling this boot — kept (not erased) so
	 *  persistNow folds them back into the snapshot for a later restart to re-attempt (D1 loss fix). */
	private deferred: PersistedAgent[] = [];
	private readonly featureStore = new Map<string, PersistedFeature>();
	private capabilityStore: CapabilitySnapshot = emptyCapabilitySnapshot();
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
	/** Observers — one per configured Plane repo so every repo's backlog is audited (OMPSQ-137). */
	private readonly observers: Observer[] = [];
	/** Plan-sync tick timers (one per configured Plane repo); cleared in stop(). */
	private readonly planSyncTimers: Timer[] = [];
	/** Scouts keyed by configured Plane repo — one per repo so multi-repo reasoning is all harvested. */
	private readonly scouts = new Map<string, Scout>();
	/** Opportunity clusterers — one per configured Plane repo, fed by Scout facts + receipt hot areas. */
	private readonly opportunities: Opportunity[] = [];
	/** Per-agent scout scan cursor (agentId → last-scanned transcript ts); advanced by takeScoutReasoning.
	 *  Persisted (scout-cursor.json) so a warm daemon restart doesn't re-scan whole transcripts —
	 *  each re-scan was a redundant Scout LLM call per reattached agent. Loaded in the constructor. */
	private readonly scoutCursor: Map<string, number>;
	/** Observability spine for the background loops (scout/observer/opportunity/dispatch) — the surface
	 *  behind GET /api/automation. Live events also broadcast as a `type:"automation"` SquadEvent.
	 *  Assigned in the constructor (needs stateDir, which the constructor body sets). */
	private readonly automation: AutomationLog;
	/** OMP_SQUAD_AUTOCLOSE (default ON): close a tracking issue when its branch LANDS — never on a bare gate-pass. */
	private readonly closeOnDone = process.env.OMP_SQUAD_AUTOCLOSE !== "0";
	private llmClassify?: Classify;
	private readonly closedIssues = new Set<string>();
	/** Per-agent count of auto-supervised answers spent this run (OMP_SQUAD_AUTOSUPERVISE attempt budget). */
	private readonly superviseBudget = new Map<string, number>();
	/** Per-agent count of advisory peer messages spent this run (OMP_SQUAD_PEERMSG_BUDGET). */
	private readonly peerMessageBudget = new Map<string, number>();
	/** Agent ids the daemon reattached to (surviving hosts) this run. */
	private readonly reattached = new Set<string>();
	private readonly traceExporter?: TraceExportQueue;
	/** Reward disbursement provider (Tremendous / Manual). Injectable for tests; default from env. */
	private readonly paymentProvider: PaymentProvider;
	private idSeq = 0;
	private transcriptSeq = 0;
	/** Last observed `plans/` signature for repos the feature board scans. */
	private planFeatureSignature = "";
	private readonly mainGateCache = new Map<string, { fp: string; result: { ok: boolean; firstFailure?: string }; tick: number }>();

	constructor(opts: SquadManagerOptions = {}) {
		super();
		this.operator = opts.operator ?? LOCAL_ACTOR;
		this.bus = opts.bus ?? new NullFederationBus();
		this.stateDir = opts.stateDir ?? path.join(os.homedir(), ".omp", "squad");
		setProofRoot(this.stateDir);
		this.scoutCursor = readScoutCursors(this.stateDir);
		this.automation = new AutomationLog(this.stateDir, { onEvent: (event) => this.emit("event", { type: "automation", event } satisfies SquadEvent) });
		this.bin = opts.bin;
		this.autoLand = opts.autoLand ?? false;
		this.worktreeBaseDir = opts.worktreeBase;
		this.store = opts.store ?? new FileStore(this.stateDir);
		this.skipGlobalJanitors = opts.skipGlobalJanitors ?? false;
		this.llmClassify = process.env.OMP_SQUAD_LLM_ROUTER ? ompClassify(this.bin) : undefined;
		this.traceExporter = traceExporterFromEnv((m) => this.log("warn", m));
		this.paymentProvider = opts.paymentProvider ?? paymentProviderFromEnv();
	}

	private blockedReason(dto: Pick<AgentDTO, "pending" | "error">): string | undefined {
		if (dto.error) return dto.error;
		return dto.pending.length ? "waiting for operator input" : undefined;
	}

	private syncAuthority(dto: AgentDTO): void {
		const blockedReason = this.blockedReason(dto);
		const requested = dto.autonomyMode ?? modeFromApproval(dto.approvalMode);
		dto.autonomyMode = requested;
		const verificationState = dto.verificationState ?? "unknown";
		dto.verificationState = verificationState;
		const effectiveMode = effectiveAutonomyMode({
			requested,
			approvalMode: dto.approvalMode,
			autoLand: this.autoLand,
			landConfirm: this.landConfirm,
			blockedReason,
		});
		dto.effectiveMode = effectiveMode;
		dto.blockedReason = blockedReason;
		dto.availableActions = availableActions(effectiveMode, verificationState, blockedReason);
	}

	private async refreshProofState(rec: AgentRecord): Promise<void> {
		const proof = await proofFor(rec.dto.repo, rec.dto.worktree);
		const fp = await proofFingerprint(rec.dto.repo, rec.dto.worktree, proof?.command);
		let verificationState: VerificationState = "none";
		if (proof) verificationState = proof.ok ? (isFresh(proof, fp) ? "fresh" : "stale") : "failed";
		rec.dto.verificationState = verificationState;
		rec.dto.proof = proof ? { commit: proof.commit, command: proof.command, ranAt: proof.ranAt, fingerprint: `${proof.commit}:${proof.tree}:${proof.commandHash}` } : undefined;
		this.syncAuthority(rec.dto);
	}

	private seedAuthority(dto: AgentDTO, requested?: AutonomyMode): void {
		dto.autonomyMode = requested ?? modeFromApproval(dto.approvalMode);
		dto.effectiveMode = dto.autonomyMode;
		dto.verificationState = "unknown";
		dto.availableActions = [];
		this.syncAuthority(dto);
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
			// so swallow the rejection here rather than crash the bus listener. When the frame carries
			// a correlation id, the outcome is acked back to the CLAIMED sender — advisory only.
			const ack = (outcome: "applied" | "denied" | "error", detail?: string): void => {
				if (remote.cmdId && remote.replyTo) this.bus.sendAck({ cmdId: remote.cmdId, outcome, detail }, remote.replyTo);
			};
			void this.applyCommand(remote.cmd, remote.actor)
				.then(() => ack("applied"))
				.catch((err) => {
					if (err instanceof RbacDenied) {
						ack("denied", err.message);
						return;
					}
					ack("error", err instanceof Error ? err.message : String(err));
					this.log("error", `remote command failed: ${err instanceof Error ? err.message : String(err)}`);
				});
		});
		this.bus.onAck((ack) => {
			const waiter = this.ackWaiters.get(ack.cmdId);
			if (waiter) {
				this.ackWaiters.delete(ack.cmdId);
				waiter(ack);
			}
		});
		this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
		await this.refreshPlanFeatureSignature();
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
				record: this.automation.for("dispatch"),
				ledger: openDispatchLedger(this.stateDir),
			});
			this.dispatcher.start(interval);
			this.log("info", `auto-dispatch on (every ${Math.round(interval / 1000)}s, max ${maxActive}${this.closeOnDone ? ", auto-close" : ""})`);
		}
		this.orchestrator = this.buildOrchestrator();
		this.orchestrator.start();

		// Boot guard: warn loudly when a land target is hand-dirtied — auto-lands DEFER on a dirty main
		// (a rollback would discard the changes), and the durable fix is a dedicated checkout no human
		// edits (README → "Dedicated land checkout").
		for (const w of dirtyLandTargetWarnings(planeRepos(), (repo) => this.trackedDirtyCount(repo))) this.log("warn", w);

		// Observer (OMPSQ-52) — periodic self-audit sibling to the orchestrator. One per configured Plane
		// repo (OMPSQ-137) so every repo's backlog is audited, not just the first. Each gets a repo-scoped
		// seen-map (the first keeps the legacy filename for upgrade continuity; the rest are suffixed).
		const observeRepos = planeRepos();
		const slug = (repo: string) => repo.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		if (process.env.OMP_SQUAD_OBSERVE !== "0" && observeRepos.length > 0) {
			observeRepos.forEach((repo, i) => {
				const observer = new Observer({
					listAgents: () => this.list(),
					listIssues: () => listPlaneIssues(repo),
					fileIssue: (title) => createPlaneIssue(repo, title),
					closeIssue: (ref) => closePlaneIssue(ref),
					reopenIssue: (ref) => reopenPlaneIssue(ref),
					removeAgent: (id) => this.remove(id, false),
					runGate: () => this.runMainGate(repo),
					gitAheadOfMain: (a) => this.aheadOfMain(a),
					untrackedInMain: () => this.untrackedInMain(repo),
					filesOnAgentBranch: (a) => this.filesOnAgentBranch(a),
					landLedger: () => readLandLedger(this.stateDir),
					stateDir: this.stateDir,
					seenFile: i === 0 ? undefined : `observer-seen.${slug(repo)}.json`,
					log: (m) => this.log("info", `observer[${repo}]: ${m}`),
					record: this.automation.for("observer", repo),
				});
				observer.start();
				this.observers.push(observer);
			});
			this.log("info", `observer on (auditing ${observeRepos.join(", ")})`);
		}

		// Plan-sync — keeps plans/<x>/NN-concern.md STATUS lines truthful against their PLANE:
		// pointers (a landed issue's doc otherwise stays `open` and the WIP counters lie). One
		// slow tick per configured Plane repo; conservative one-way transitions (see plan-sync.ts).
		if (process.env.OMP_SQUAD_PLANSYNC !== "0" && observeRepos.length > 0) {
			const intervalMs = Number(process.env.OMP_SQUAD_PLANSYNC_INTERVAL_MS) || 300_000;
			for (const repo of observeRepos) {
				const tick = (): void => {
					void syncPlanStatuses({
						repo,
						listIssues: () => listPlaneIssuesAllStates(repo),
						log: (m) => this.log("info", m),
						record: this.automation.for("plan-sync", repo),
					}).then((r) => {
						if (r.updated.length) this.emitFeaturesChanged();
					}).catch(() => {});
				};
				this.planSyncTimers.push(setInterval(tick, intervalMs));
				setTimeout(tick, 15_000); // first pass shortly after boot, off the hot startup path
			}
			this.log("info", `plan-sync on (reconciling STATUS lines for ${observeRepos.join(", ")} every ${Math.round(intervalMs / 1000)}s)`);
		}

		// Scout (sibling to the Observer) — semantic harvest, not operational audit: it reads agents'
		// reasoning and files the latent items they surfaced but didn't do. One per configured Plane repo
		// (OMPSQ-137); each only harvests agents whose repo it owns (scoutFor), so a finding lands in the
		// right tracker. Mid-run via the periodic sweep (liveReasoning) + run-end via finalizeRun.
		if (process.env.OMP_SQUAD_SCOUT !== "0" && observeRepos.length > 0) {
			observeRepos.forEach((repo, i) => {
				const scout: Scout = new Scout({
					extract: ompClassify(this.bin),
					listIssues: () => listPlaneIssues(repo),
					fileIssue: (title, body) => createPlaneIssue(repo, title, body),
					liveReasoning: () =>
						[...this.agents.values()]
							.filter((r) => r.dto.status === "working" && this.scoutFor(r.dto.repo) === scout)
							.map((r) => ({ agent: r.dto.id, runId: r.run?.snapshot().runId, task: r.options.task, issue: r.dto.issue?.identifier ?? r.dto.issue?.name, text: this.takeScoutReasoning(r) }))
							.filter((s) => s.text.length > 0),
					stateDir: this.stateDir,
					seenFile: i === 0 ? undefined : `scout-seen.${slug(repo)}.json`,
					log: (m) => this.log("info", `scout[${repo}]: ${m}`),
					record: this.automation.for("scout", repo),
				});
				scout.start();
				this.scouts.set(repo, scout);
			});
			this.log("info", `scout on (harvesting reasoning → ${observeRepos.join(", ")})`);
		}

		// Opportunity loop — zero-token clustering over Scout's open issues plus receipt hot areas.
		if (process.env.OMP_SQUAD_OPPORTUNITY !== "0" && observeRepos.length > 0) {
			observeRepos.forEach((repo, i) => {
				const opportunity = new Opportunity({
					listIssues: () => listPlaneIssues(repo),
					fileIssue: (title, body) => createPlaneIssue(repo, title, body),
					scoutFacts: async () => loadScoutFacts(this.stateDir, (await listPlaneIssues(repo).catch(() => null)) ?? []),
					hotAreas: async () => (await this.fabric(LOCAL_ACTOR, { repos: [repo], includeLeases: false })).hotAreas,
					stateDir: this.stateDir,
					seenFile: i === 0 ? undefined : `opportunity-seen.${slug(repo)}.json`,
					log: (m) => this.log("info", `opportunity[${repo}]: ${m}`),
					record: this.automation.for("opportunity", repo),
				});
				opportunity.start();
				this.opportunities.push(opportunity);
			});
			this.log("info", `opportunity on (clustering scout patterns → ${observeRepos.join(", ")})`);
		}
	}

	/**
	 * Build the auto-drive Orchestrator wired to the manager's shared Scheduler (OMPSQ-134): the same
	 * instance `create()` parks cap-denied spawns into, so the loop's admission-drain actually dequeues
	 * them. Extracted from `start()` (which arms the live daemon — bus/federation/timers) so this single
	 * load-bearing wiring is unit-testable in isolation. NEVER call `.start()` here — that's `start()`'s job.
	 */
	protected buildOrchestrator(): Orchestrator {
		return new Orchestrator({
			listAgents: () => this.list(),
			spawn: (opts) => this.create(opts),
			verify: async (id) => (await this.verifyFeature(id))?.ok ?? false,
			land: async (id) => (await this.landFeature(id)).ok,
			verifyAgent: (id) => this.verifyAgentWork(id),
			landAgentWork: async (id) => {
				const r = await this.land(id);
				if (r.staged) return "staged"; // OMPSQ-175: staged ⇒ orchestrator holds, never parks
				if (r.retryable) return "retryable"; // dirty main ⇒ retry next tick, never park/halt
				return r.ok;
			},
			agentHasWork: (id) => this.agentHasUnlandedWork(id),
			holdForConfirm: this.landConfirm,
			notifyReady: (id) => this.markLandReady(id),
			onCatastrophe: (id, detail) => this.markCatastrophe(id, detail),
			log: (m) => this.log("info", `orchestrator: ${m}`),
			persist: openOrchestratorState(this.stateDir), // OMPSQ-139: halted/landed/staged survive restart, keyed by branch
			scheduler: this.scheduler, // OMPSQ-134: drain the SAME queue create() parks into (OMP_SQUAD_QUEUE_ON_FULL)
		});
	}

	/** Spawn a routed agent for a Plane issue — the auto-dispatch entry point (intent → process). */
	private async dispatchSpawn(repo: string, issue: IssueRef): Promise<void> {
		const task = `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.name}`;
		await this.create({ repo, name: issue.identifier?.toLowerCase(), branch: planeIssueBranch(issue), task, issue, autoRoute: true, approvalMode: "yolo" });
	}

	/** Start (or return the existing) agent advancing a Plane issue — the web "Start task" action. */
	async startTask(repo: string, issue: IssueRef, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		const existing = [...this.agents.values()].find((r) => r.dto.issue?.id === issue.id);
		if (existing) return existing.dto;
		const task = `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.name}`;
		return this.create({ repo, name: issue.identifier?.toLowerCase(), branch: planeIssueBranch(issue), task, issue, autoRoute: true, approvalMode: "yolo" }, actor);
	}

	async stop(): Promise<void> {
		clearInterval(this.pollTimer);
		this.dispatcher?.stop();
		this.orchestrator?.stop();
		for (const o of this.observers) o.stop();
		for (const t of this.planSyncTimers.splice(0)) clearInterval(t);
		for (const s of this.scouts.values()) s.stop();
		for (const o of this.opportunities) o.stop();
		await this.persist();
		// Detach (don't kill): leave each agent's detached host + omp running so a
		// restart/upgrade reconnects to live agents with full context.
		for (const r of this.agents.values()) r.agent.detach?.();
		await this.bus.stop();
	}

	/** The scout that owns an agent's repo — exact key, else basename match, else the first configured
	 *  repo as catch-all (so an unmapped/manual agent still gets harvested). `undefined` ⇒ scout disabled. */
	private scoutFor(agentRepo: string): Scout | undefined {
		const keys = [...this.scouts.keys()];
		if (keys.length === 0) return undefined;
		const base = path.basename(agentRepo);
		const key = keys.find((r) => r === agentRepo) ?? keys.find((r) => path.basename(r) === base) ?? keys[0];
		return this.scouts.get(key);
	}

	/** On daemon start, reattach to any agent whose detached host survived (upgrade/restart). */
	private async reconnectLive(snapshot: StateSnapshot): Promise<number> {
		this.capabilityStore = normalizeCapabilitySnapshot(snapshot.capabilities);
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
		const halted = openOrchestratorState(this.stateDir);
		const resumable = (p: PersistedAgent): boolean => p.kind === "workflow" && p.workflowState !== undefined;
		// Eligible = adoptable (dead host, on-disk worktree, not a branch child) AND not a branch the
		// orchestrator already halted (re-adopting a halted run burns a ceiling slot + a resume attempt
		// before the orchestrator re-skips it).
		const eligible = agentsToAdopt(snapshot.agents, new Set(this.agents.keys()), (wt) => existsSync(wt)).filter((p) => !(p.branch && halted.isHalted(p.branch)));
		// Probe each for unlanded work, then cap re-adoption at the agent ceiling. Re-spawning EVERY
		// orphaned worktree at once (bypassCap) is what OOM'd the host on restart. A resumable workflow
		// CHECKPOINT counts as work even with a clean worktree (the run is mid-graph between commits) —
		// otherwise a crashed graph run with no dirty files is dropped as "done". Done/clean plain agents
		// re-dispatch gradually under the WIP cap; at most (ceiling - already-live) are taken over this boot.
		const work = new Map<string, boolean>();
		for (const p of eligible) work.set(p.id, resumable(p) || (await this.persistedHasWork(p)));
		const adopt = selectAdoptable(eligible, (p) => work.get(p.id) ?? false, hardAgentCeiling() - this.agents.size);
		// D1 FIX: resumable runs the ceiling dropped are PRESERVED (not erased). persistNow folds them back
		// into the snapshot so a later restart re-attempts them, instead of the full-snapshot persist silently
		// overwriting a still-resumable checkpoint into oblivion.
		this.deferred = deferredResumable(eligible, resumable, adopt);
		const skipped = eligible.length - adopt.length;
		let n = 0;
		for (const p of adopt) {
			await this.create({
				name: p.name,
				repo: p.repo,
				existingPath: p.worktree,
				branch: p.branch,
				model: p.model,
				profileId: p.profileId,
				approvalMode: p.approvalMode,
				autonomyMode: p.autonomyMode,
				thinking: p.thinking,
				issue: p.issue,
				parentId: p.parentId,
				featureId: p.featureId,
				owns: p.owns,
				requires: p.requires,
				produces: p.produces,
				scopeSource: p.scopeSource,
				workflow: p.workflow?.path,
				verify: p.workflow?.verify?.command,
				// Resume the graph from its checkpoint; without this the adopted workflow restarts from
				// scratch — re-running completed stages and re-committing their work (OMPSQ-165).
				workflowState: p.workflowState,
				sandbox: p.sandbox,
				autoRoute: false,
				bypassCap: true,
				// OMPSQ-164: a re-adopted plain agent with complete work is auto-landed directly by the
				// orchestrator. A workflow must NOT be direct-landed — a resuming/partial graph lands only via
				// its own workflow_done → autoLandOnSuccess once the graph completes (RTC-F5).
				adopted: p.kind !== "workflow",
				// The prior inner host is gone (this is the orphan-adoption path, not warm reconnect), so a
				// resumed workflow runs on a FRESH thread: cold resume re-executes the in-flight node soundly.
				cold: true,
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
			profileId: p.profileId,
			approvalMode: p.approvalMode,
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
			issue: p.issue,
			kind: p.kind ?? "omp-operator",
			parentId: p.parentId,
			featureId: p.featureId,
			owns: p.owns,
			requires: p.requires,
			produces: p.produces,
			scopeSource: p.scopeSource,
			workflow: p.workflow,
			workflowState: p.workflowState,
		};
		this.seedAuthority(dto, p.autonomyMode);
		const agent = this.makeDriver(p);
		const rec: AgentRecord = { dto, agent, options: p, transcript, assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
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

	profiles(): AgentProfile[] {
		const envProfiles = profileOptionsFromEnv();
		const envIds = new Set(envProfiles.map((p) => p.id));
		const installed = capabilityProfiles(this.capabilityStore).filter((p) => !envIds.has(p.id));
		return [...envProfiles, ...installed];
	}

	capabilities(): CapabilitySnapshot {
		return this.capabilityStore;
	}

	importCapability(input: CapabilityImportInput, actor: Actor = LOCAL_ACTOR): { source: CapabilitySnapshot["sources"][number]; pack: CapabilitySnapshot["packs"][number]; warnings: string[] } {
		const out = importCapabilitySource(this.capabilityStore, input, actor.id);
		void this.store.appendAudit({ actor: actor.id, action: "capability.source.import", target: out.source.id, detail: { packId: out.pack.id, checksum: out.pack.checksum } }).catch((err) => this.log("warn", `capability audit write failed: ${err instanceof Error ? err.message : String(err)}`));
		void this.persist();
		this.emitFeaturesChanged();
		return out;
	}

	installCapability(input: CapabilityInstallInput, actor: Actor = LOCAL_ACTOR): CapabilitySnapshot["installs"][number] {
		const install = installCapability(this.capabilityStore, { ...input, orgId: input.orgId ?? actor.orgId ?? "file" }, actor.id);
		void this.store.appendAudit({ actor: actor.id, action: "capability.install", target: install.id, detail: { packId: install.packId, checksum: install.checksum } }).catch((err) => this.log("warn", `capability audit write failed: ${err instanceof Error ? err.message : String(err)}`));
		void this.persist();
		this.emitFeaturesChanged();
		return install;
	}

	updateCapability(id: string, patch: CapabilityInstallPatch, actor: Actor = LOCAL_ACTOR): CapabilitySnapshot["installs"][number] {
		const install = updateCapabilityInstall(this.capabilityStore, id, patch, actor.id);
		void this.store.appendAudit({ actor: actor.id, action: `capability.${install.state}`, target: install.id, detail: { packId: install.packId, checksum: install.checksum } }).catch((err) => this.log("warn", `capability audit write failed: ${err instanceof Error ? err.message : String(err)}`));
		void this.persist();
		this.emitFeaturesChanged();
		return install;
	}

	capabilityDiff(beforeId: string, afterId: string) {
		const before = this.capabilityStore.packs.find((pack) => pack.id === beforeId);
		const after = this.capabilityStore.packs.find((pack) => pack.id === afterId);
		if (!before || !after) throw new Error("capability pack not found");
		return diffCapabilityPacks(before, after);
	}

	capabilityFederation() {
		return capabilityFederationMetadata(this.capabilityStore);
	}

	capabilityWorkflowDefinitions() {
		return capabilityWorkflowDefinitions(this.capabilityStore);
	}

	async runCapability(installId: string, bindingKey: string | undefined, opts: { repo?: string; prompt?: string } = {}, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		const install = this.capabilityStore.installs.find((item) => item.id === installId);
		if (!install || install.state !== "enabled") throw new Error("enabled capability install not found");
		const pack = this.capabilityStore.packs.find((item) => item.id === install.packId);
		if (!pack) throw new Error("capability pack not found");
		const binding = bindingKey ? install.bindings.find((item) => item.enabled && item.key === bindingKey) : install.bindings.find((item) => item.enabled && (item.type === "profile" || item.type === "workflow" || item.type === "driver"));
		if (!binding) throw new Error("capability binding not found");
		// requiredEnv ENFORCEMENT (#5): packs declare env vars they need, but it was parsed and never checked
		// — an agent would spawn blind and fail opaquely downstream. Refuse up front with a clear error naming
		// the missing vars, before any worktree/host is created.
		const missingEnv = pack.requiredEnv.filter((name) => !(process.env[name] && process.env[name]!.trim()));
		if (missingEnv.length) {
			void this.recordAudit(actor, "capability.run.blocked", binding.key, "error", `missing required env: ${missingEnv.join(", ")}`);
			throw new Error(`capability "${pack.slug}" requires environment variable(s) not set: ${missingEnv.join(", ")}`);
		}
		const repo = opts.repo ?? process.cwd();
		const prompt = opts.prompt ?? `Run capability ${binding.key}`;
		const name = binding.key.replace(/^cap:/, "").replace(/[^a-z0-9-]+/gi, "-").slice(0, 24) || "capability";
		if (binding.type === "driver" && binding.config.runtime === "flue-service") {
			const dir = path.join(this.stateDir, "capabilities", install.id);
			await fs.mkdir(dir, { recursive: true });
			await Promise.all(pack.files.map(async (file) => {
				if (file.content === undefined) return;
				const target = path.join(dir, file.path);
				if (!target.startsWith(dir + path.sep)) throw new Error("capability file path escapes install dir");
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, file.content);
			}));
			const workflow = typeof binding.config.workflow === "string" ? binding.config.workflow : pack.workflows[0]?.path ?? pack.workflows[0]?.id ?? pack.slug;
			const target = binding.config.target === "cloudflare" ? "cloudflare" : "node";
			return this.create({ repo, name, task: prompt, autoRoute: false, flue: { dir, workflow, target } }, actor);
		}
		if (binding.type === "workflow") {
			// WORKFLOW binding execution (#2): previously this passed `workflow: binding.sourcePath`, which is
			// undefined for inline step-graph bindings → `create` classified the agent as a plain omp-operator
			// and the step graph never ran. Resolve the workflow path to actually drive a WorkflowDriver:
			//  - an authored file (binding.sourcePath) is used directly;
			//  - an inline step-graph binding is materialized to a DOT graph file in the install dir, so the
			//    same engine that runs authored workflows executes the capability's declared steps.
			const workflowPath = await this.resolveCapabilityWorkflowPath(install, binding);
			return this.create({ repo, name, workflow: workflowPath, task: prompt, autoRoute: false }, actor);
		}
		return this.create({ repo, name, profileId: binding.key, task: prompt, autoRoute: false }, actor);
	}

	/**
	 * Resolve a workflow binding to a graph file path the WorkflowDriver can run. An authored `sourcePath`
	 * is returned as-is. Otherwise the binding's WorkflowDefinition (resolved by binding key via
	 * capabilityWorkflowDefinitions) is rendered to a DOT graph and written into the per-install dir, and
	 * that path is returned — so an inline capability step graph actually executes instead of being dropped.
	 */
	private async resolveCapabilityWorkflowPath(install: CapabilitySnapshot["installs"][number], binding: CapabilitySnapshot["installs"][number]["bindings"][number]): Promise<string> {
		if (binding.sourcePath) return binding.sourcePath;
		const definition = capabilityWorkflowDefinitions(this.capabilityStore).find((def) => def.id === binding.key);
		if (!definition || definition.steps.length === 0) {
			throw new Error(`capability workflow "${binding.key}" has no resolvable steps to run`);
		}
		const dir = path.join(this.stateDir, "capabilities", install.id, "workflows");
		await fs.mkdir(dir, { recursive: true });
		const dot = capabilityWorkflowToDot(definition);
		// Validate the synthesized graph round-trips through the same parser the driver uses (exactly one
		// start/exit, well-formed edges) before persisting it — fail loudly here, not at spawn time.
		parseWorkflow(dot);
		const file = path.join(dir, `${slugifyForFile(binding.key)}.fabro`);
		await fs.writeFile(file, dot);
		return file;
	}

	private profileFor(id: string | undefined): AgentProfile | undefined {
		if (!id) return undefined;
		return this.profiles().find((p) => p.id === id);
	}

	async modelOptions(): Promise<RuntimeModelOption[]> {
		for (const rec of this.agents.values()) {
			if (!rec.agent.isAlive || !rec.agent.getAvailableModels) continue;
			try {
				const result = await rec.agent.getAvailableModels();
				const options = modelOptionsFromRuntime(result.models);
				if (options.length) return options;
			} catch {
				/* fall back to configured models */
			}
		}
		return [];
	}

	async listFeedbackCampaigns(): Promise<FeedbackCampaign[]> {
		return (await this.store.loadFeedback()).campaigns;
	}

	async listFeedbackItems(): Promise<{ items: FeedbackSummary[]; raw: FeedbackItem[]; validations: FeedbackValidationResponse[]; rewards: FeedbackReward[] }> {
		const snap = await this.store.loadFeedback();
		return {
			items: snap.items.map((item) => summarizeFeedback(item, snap.validations, snap.rewards.find((r) => r.feedbackId === item.id))),
			raw: snap.items,
			validations: snap.validations,
			rewards: snap.rewards,
		};
	}

	async seedFeedbackCampaign(opts: { id?: string; name: string; repo: string; token: string; allowedOrigins?: string[]; rewardCents?: number; rewardCurrency?: string }): Promise<FeedbackCampaign> {
		const snap = await this.store.loadFeedback();
		const now = Date.now();
		const id = opts.id?.trim() || newCampaignId();
		const campaign: FeedbackCampaign = {
			id,
			name: opts.name.trim() || "Feedback campaign",
			repo: opts.repo.trim() || process.cwd(),
			tokenHash: hashCampaignToken(opts.token),
			allowedOrigins: opts.allowedOrigins?.length ? opts.allowedOrigins : ["*"],
			rewardCents: opts.rewardCents,
			rewardCurrency: opts.rewardCurrency,
			createdAt: snap.campaigns.find((c) => c.id === id)?.createdAt ?? now,
		};
		const i = snap.campaigns.findIndex((c) => c.id === id);
		if (i >= 0) snap.campaigns[i] = campaign;
		else snap.campaigns.push(campaign);
		await this.store.saveFeedback(snap);
		return campaign;
	}

	async submitFeedbackItem(body: unknown, origin?: string | null, now = Date.now()): Promise<FeedbackItem> {
		const snap = await this.store.loadFeedback();
		const accepted = acceptFeedbackSubmission({ campaigns: snap.campaigns, body, origin, now, maxImageBytes: feedbackMaxImageBytes() });
		if (accepted.attachmentBytes && accepted.item.attachment && accepted.attachmentExt) {
			const rel = path.join("feedback", "attachments", accepted.item.id, `${accepted.item.attachment.id}.${accepted.attachmentExt}`);
			const full = path.join(this.stateDir, rel);
			await fs.mkdir(path.dirname(full), { recursive: true });
			const tmp = `${full}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
			await fs.writeFile(tmp, accepted.attachmentBytes);
			await fs.rename(tmp, full);
			accepted.item.attachment = { ...accepted.item.attachment, path: rel };
		}
		snap.items.push(accepted.item);
		if (accepted.reward) snap.rewards.push(accepted.reward);
		await this.store.saveFeedback(snap);
		return accepted.item;
	}

	async acceptFeedback(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackItem> {
		const snap = await this.store.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		if (item.status === "rejected") throw new Error("rejected feedback cannot be accepted");
		if (item.status !== "promoted") item.status = "accepted";
		item.updatedAt = Date.now();
		await this.store.saveFeedback(snap);
		await this.recordFeedbackAudit(actor, "feedback.accept", id);
		return item;
	}

	async rejectFeedback(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackItem> {
		const snap = await this.store.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		if (item.status === "promoted") throw new Error("promoted feedback cannot be rejected");
		item.status = "rejected";
		item.updatedAt = Date.now();
		await this.store.saveFeedback(snap);
		await this.recordFeedbackAudit(actor, "feedback.reject", id);
		return item;
	}

	async promoteFeedback(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackItem> {
		const snap = await this.store.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		if (item.planeIssue) return item;
		if (item.status === "rejected") throw new Error("rejected feedback cannot be promoted");
		if (item.status !== "accepted" && item.status !== "needs-validation") throw new Error("feedback must be accepted or needs-validation before promotion");
		const rendered = renderFeedbackPlaneIssue(item, snap.validations.filter((v) => v.feedbackId === id), snap.rewards.find((r) => r.feedbackId === id));
		const issue = await createPlaneIssue(item.repo, rendered.title, rendered.descriptionHtml);
		if (!issue) throw new Error("plane issue create failed");
		item.planeIssue = issue;
		item.status = "promoted";
		item.updatedAt = Date.now();
		await this.store.saveFeedback(snap);
		await this.recordFeedbackAudit(actor, "feedback.promote", id, issue.identifier ?? issue.id);
		return item;
	}

	async addFeedbackValidation(id: string, input: FeedbackValidationInput, actor: Actor = LOCAL_ACTOR): Promise<FeedbackValidationResponse> {
		const snap = await this.store.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		const validation = normalizeFeedbackValidation(input, item);
		snap.validations.push(validation);
		if (item.status === "new") {
			item.status = "needs-validation";
			item.updatedAt = Date.now();
		}
		await this.store.saveFeedback(snap);
		await this.recordFeedbackAudit(actor, "feedback.validation", id);
		return validation;
	}

	async listFeedbackValidations(id: string): Promise<FeedbackValidationResponse[]> {
		const snap = await this.store.loadFeedback();
		feedbackItemOrThrow(snap.items, id);
		return snap.validations.filter((v) => v.feedbackId === id);
	}

	async approveFeedbackReward(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackReward> {
		const snap = await this.store.loadFeedback();
		const { item, reward } = rewardRecordOrThrow(snap, id);
		assertRewardTransition(reward.status, "approved");
		reward.status = "approved";
		reward.reviewer = actor.id;
		reward.updatedAt = Date.now();
		item.rewardStatus = "approved";
		item.updatedAt = reward.updatedAt;
		await this.store.saveFeedback(snap);
		await this.recordFeedbackAudit(actor, "feedback.reward.approve", id);
		return reward;
	}

	async voidFeedbackReward(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackReward> {
		const snap = await this.store.loadFeedback();
		const { item, reward } = rewardRecordOrThrow(snap, id);
		assertRewardTransition(reward.status, "void");
		reward.status = "void";
		reward.reviewer = actor.id;
		reward.updatedAt = Date.now();
		item.rewardStatus = "void";
		item.updatedAt = reward.updatedAt;
		await this.store.saveFeedback(snap);
		await this.recordFeedbackAudit(actor, "feedback.reward.void", id);
		return reward;
	}

	/**
	 * Disburse an approved feedback reward through the configured payment provider, then persist the
	 * result. This is the real money-movement entry point (replaces the old "manual ledger only"):
	 *
	 *  - State-machine gate FIRST, before any mutation or network call: only approved → paid is legal.
	 *    assertRewardTransition rejects illegal sources (none/pending/void/paid → paid) so a reward can
	 *    never jump to paid unapproved — and so we never call the provider for an ineligible reward.
	 *  - Idempotency: the reward id is passed as the provider's idempotencyKey. Real providers thread it
	 *    into the upstream idempotency handle (Tremendous `external_id`), so a retried payout for one
	 *    reward can never disburse twice.
	 *  - Manual provider (no creds, or name "manual"): preserves today's behavior — the operator must
	 *    supply a non-empty `provider` label AND `externalRef` (the out-of-band proof-of-payment handle).
	 *    No funds move; it's a recorded ledger entry.
	 *  - Real provider (e.g. Tremendous): recipient email is taken from `opts.recipientEmail` or the
	 *    linked feedback item's userEmail; provider + externalRef are read from the RESULT, not the
	 *    operator. On status "paid"/"pending" we persist the result's externalRef and set the reward
	 *    status (pending is recorded as paid since the model has no pending reward state). On "failed"
	 *    we do NOT mark paid — the reward stays approved and we throw a clear error.
	 *  - A provider error is a value (status:"failed"), never an exception across the provider boundary,
	 *    so a payout failure cannot crash the daemon.
	 */
	async markFeedbackRewardPaid(
		id: string,
		opts: { provider?: string; externalRef?: string; recipientEmail?: string; recipientName?: string; note?: string } = {},
		actor: Actor = LOCAL_ACTOR,
	): Promise<FeedbackReward> {
		const operatorProvider = typeof opts.provider === "string" ? opts.provider.trim() : "";
		const operatorRef = typeof opts.externalRef === "string" ? opts.externalRef.trim() : "";
		const isManual = this.paymentProvider.name === "manual";
		// Manual path keeps the original required-fields contract: an out-of-band payout is only a
		// trustworthy ledger entry if the operator names the provider AND the proof-of-payment handle.
		if (isManual) {
			if (!operatorProvider) throw new Error("provider is required to record a reward payout (e.g. the payment service used)");
			if (!operatorRef) throw new Error("externalRef is required to record a reward payout (the provider's payment/transaction reference)");
		}

		const snap = await this.store.loadFeedback();
		const { item, reward } = rewardRecordOrThrow(snap, id);
		// State-machine gate FIRST, before any mutation or network call.
		assertRewardTransition(reward.status, "paid");

		// Recipient comes from the explicit opt or the linked feedback item. Real disbursement needs it.
		const recipientEmail = (opts.recipientEmail ?? item.userEmail ?? "").trim();
		const recipientName = opts.recipientName?.trim() || undefined;
		const note = opts.note?.trim() || `omp-squad feedback reward for ${item.id}`;
		if (!isManual && !recipientEmail) {
			throw new Error("recipientEmail is required to disburse this reward (set it on the request or capture userEmail on the feedback item)");
		}

		// For the manual path, seed a per-call ManualProvider with the operator's externalRef so the
		// recorded handle is exactly what the operator supplied; otherwise use the configured provider.
		const provider = isManual ? new ManualProvider({ name: operatorProvider, externalRef: operatorRef }) : this.paymentProvider;
		const result = await provider.payout({
			idempotencyKey: reward.id, // reward id == idempotency key: retries never double-pay
			amountCents: reward.amount,
			currency: reward.currency,
			recipientEmail,
			recipientName,
			note,
		});

		if (result.status === "failed") {
			// Do NOT mark paid. Reward stays approved. Surface a clear error to the caller.
			await this.recordFeedbackAudit(actor, "feedback.reward.payout_failed", id, `payout via ${result.provider} failed: ${result.error ?? "unknown error"}`);
			throw new Error(`reward payout failed (${result.provider}): ${result.error ?? "unknown error"}`);
		}

		// status "paid" or "pending": persist the RESULT's provider + externalRef and mark the reward.
		// The reward model has no "pending" state, so a pending disbursement is recorded as paid (the
		// money/order has been accepted upstream) — the audit detail preserves the true provider status.
		reward.status = "paid";
		reward.provider = result.provider;
		reward.externalRef = result.externalRef;
		reward.reviewer = actor.id;
		reward.updatedAt = Date.now();
		item.rewardStatus = "paid";
		item.updatedAt = reward.updatedAt;
		await this.store.saveFeedback(snap);
		const detail = isManual
			? `manual record of externally-executed payment via ${result.provider} (ref ${result.externalRef}); no funds moved by omp-squad`
			: `disbursed via ${result.provider} (ref ${result.externalRef}, status ${result.status}) to ${recipientEmail}`;
		await this.recordFeedbackAudit(actor, "feedback.reward.paid", id, detail);
		return reward;
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
		// Include the configured Plane repos so the planner shows a project (repo) + its plan-dir features
		// even before any agent runs — otherwise a fresh daemon (0 agents) renders an empty planner.
		const repos = repo !== undefined ? [repo] : [...new Set([...list.map((a) => a.repo), ...persisted.map((f) => f.repo), ...planeRepos()])];
		const out: FeatureDTO[] = [];
		for (const r of repos) out.push(...(await buildFeatures(r, list.filter((a) => a.repo === r), persisted)));
		for (const feature of out) feature.planRevisionCandidates = await this.listPlanRevisionCandidates({ repo: feature.repo, featureId: feature.id });
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

	async updateFeature(id: string, patch: { title?: string; stageOverride?: FeatureStage | null; archived?: boolean; repo?: string; description?: string; acceptanceCriteria?: FeatureCriterion[]; decisions?: FeatureDecision[]; relationships?: FeatureRelationship[]; contextBundle?: PersistedFeature["contextBundle"] }): Promise<PersistedFeature | undefined> {
		const pf = this.featureStore.get(id) ?? await this.adoptDerivedFeature(id, patch.repo);
		if (!pf) return undefined;
		const wasArchived = !!pf.archived;
		if (patch.title !== undefined) pf.title = patch.title;
		if (patch.stageOverride !== undefined) pf.stageOverride = patch.stageOverride ?? undefined;
		if (patch.archived !== undefined) pf.archived = patch.archived;
		if (patch.description !== undefined) pf.description = patch.description;
		if (patch.acceptanceCriteria !== undefined) pf.acceptanceCriteria = patch.acceptanceCriteria;
		if (patch.decisions !== undefined) pf.decisions = patch.decisions;
		if (patch.relationships !== undefined) pf.relationships = patch.relationships;
		if (patch.contextBundle !== undefined) pf.contextBundle = patch.contextBundle;
		pf.updatedAt = Date.now();
		// Archive is reversible AND cascades to the plan files: archiving moves
		// plans/<x>/ → plans/.archive/<x>/, unarchiving moves it back. Non-fatal: a
		// missing/already-moved dir just no-ops, and the flag flip still persists.
		if (patch.archived !== undefined && patch.archived !== wasArchived && pf.origin?.planDir) {
			try {
				if (patch.archived) await archivePlanDir(pf.repo, pf.origin.planDir);
				else await restorePlanDir(pf.repo, pf.origin.planDir);
			} catch (err) {
				this.log("warn", `plan dir ${patch.archived ? "archive" : "restore"} failed for ${pf.origin.planDir}: ${String(err)}`);
			}
		}
		this.emitFeaturesChanged();
		return pf;
	}

	/**
	 * Edit one concern of a feature's plan from the flow diagram: rewrite its STATUS and/or the
	 * concerns that block it, persisting to the concern doc + overview dependency table. Works for
	 * stored AND derived (plan-dir-scanned) features — it resolves the feature via features().
	 */
	async updateConcern(id: string, opts: { repo?: string; file: string; status?: string; blockedBy?: number[] }): Promise<PlanConcern | undefined> {
		const f = (await this.features(opts.repo)).find((x) => x.id === id);
		if (!f || !f.planDir) return undefined;
		const concern = await updatePlanConcern(f.repo, f.planDir, opts.file, { status: opts.status, blockedBy: opts.blockedBy });
		if (concern) this.emitFeaturesChanged();
		return concern;
	}

	/** Persisted, archived features (the "garbage bin") — the soft-deleted set the board hides. */
	archivedFeatures(repo?: string): { id: string; title: string; repo: string; planDir?: string; moduleUrl?: string; updatedAt: number }[] {
		return [...this.featureStore.values()]
			.filter((f) => f.archived && (!repo || f.repo === repo))
			.map((f) => ({ id: f.id, title: f.title, repo: f.repo, planDir: f.origin?.planDir, moduleUrl: f.plane?.moduleUrl, updatedAt: f.updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * Hard-delete a feature: a destructive, NON-reversible cross-system op (vs. updateFeature's
	 * reversible archive). Removes the persisted feature, permanently deletes its plan dir (live
	 * OR archived), and detaches member agents (membership only — the agents keep running, they
	 * just lose the feature link). When `plane: "detach"`, also removes the Plane MODULE grouping
	 * (the issues themselves are never touched). Returns what actually happened.
	 */
	async deleteFeature(id: string, opts: { repo?: string; plane?: "keep" | "detach" } = {}): Promise<{ deleted: boolean; planDirRemoved: boolean; planeModuleRemoved: boolean; detachedAgents: number }> {
		const pf = this.featureStore.get(id) ?? await this.adoptDerivedFeature(id, opts.repo);
		if (!pf) return { deleted: false, planDirRemoved: false, planeModuleRemoved: false, detachedAgents: 0 };

		let detachedAgents = 0;
		for (const rec of this.agents.values()) {
			if (rec.dto.featureId === id) {
				rec.dto.featureId = undefined;
				rec.options.featureId = undefined;
				this.emitAgent(rec);
				detachedAgents += 1;
			}
		}

		let planDirRemoved = false;
		if (pf.origin?.planDir) {
			try { planDirRemoved = await deletePlanDir(pf.repo, pf.origin.planDir); }
			catch (err) { this.log("warn", `plan dir delete failed for ${pf.origin.planDir}: ${String(err)}`); }
		}

		let planeModuleRemoved = false;
		if (opts.plane === "detach" && pf.plane?.moduleId) {
			try { planeModuleRemoved = (await deletePlaneModule(pf.repo, pf.plane.moduleId)) === true; }
			catch (err) { this.log("warn", `plane module detach failed for ${pf.plane.moduleId}: ${String(err)}`); }
		}

		this.featureStore.delete(id);
		this.emitFeaturesChanged();
		return { deleted: true, planDirRemoved, planeModuleRemoved, detachedAgents };
	}

	private async adoptDerivedFeature(id: string, repo?: string): Promise<PersistedFeature | undefined> {
		const found = (await this.features(repo)).find((feature) => feature.id === id);
		if (!found) return undefined;
		const now = Date.now();
		const pf: PersistedFeature = {
			id: found.id,
			title: found.title,
			repo: found.repo,
			origin: found.planDir ? { planDir: found.planDir } : undefined,
			plane: found.issueIdentifiers?.length ? { issueIdentifiers: found.issueIdentifiers } : undefined,
			description: found.description,
			acceptanceCriteria: found.acceptanceCriteria,
			decisions: found.decisions,
			relationships: found.relationships,
			contextBundle: found.contextBundle,
			createdAt: now,
			updatedAt: now,
		};
		this.featureStore.set(pf.id, pf);
		for (const agentId of found.agentIds) {
			const rec = this.agents.get(agentId);
			if (rec) {
				rec.dto.featureId = pf.id;
				rec.options.featureId = pf.id;
				this.emitAgent(rec);
			}
		}
		return pf;
	}

	private async persistedFeatureForAction(id: string, repo?: string): Promise<PersistedFeature | undefined> {
		return this.featureStore.get(id) ?? await this.adoptDerivedFeature(id, repo);
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
		let planDir = pf?.origin?.planDir;
		if (!idents.length) {
			// derived feature (identifiers live in plan docs) — fall back to the full build
			const f = (await this.features()).find((x) => x.id === id);
			idents = f?.issueIdentifiers ?? [];
			repo = f?.repo ?? repo;
			planDir = f?.planDir ?? planDir;
		}
		const tickets = idents.length && repo ? await featureTickets(repo, idents) : [];
		// Prefer the daemon's own module link; else the module URL /plan-to-plane backfilled into the plan dir
		// (skill-filed modules are created via MCP, so the daemon never set pf.plane.moduleUrl itself).
		let moduleUrl = pf?.plane?.moduleUrl;
		if (!moduleUrl && repo && planDir) moduleUrl = await planeModuleUrlIn(path.join(repo, planDir));
		return { tickets, moduleUrl };
	}

	/** Create a Plane module for a feature and group its issues under it; persists the link. */
	async createFeatureModule(id: string, opts: { repo?: string; createTickets?: boolean } = {}): Promise<{ moduleUrl: string; issueIdentifiers: string[]; createdIssues: IssueRef[] } | null> {
		const pf = await this.persistedFeatureForAction(id, opts.repo);
		if (!pf) return null;
		const f = (await this.features(pf.repo)).find((x) => x.id === id);
		let idents = [...new Set([...(pf.plane?.issueIdentifiers ?? []), ...(f?.issueIdentifiers ?? [])])];
		const createdIssues: IssueRef[] = [];
		const createdIssueByConcern = new Map<number, IssueRef>();
		if (opts.createTickets && !idents.length && pf.origin?.planDir) {
			const concerns = (await parsePlanConcerns(pf.repo, pf.origin.planDir)).filter((concern) => concern.open);
			for (const concern of concerns) {
				const issue = await createPlaneIssue(pf.repo, concern.title, renderPlanConcernIssueHtml(pf, concern));
				if (issue) {
					createdIssues.push(issue);
					const num = concernNumFromFile(concern.file);
					if (num != null) createdIssueByConcern.set(num, issue);
					if (issue.identifier) idents.push(issue.identifier);
				}
			}
			idents = [...new Set(idents)];
			if (createdIssueByConcern.size) {
				const graph = await parsePlanDependencyGraph(pf.repo, pf.origin.planDir);
				for (const [num, blockers] of graph) {
					const issue = createdIssueByConcern.get(num);
					if (!issue) continue;
					for (const blocker of blockers) {
						const blockerIssue = createdIssueByConcern.get(blocker);
						if (!blockerIssue) continue;
						const linked = await addPlaneBlockedByRelation(pf.repo, issue.id, blockerIssue.id);
						if (linked === null || linked === false) return null;
					}
				}
			}
		}
		const mod = pf.plane?.moduleId && pf.plane.moduleUrl
			? { moduleId: pf.plane.moduleId, moduleUrl: pf.plane.moduleUrl }
			: await ensureFeatureModule(pf.repo, pf.title, idents);
		if (!mod) return null;
		if (pf.plane?.moduleId) {
			const createdGrouped = await addIssueIdsToFeatureModule(pf.repo, pf.plane.moduleId, createdIssues.map((issue) => issue.id));
			if (createdGrouped === null || createdGrouped === false) return null;
			if (idents.length && !createdIssues.length) {
				const grouped = await addIssuesToFeatureModule(pf.repo, pf.plane.moduleId, idents);
				if (grouped === null || grouped === false) return null;
			}
		}
		pf.plane = { ...(pf.plane ?? {}), moduleId: mod.moduleId, moduleUrl: mod.moduleUrl, issueIdentifiers: idents };
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return { moduleUrl: mod.moduleUrl, issueIdentifiers: idents, createdIssues };
	}

	/** Repair a plan module after partial Plane writes: find generated concern tickets, link them, optionally close duplicate generated tickets. */
	async repairFeatureModuleTickets(id: string, opts: { repo?: string; closeOrphans?: boolean } = {}): Promise<{ moduleUrl: string; issueIdentifiers: string[]; linkedIssues: IssueRef[]; closedIssues: IssueRef[] } | null> {
		const pf = await this.persistedFeatureForAction(id, opts.repo);
		if (!pf?.origin?.planDir) return null;
		const concerns = (await parsePlanConcerns(pf.repo, pf.origin.planDir)).filter((concern) => concern.open);
		const module = pf.plane?.moduleId && pf.plane.moduleUrl
			? { moduleId: pf.plane.moduleId, moduleUrl: pf.plane.moduleUrl }
			: await ensureFeatureModule(pf.repo, pf.title, pf.plane?.issueIdentifiers ?? []);
		if (!module) return null;
		const openIssues = await listPlaneIssues(pf.repo);
		if (!openIssues) return null;
		const byConcern = new Map<string, IssueRef[]>();
		for (const issue of openIssues) {
			for (const concern of concerns) {
				if (issue.name.trim() !== concern.title.trim()) continue;
				const detail = await fetchIssueDetail(pf.repo, issue.id).catch(() => null);
				if (!detail || !planConcernTicketMatches(concern, issue, detail.body)) continue;
				byConcern.set(concern.path, [...(byConcern.get(concern.path) ?? []), issue]);
			}
		}
		const linkedIssues = [...byConcern.values()].flatMap((issues) => issues.slice(0, 1));
		const linkedIds = linkedIssues.map((issue) => issue.id);
		const linkedIdentifiers = linkedIssues.map((issue) => issue.identifier).filter((x): x is string => !!x);
		const linked = await addIssueIdsToFeatureModule(pf.repo, module.moduleId, linkedIds);
		if (linked === null || linked === false) return null;
		const closedIssues: IssueRef[] = [];
		if (opts.closeOrphans) {
			for (const issue of [...byConcern.values()].flatMap((issues) => issues.slice(1))) {
				if (await closePlaneIssue(issue)) closedIssues.push(issue);
			}
		}
		const issueIdentifiers = [...new Set([...(pf.plane?.issueIdentifiers ?? []), ...linkedIdentifiers])];
		pf.plane = { ...(pf.plane ?? {}), moduleId: module.moduleId, moduleUrl: module.moduleUrl, issueIdentifiers };
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return { moduleUrl: module.moduleUrl, issueIdentifiers, linkedIssues, closedIssues };
	}

	/** Cache the current member branches so land status survives an agent being killed. */
	private snapshotBranches(featureId: string): void {
		const pf = this.featureStore.get(featureId);
		if (!pf) return;
		pf.branches = [...this.agents.values()].filter((r) => r.dto.featureId === featureId).map((r) => ({ branch: r.dto.branch, worktree: r.dto.worktree, agentId: r.dto.id }));
	}

	/** Land all member branches: fast-forward-safe first, stop on a diverged/failed branch (unless force). */
	async landFeature(id: string, force = false, actor: Actor = LOCAL_ACTOR, reason?: string): Promise<{ ok: boolean; stopped?: string; results: { agentId?: string; branch?: string; ok: boolean; detail?: string }[] }> {
		const pf = this.featureStore.get(id);
		if (!pf) return { ok: false, stopped: "no such feature", results: [] };
		if (force && !reason?.trim()) return { ok: false, stopped: "force land requires a reason", results: [] };
		this.snapshotBranches(id);
		const members: LandMember[] = [...this.agents.values()].filter((r) => r.dto.featureId === id).map((r) => ({ agentId: r.dto.id, agentName: r.dto.name, branch: r.dto.branch, worktree: r.dto.worktree, repo: pf.repo }));
		for (const b of pf.branches ?? []) if (!members.some((m) => m.agentId === b.agentId)) members.push({ agentId: b.agentId, branch: b.branch, worktree: b.worktree, repo: pf.repo });
		const wts = await featureLandStatus(members);
		if (!force && wts.some((w) => w.readiness === "diverged")) return { ok: false, stopped: "a branch is diverged — resolve it (or force)", results: [] };
		if (!force) {
			for (const m of members) {
				const reason = await proofGate(pf.repo, m.worktree, m.branch, pf.acceptance ?? undefined);
				if (reason) return { ok: false, stopped: `${m.agentName ?? m.branch ?? "member"}: ${reason}`, results: [] };
			}
		}
		if (force) {
			void this.recordAudit(actor, "land", id, "ok", `force land: ${reason}`);
			void this.store.appendAudit({ actor: actor.id, action: "land.force", target: id, detail: { reason } }).catch(() => {});
		}
		const results: { agentId?: string; branch?: string; ok: boolean; detail?: string }[] = [];
		for (const w of landOrder(wts)) {
			const rec = w.agentId ? this.agents.get(w.agentId) : undefined;
			const busy = rec ? rec.dto.status === "working" || rec.dto.status === "starting" || rec.dto.status === "input" : false;
			const res = await landAgent({ repo: pf.repo, worktree: w.worktree, branch: w.branch, message: `feature(${pf.title}): land ${w.branch ?? "changes"}`, commitWip: !busy, requireProof: !force, verify: pf.acceptance ?? undefined });
			results.push({ agentId: w.agentId, branch: w.branch, ok: res.ok, detail: res.detail });
			if (!res.ok) { this.emitFeaturesChanged(); void this.recordAudit(LOCAL_ACTOR, "land", id, "error", `feature land failed on ${w.branch}`); void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land", target: id, detail: { outcome: "error", branch: w.branch } }).catch(() => {}); return { ok: false, stopped: `land failed on ${w.branch}`, results }; }
			if (res.merged) void this.closeLandedIssue(rec?.dto.issue); // real merge ⇒ close its tracking issue (idempotent)
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
	async land(id: string, message?: string, opts: { auto?: boolean; force?: boolean; actor?: Actor; reason?: string } = {}): Promise<LandResult> {
		const rec = this.agents.get(id);
		if (!rec) return { ok: false, committed: false, merged: false, message: "no such agent", detail: "no such agent" };
		const dto = rec.dto;
		const auto = opts.auto ?? true;
		await this.refreshProofState(rec);
		if (opts.force && !opts.reason?.trim()) return { ok: false, committed: false, merged: false, message: "force land blocked", detail: "force land requires a reason" };
		// Restart-safe auto-land cap: check before proofGate so a branch already over the cap parks
		// without re-running any landing preconditions. Operator lands (auto:false) bypass this.
		if (auto && dto.branch) {
			const fails = landFailureCount(this.stateDir, dto.branch);
			if (fails >= autoLandFailCap()) {
				this.log("warn", `auto-land parked for ${dto.branch} — ${fails} consecutive failed lands; awaiting a fix (the observer files a bug issue)`);
				return { ok: false, committed: false, merged: false, message: "auto-land parked", detail: `auto-land parked: ${fails} consecutive failed lands on ${dto.branch} — not re-merging until the branch is fixed` };
			}
		}
		if (!opts.force) {
			const reason = await proofGate(dto.repo, dto.worktree, dto.branch);
			if (reason) return { ok: false, committed: false, merged: false, message: "land blocked", detail: reason };
		} else {
			const actor = opts.actor ?? LOCAL_ACTOR;
			void this.recordAudit(actor, "land", id, "ok", `force land: ${opts.reason}`);
			void this.store.appendAudit({ actor: actor.id, action: "land.force", target: id, detail: { reason: opts.reason } }).catch(() => {});
		}
		const busy = dto.status === "working" || dto.status === "starting" || dto.status === "input";
		const result = await this.landBranch({
			repo: dto.repo,
			worktree: dto.worktree,
			branch: dto.branch,
			message: message ?? `squad(${dto.name}): land ${dto.branch ?? "changes"}`,
			commitWip: !busy,
			confirmResolved: auto && autoresolveConfirm(), // OMPSQ-138: an AUTO resolved-conflict land stages, not merges
			requireProof: !opts.force,
		});
		// Staged (OMPSQ-138): the conflict was auto-resolved but held for a one-tap Land. Not a failure
		// (never bump the fail streak) and not landed — surface the ready-to-land flag and return.
		if (result.staged) {
			rec.dto.landReady = true;
			this.emitAgent(rec);
			this.log("info", `land-confirm: ${id} auto-resolved a conflict — ready to land`);
			return result;
		}
		// Update the branch's failure streak: an auto-land failure bumps it (drives the cap above), any
		// success clears it. A manual (auto:false) failure is the operator's call — never penalized.
		// A retryable refusal (dirty main checkout) is an environmental precondition, not a branch failure —
		// never bump the streak for it, else transient dirty windows park a healthy branch.
		if (!result.retryable && (auto || result.ok)) recordLandOutcome(this.stateDir, dto.branch, result.ok, result.detail ?? result.message);
		if (result.ok) {
			rec.dto.landReady = false; // successful land attempt ⇒ clear the confirm-mode staged flag
			this.emitAgent(rec);
			if (result.merged) await this.closeLandedIssue(dto.issue); // real merge ⇒ close its tracking issue (idempotent, best-effort)
			else this.log("info", `not closing ${dto.issue?.identifier ?? dto.issue?.id ?? id}: land made no merge`);
		}
		void this.recordAudit(LOCAL_ACTOR, "land", id, result.ok ? "ok" : "error", result.detail ?? result.message);
		void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land", target: id, detail: { outcome: result.ok ? "ok" : "error" } }).catch(() => {});
		return result;
	}

	private async autoLandWorkflow(rec: AgentRecord, outcome: string | undefined, proof?: { state?: string }): Promise<void> {
		if (!this.autoLand || this.landConfirm || outcome !== "succeeded") return;
		this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "workflow.land.start", target: rec.dto.id, detail: { proof: proof?.state ?? "unknown" } }).catch(() => {});
		const reason = await proofGate(rec.dto.repo, rec.dto.worktree, rec.dto.branch);
		if (reason) {
			this.log("warn", `workflow auto-land blocked on ${rec.dto.name}: ${reason}`);
			this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "workflow.land.end", target: rec.dto.id, detail: { outcome: "blocked", reason } }).catch(() => {});
			return;
		}
		const res = await autoLandOnSuccess(true, outcome, { id: rec.dto.id, name: rec.dto.name }, { land: (id) => this.land(id), log: (m) => this.log("info", m) });
		this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "workflow.land.end", target: rec.dto.id, detail: { outcome: res?.ok ? "ok" : "error", detail: res?.detail ?? res?.message } }).catch(() => {});
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

	/**
	 * Catastrophe (#14 / OMPSQ-135): the orchestrator summoned a human for this agent (repair budget
	 * exhausted or a catastrophe tripwire). The auto-loop has already halted it; here we make the
	 * summon *visible* — drive the agent into a sticky `error` state so it surfaces in the attention
	 * Queue and fires the existing background push (escalationPayload handles the idle→error
	 * transition). Without this the summon was a log line only — invisible once the operator looked
	 * away. The `CATASTROPHE:` prefix distinguishes a summon from a plain agent crash in the UI.
	 */
	private markCatastrophe(id: string, detail: string): void {
		const rec = this.agents.get(id);
		if (!rec) return;
		rec.streaming = false;
		rec.dto.status = "error";
		rec.dto.error = `CATASTROPHE: ${detail}`;
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
		this.log("warn", `catastrophe: ${id} — ${detail}`);
		void this.recordAudit(LOCAL_ACTOR, "catastrophe", id, "error", truncate(detail, 120));
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
			profileId: opts.profileId,
			approvalMode: opts.approvalMode ?? "write",
			autonomyMode: opts.autonomyMode ?? modeFromApproval(opts.approvalMode ?? "write"),
			effectiveMode: "observe",
			verificationState: "unknown",
			availableActions: ["set-mode"],
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
			issue: opts.issue,
			featureId: opts.featureId,
			owns: opts.owns,
			requires: opts.requires,
			produces: opts.produces ?? opts.owns,
			scopeSource: opts.scopeSource,
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

	/** Count of uncommitted TRACKED files in a checkout — the land-blocking set (matches the land path's
	 *  `--untracked-files=no` precondition). 0 ⇒ clean ⇒ a land is never refused for dirtiness. */
	private trackedDirtyCount(repo: string): number {
		const r = hardenedGitSync(["-C", repo, "status", "--porcelain", "--untracked-files=no"]);
		return r.code === 0 ? r.stdout.split("\n").filter((l) => l.trim().length > 0).length : 0;
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
	 * Repo-relative files this agent ACTUALLY changed vs the main checkout's HEAD — the ground
	 * truth for the produces audit. Sourced from git (committed branch diff, three-dot), NOT the
	 * receipt's tool-frame filesTouched (which both under- and over-states the real change set).
	 */
	private changedFilesVsBase(a: AgentDTO): string[] {
		if (!a.branch) return [];
		const r = hardenedGitSync(["-C", a.repo, "diff", "--name-only", `HEAD...${a.branch}`]);
		return r.code === 0 ? r.stdout.split("\n").filter((f) => f.length > 0) : [];
	}

	/**
	 * Route a scope-contract finding through the automation observability channel (the "scope" loop):
	 * a warn-level event that persists, surfaces in /api/automation + the automation panel, and is
	 * advisory ONLY — it never blocks a spawn or a land. Best-effort; never throws.
	 */
	private fileScopeFinding(severity: "low" | "high", repo: string, message: string): void {
		try {
			this.log("warn", `scope finding (${severity}): ${message}`);
			this.automation.for("scope", repo)({ durationMs: 0, level: "warn", detail: message });
		} catch {
			/* observability must never break the spawn/finalize path */
		}
	}
	async verifyAgentWork(id: string, actor: Actor = AUTO_ACTOR): Promise<boolean> {
		const rec = this.agents.get(id);
		if (!rec) return false;
		this.syncAuthority(rec.dto);
		if (rec.dto.effectiveMode === "observe") throw new Error("verify blocked in observe mode");
		const command = await detectVerify(rec.dto.repo);
		if (!command) return false;
		const proof = await runProof({ repo: rec.dto.repo, worktree: rec.dto.worktree, command });
		await this.refreshProofState(rec);
		this.emitAgent(rec);
		void this.recordAudit(actor, "verify", id, proof.ok ? "ok" : "error", proof.detail);
		return proof.ok;
	}

	async transitionMode(id: string, mode: AutonomyMode, actor: Actor = LOCAL_ACTOR, reason?: string): Promise<AgentDTO | undefined> {
		const rec = this.agents.get(id);
		if (!rec) return undefined;
		const oldMode = rec.dto.autonomyMode;
		rec.dto.autonomyMode = mode;
		rec.options.autonomyMode = mode;
		this.syncAuthority(rec.dto);
		this.emitAgent(rec);
		await this.persist();
		void this.recordAudit(actor, "set-mode", id, "ok", `${oldMode} → ${mode}; effective ${rec.dto.effectiveMode}${reason ? `; ${reason}` : ""}`);
		await this.store.appendAudit({ actor: actor.id, action: "set-mode", target: id, detail: { oldMode, requestedMode: mode, effectiveMode: rec.dto.effectiveMode, reason } }).catch(() => {});
		return rec.dto;
	}
	/**
	 * Run the acceptance gate (the repo's own verify command, via detectVerify) on main → {ok, firstFailure?}.
	 * Total by contract: any spawn failure yields ok:false, never a throw (the observer tick must not crash).
	 * No detectable verify command ⇒ ok:true (nothing to regress against; don't file a false regression).
	 * Serialized against lands via withRepoLandLock: the gate reads the same main tree a land mutates
	 * (merge / reset --hard), so running it concurrently makes it `(fail)` against a half-merged main and
	 * file a false `regression:` bug (OMPSQ-168). The lock makes the gate and lands mutually exclusive.
	 * Change-driven: cache by live working-tree fingerprint (git status + bun.lock), force-run every
	 * 10th tick, and fail open to running the real gate if the fingerprint cannot be sampled.
	 */
	protected runMainGate(repo: string): Promise<{ ok: boolean; firstFailure?: string; skipped?: boolean }> {
		return withRepoLandLock(repo, async () => {
			try {
				const fp = await this.mainGateFingerprint(repo);
				const cached = fp ? this.mainGateCache.get(repo) : undefined;
				const tick = (cached?.tick ?? 0) + 1;
				if (fp && cached?.fp === fp && tick % 10 !== 0) {
					this.mainGateCache.set(repo, { ...cached, tick });
					return { ...cached.result, skipped: true };
				}

				const result = await this.runMainGateUncached(repo);
				if (fp) this.mainGateCache.set(repo, { fp, result, tick });
				return result;
			} catch (e) {
				return { ok: false, firstFailure: e instanceof Error ? e.message : String(e) };
			}
		});
	}

	private async mainGateFingerprint(repo: string): Promise<string | undefined> {
		const status = await hardenedGit(["status", "--porcelain", "--untracked-files=all"], { cwd: repo });
		if (status.code !== 0) return undefined;
		let lock = "";
		try {
			lock = await fs.readFile(path.join(repo, "bun.lock"), "utf8");
		} catch (e) {
			if ((e as { code?: string }).code !== "ENOENT") return undefined;
		}
		return createHash("sha256").update(status.stdout).update("\0").update(lock).digest("hex");
	}

	private async runMainGateUncached(repo: string): Promise<{ ok: boolean; firstFailure?: string }> {
		try {
			const command = await detectVerify(repo);
			if (!command) return { ok: true };
			// gateExec: scrubbed env always; whole run inside a container when OMP_SQUAD_GATE_SANDBOX is set.
			const plan = gateExec(command, repo);
			const proc = Bun.spawn(plan.argv, { cwd: repo, stdout: "pipe", stderr: "pipe", env: plan.env });
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
	}


	private emitFeaturesChanged(): void {
		void this.persist();
		this.emit("event", { type: "features-changed" } satisfies SquadEvent);
	}

	// ── Roster mutation ───────────────────────────────────────────────────────

	async create(opts: CreateAgentOptions, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		const profile = this.profileFor(opts.profileId);
		// A profile's capability tool-grants (AgentProfile.capabilities, populated by bindingToProfile) scope
		// what tools the spawned agent may use. They were parsed but NEVER applied — every agent got full tool
		// access regardless. We now (a) inject the allow-list into the agent's system prompt (the path that
		// actually reaches the omp child via --append-system-prompt) and (b) record it on the AgentRecord so
		// host tool calls outside the list are hard-denied at the onHostTool seam (see toolGrants below).
		// FLAG: hard enforcement of omp's *core* tools (read/edit/bash) requires an upstream
		// `omp --allowed-tools` flag the RpcAgent/agent-host cannot pass today; the prompt constraint + host
		// tool gate are the strongest enforcement reachable without that upstream change.
		const toolGrants = profile?.capabilities?.length ? [...new Set(profile.capabilities)] : undefined;
		if (profile) {
			opts = {
				...opts,
				profileId: profile.id,
				model: opts.model ?? profile.model,
				approvalMode: opts.approvalMode ?? profile.approvalMode,
				appendSystemPrompt: [profile.memory, toolGrantsPrompt(toolGrants), opts.appendSystemPrompt].filter((text): text is string => typeof text === "string" && text.length > 0).join("\n\n") || undefined,
			};
		}
		// Cold-start KB primer (OMPSQ #8): a fresh agent on a feature inherits the most relevant prior
		// decisions / hot files / peer context with ZERO turn cost, drawn from the context fabric and
		// fenced as untrusted (same discipline as the resume digest). Best-effort — never blocks a spawn.
		if (opts.featureId && (opts.task || opts.name)) {
			try {
				const snapshot = await this.fabric(actor, { repos: [opts.repo], includeLeases: true });
				const primer = buildContextPrimer(snapshot, [opts.task, opts.name].filter(Boolean).join(" "));
				if (primer) {
					opts = {
						...opts,
						appendSystemPrompt: [opts.appendSystemPrompt, fenceUntrusted("context primer", primer)].filter((text): text is string => typeof text === "string" && text.length > 0).join("\n\n") || undefined,
					};
				}
			} catch (err) {
				this.log("warn", `context primer failed: ${String(err)}`);
			}
		}
		const produces = opts.produces ?? opts.owns;
		if (opts.requires?.length) {
			const conflict = requiresConflict([...this.agents.values()].map((r) => r.dto), opts.repo, opts.requires);
			if (conflict) {
				// Operator-declared scope → hard block (the enforced path). LLM-inferred → advisory only:
				// never refuse a spawn on a hallucinated read-dependency; surface it as a low-sev finding.
				if (opts.scopeSource === "operator") {
					throw new Error(`scope requires conflict: ${conflict.paths.join(", ")} produced by agent "${conflict.agent}" — wait for that output or narrow the dependency`);
				}
				this.fileScopeFinding("low", opts.repo, `inferred requires of "${opts.name ?? "agent"}" overlaps live agent ${conflict.agent}: ${conflict.paths.join(", ")}`);
			}
		}
		if (produces?.length) {
			const conflict = ownershipConflict([...this.agents.values()].map((r) => r.dto), opts.repo, produces);
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
		const profileId = opts.profileId;
		const approvalMode = opts.approvalMode ?? "write";
		const requestedMode = opts.autonomyMode ?? modeFromApproval(approvalMode);
		const effectiveAtCreate = effectiveAutonomyMode({ requested: requestedMode, approvalMode, autoLand: this.autoLand, landConfirm: this.landConfirm });
		if (opts.task && effectiveAtCreate === "observe") throw new Error("create with task is blocked in observe mode");
		const thinking = opts.thinking ?? "low";
		const kind = opts.flue ? "flue-service" : opts.workflow || opts.verify ? "workflow" : "omp-operator";

		let cwd: string;
		let resolvedBranch: string | undefined;
		let repo: string;
		let createdWorktree = false;
		if (opts.existingPath) {
			cwd = opts.existingPath;
			repo = opts.repo;
			resolvedBranch = (await worktreeStatus(cwd).catch(() => ({ branch: undefined }))).branch;
		} else {
			const wt = await resolveWorktree(opts.repo, branch, addWorktree, isGitRepo, this.worktreeBaseDir);
			cwd = wt.cwd;
			repo = wt.repo;
			resolvedBranch = wt.inPlace ? undefined : wt.branch;
			createdWorktree = !wt.inPlace;
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
			profileId,
			approvalMode,
			autonomyMode: requestedMode,
			task: opts.task,
			thinking,
			appendSystemPrompt: opts.appendSystemPrompt,
			issue: opts.issue,
			kind,
			runtime: opts.runtime,
			flue: opts.flue,
			workflow: opts.workflow ? { path: opts.workflow } : opts.verify ? { verify: { command: opts.verify } } : undefined,
			// Carry the resumable checkpoint so an adopted/restored workflow continues its graph from the
			// last node boundary instead of re-running completed stages (and duplicating their commits).
			workflowState: opts.workflowState,
			sandbox: opts.sandbox,
			parentId: opts.parentId,
			featureId: opts.featureId,
			owns: opts.owns,
			requires: opts.requires,
			produces,
			scopeSource: opts.scopeSource,
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
			profileId,
			approvalMode,
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
			issue: opts.issue,
			kind,
			parentId: opts.parentId,
			featureId: opts.featureId,
			owns: opts.owns,
			requires: opts.requires,
			produces,
			scopeSource: opts.scopeSource,
			workflow: persisted.workflow,
			workflowState: persisted.workflowState,
			adopted: opts.adopted,
		};
		this.seedAuthority(dto, requestedMode);

		const agent = this.makeDriver(persisted, opts.cold);
		const rec: AgentRecord = { dto, agent, options: persisted, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map(), toolGrants };
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
			if (!started) {
				await agent.stop().catch(() => {});
				// The worktree was created before start() failed; nothing else reaps it, so a failed start
				// leaks it forever (the gate's own failed-start test orphaned 500+ "squad-leaky" worktrees).
				if (createdWorktree) await removeWorktree(repo, cwd).catch(() => {});
			}
			this.fail(rec, err);
		}

		await this.persist();
		const failed = rec.dto.status === "error";
		void this.recordAudit(actor, "create", rec.dto.id, failed ? "error" : "ok", failed ? rec.dto.error : truncate(opts.task ?? rec.dto.name, 80));
		return rec.dto;
	}

	private makeDriver(p: PersistedAgent, cold = false): AgentDriver {
		if (p.kind === "flue-service" && p.flue) {
			return new FlueServiceDriver({ dir: p.flue.dir, workflow: p.flue.workflow, target: p.flue.target });
		}
		if (p.kind === "workflow" && p.workflow) {
			const workflow = p.workflow.verify ? buildVerifyWorkflow(p.workflow.verify) : undefined;
			const fleet: WorkflowFleet = { runBranch: (spec) => this.spawnFleetBranch(p.repo, p.id, spec) };
			// Feed-forward: a workflow tied to a feature folds that feature's unresolved plan-review
			// comments into the first agent node after the approve gate (Revise → re-plan, Approve → file/implement).
			const fid = p.featureId;
			const decoratePrompt = fid
				? async (): Promise<string | undefined> => {
						const cs = await this.getUnresolvedComments(p.repo, fid);
						return cs.length ? `--- Reviewer comments to address (from the plan review) ---\n${cs.map((c) => `- ${c.body}`).join("\n")}` : undefined;
					}
				: undefined;
			return new WorkflowDriver({ id: p.id, workflow, workflowPath: p.workflow.path ? resolveWorkflowPath(p.workflow.path) : undefined, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, bin: this.bin, fleet, resumeState: p.workflowState, decoratePrompt, cold });
		}
		if (p.sandbox) {
			return new SandboxAgentDriver({ id: p.id, image: p.sandbox.image, workdir: p.sandbox.workdir, mount: p.sandbox.mountWorktree === false ? undefined : p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, runArgs: p.sandbox.runArgs });
		}
		if (p.runtime === "acp") {
			return new AcpAgentDriver({ id: p.id, cwd: p.worktree, model: p.model });
		}
		return new RpcAgent({ id: p.id, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, appendSystemPrompt: p.appendSystemPrompt, bin: this.bin });
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
		// WIP cap for fan-out (#18): a workflow with a high max_parallel previously blew past the configured
		// WIP cap because every branch spawned with bypassCap:true — only the hard ceiling stopped it. Respect
		// the same admission decision interactive spawns use (scheduler.canAdmit on occupying agents) so fan-out
		// is bounded by the configured cap too, with the hard ceiling above as the backstop. When the cap is
		// reached we refuse this branch gracefully (a failed NodeResult the engine folds into its merge) rather
		// than overrunning the cap. We still pass bypassCap:true to create() because the admission decision is
		// made HERE — create's own cap check would otherwise double-gate and could throw.
		const occupying = occupyingAgents(this.list());
		if (!this.scheduler.canAdmit(occupying)) {
			const reason = this.scheduler.pressured() ? "host under resource pressure" : `WIP cap reached (${occupying}/${this.scheduler.cap()})`;
			return { outcome: "failed", text: `${reason} — branch "${spec.name}" not spawned` };
		}
		const dto = await this.create({ repo, name: spec.name, model: spec.model, approvalMode: spec.approvalMode, parentId, autoRoute: false, bypassCap: true });
		const rec = this.agents.get(dto.id);
		if (!rec) return { outcome: "failed", text: "branch agent not created" };
		return this.runAgentTask(rec, spec.task, spec.signal);
	}

	/** Prompt an agent and resolve once its turn ends, collecting the assistant text.
	 * If `signal` aborts (parallel join short-circuited or a sibling threw), tear the agent down — stop()
	 * its backing process and mark it stopped — so a won/failed fan-out leaves no live detached branch. */
	private runAgentTask(rec: AgentRecord, task: string, signal?: AbortSignal): Promise<NodeResult> {
		const { promise, resolve } = Promise.withResolvers<NodeResult>();
		let buf = "";
		const onEvent = (frame: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } }) => {
			if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") buf += frame.assistantMessageEvent.delta ?? "";
			else if (frame.type === "agent_end") finish("succeeded");
		};
		const onExit = () => finish("failed");
		const onAbort = () => {
			void rec.agent.stop().catch(() => {});
			rec.dto.status = "stopped";
			this.emitAgent(rec);
			finish("failed");
		};
		const timer = setTimeout(() => finish("failed"), 30 * 60_000);
		const finish = (outcome: "succeeded" | "failed"): void => {
			clearTimeout(timer);
			rec.agent.off("event", onEvent);
			rec.agent.off("exit", onExit);
			signal?.removeEventListener("abort", onAbort);
			resolve({ outcome, text: buf.trim() });
		};
		if (signal?.aborted) {
			onAbort();
			return promise;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
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
		this.seedAuthority(dto, "autodrive");
		const rec: AgentRecord = { dto, agent: this.makeDriver(persisted), options: persisted, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
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
			profileId: p.profileId,
			pending: [],
			lastActivity: Date.now(),
			messageCount: 0,
		};
		const rec: AgentRecord = { dto, agent: this.makeDriver(p), options: p, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
		this.agents.set(p.id, rec);
		this.wire(rec);
		await rec.agent.start();
		this.emitAgent(rec);
	}

	private async ensureConnected(rec: AgentRecord): Promise<void> {
		if (rec.agent.isAlive && rec.agent.isReady) return;
		rec.dto.error = undefined;
		rec.dto.status = "starting";
		this.emitAgent(rec);
		await rec.agent.start();
		if (rec.agent.setSessionName) await rec.agent.setSessionName(`squad:${rec.dto.name}`).catch(() => {});
		rec.dto.status = "idle";
		this.emitAgent(rec);
	}

	private async promptConnected(rec: AgentRecord, message: string): Promise<void> {
		await this.ensureConnected(rec);
		try {
			await rec.agent.prompt(message);
		} catch (err) {
			if (!isAgentDisconnected(err)) throw err;
			await this.ensureConnected(rec);
			await rec.agent.prompt(message);
		}
	}

	async applyCommand(cmd: ClientCommand, actor: Actor = LOCAL_ACTOR): Promise<void> {
		// Agent-origin actors are not in the viewer/operator/admin ladder. They get exactly one
		// capability: bounded advisory messages to their C1 scope.
		if (actor.origin === "agent") {
			const target = commandTarget(cmd);
			if (cmd.type !== "message" || !scopeFor(actor, this.list()).has(cmd.to)) {
				this.log("warn", `agent-scope: ${actor.id} denied "${cmd.type}"${target ? ` → ${target}` : ""}`);
				void this.store.appendAudit({ actor: actor.id, action: `denied:${cmd.type}`, target, detail: { need: "agent:message", have: "agent" } }).catch(() => {});
				void this.recordAudit(actor, `denied:${cmd.type}`, target ?? null, "error", "agent message-only allowlist");
				throw new RbacDenied("operator", "viewer", cmd.type);
			}
			await this.store.appendAudit({ actor: actor.id, action: cmd.type, target: cmd.to }).catch((err) => this.log("warn", `audit write failed for \"${cmd.type}\": ${err instanceof Error ? err.message : String(err)}`));
			await this.deliverPeerMessage(actor, cmd.to, cmd.text);
			return;
		}

		// RBAC chokepoint: every surface (TUI, web, REST, future federation peers) routes through
		// here, so the tier check lives here too — nothing can mutate state below its granted tier.
		const need = commandRole(cmd);
		const have = effectiveRole(actor);
		if (!roleAtLeast(have, need)) {
			this.log("warn", `rbac: ${actor.id} (${have}) denied "${cmd.type}" — needs ${need}`);
			void this.store
				.appendAudit({ actor: actor.id, action: `denied:${cmd.type}`, target: commandTarget(cmd), detail: { need, have } })
				.catch(() => {});
			throw new RbacDenied(need, have, cmd.type);
		}
		// Security trail: record every accepted mutation (reads — snapshot/subscribe — are need=viewer
		// and not audited). DB mode persists to the per-org `audit` table; FileStore is a no-op.
		if (need !== "viewer") {
			await this.store
				.appendAudit({ actor: actor.id, action: cmd.type, target: commandTarget(cmd) })
				.catch((err) => this.log("warn", `audit write failed for \"${cmd.type}\": ${err instanceof Error ? err.message : String(err)}`));
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
		if (cmd.type === "message") {
			await this.deliverPeerMessage(actor, cmd.to, cmd.text);
			return;
		}
		if (cmd.type === "set-mode") {
			await this.transitionMode(cmd.id, cmd.mode, actor, cmd.reason);
			return;
		}

		const rec = this.agents.get(cmd.id);
		if (!rec) return;

		switch (cmd.type) {
			case "prompt": {
				await this.ensureConnected(rec);
				this.log("info", `${actor.id} → ${rec.dto.name}: ${truncate(cmd.message, 80)}`);
				this.append(rec, "user", cmd.message, { clientTurnId: cmd.clientTurnId });
				rec.streaming = true;
				rec.dto.status = "working";
				this.emitAgent(rec);
				await this.promptConnected(rec, cmd.message).catch((err) => this.fail(rec, err));
				void this.recordAudit(actor, "prompt", cmd.id, "ok", truncate(cmd.message, 80));
				break;
			}
			case "set-model": {
				const model = cmd.model.trim();
				if (!model || !rec.agent.setModel) break;
				try {
					await this.ensureConnected(rec);
					await rec.agent.setModel(model);
					rec.dto.model = model;
					this.append(rec, "system", `model set to ${model}`);
					this.emitAgent(rec);
					void this.recordAudit(actor, "set-model", cmd.id, "ok", model);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					this.append(rec, "system", `model change failed: ${detail}`);
					void this.recordAudit(actor, "set-model", cmd.id, "error", detail);
				}
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

	private async deliverPeerMessage(actor: Actor, to: string, text: string): Promise<void> {
		const target = this.agents.get(to);
		const trimmed = text.trim();
		if (!target || target.dto.status === "stopped") {
			void this.recordAudit(actor, "message", to, "error", "target unavailable");
			throw new Error(`message target unavailable: ${to}`);
		}
		if (!trimmed) {
			void this.recordAudit(actor, "message", to, "error", "empty message");
			throw new Error("message text required");
		}
		if (trimmed.length > PEER_MESSAGE_MAX_CHARS) {
			void this.recordAudit(actor, "message", to, "error", "message too large");
			throw new Error(`message too large (max ${PEER_MESSAGE_MAX_CHARS} chars)`);
		}
		if (actor.origin === "agent") {
			const budget = peerMessageBudget();
			const used = this.peerMessageBudget.get(actor.id) ?? 0;
			if (used >= budget) {
				void this.recordAudit(actor, "message", to, "error", `budget ${budget} spent`);
				throw new Error(`peer message budget spent (${budget})`);
			}
			this.peerMessageBudget.set(actor.id, used + 1);
		}
		// ponytail: advisory append only, no queue and no auto-wake. Ceiling: an idle/stopped target may
		// never act on it; durable/reliable push needs an outbox, which is intentionally out of scope.
		this.append(target, "system", `Advisory peer message:\n${fenceUntrusted(`peer message from ${actor.id}`, redact(trimmed))}`);
		this.emitAgent(target);
		void this.recordAudit(actor, "message", to, "ok", truncate(trimmed, 80));
	}

	private answerPending(rec: AgentRecord, req: PendingRequest, value: string, actor: Actor): void {
		if (req.source === "ui") {
			if (req.kind === "confirm") rec.agent.respondUi(req.id, { confirmed: value === "yes" || value === "true" });
			else rec.agent.respondUi(req.id, { value });
		} else {
			rec.agent.respondHostTool(req.id, value);
		}
		rec.dto.pending = rec.dto.pending.filter((p) => p.id !== req.id);
		this.append(rec, "system", `${actor.id} answered "${req.title}": ${truncate(value, 60)}`, { pending: { requestId: req.id, action: "answered" }, status: "ok" });
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
		if (this.scoutCursor.delete(id)) writeScoutCursors(this.stateDir, this.scoutCursor);
		this.emit("event", { type: "removed", id } satisfies SquadEvent);
		await this.persist();
	}

	// ── Event wiring ──────────────────────────────────────────────────────────

	private wire(rec: AgentRecord): void {
		const a = rec.agent;
		a.removeAllListeners();
		a.on("event", (frame: { type?: string; [k: string]: unknown }) => this.onAgentEvent(rec, frame));
		a.on("ready", () => {
			this.refreshCommands(rec);
			this.registerHostTools(rec);
		});
		a.on("ui", (req: RpcExtensionUIRequest) => this.onUi(rec, req));
		a.on("hosttool", (call: { id: string; toolName: string; arguments: unknown }) => this.onHostTool(rec, call));
		a.on("stderr", (line: string) => this.log("warn", `[${rec.dto.name}] ${line}`));
		a.on("checkpoint", (state: WorkflowRunState) => {
			rec.options.workflowState = state;
			rec.dto.workflowState = state;
			this.emitAgent(rec);
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
			rec.run?.onSubagentFrame(frame as { type: string; payload?: unknown });
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
				rec.assistantEntry = undefined;
				rec.thinkingEntry = undefined;
				rec.thinkingBuf = "";
				rec.dto.adopted = false; // OMPSQ-164: it ran ⇒ no longer a never-re-run adopted agent; resume normal verify→land
				if (!rec.run) {
					rec.run = new RunAccumulator({
						agentId: rec.dto.id,
						name: rec.dto.name,
						repo: rec.dto.repo,
						branch: rec.dto.branch,
						model: rec.dto.model,
						featureId: rec.dto.featureId,
						parentId: rec.dto.parentId,
						issue: rec.dto.issue?.identifier ?? rec.dto.issue?.name,
						operator: this.operator.id,
						org: this.operator.orgId,
					});
				}
				rec.run.start(rec.dto.model);
				break;
			case "message_update": {
				const ev = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (ev?.type === "text_delta" && typeof ev.delta === "string") this.updateAssistantStream(rec, ev.delta);
				else if (ev?.type === "thinking_delta" && typeof ev.delta === "string") this.updateThinkingStream(rec, ev.delta);
				break;
			}
			case "thinking_delta": {
				if (typeof frame.delta === "string") this.updateThinkingStream(rec, frame.delta);
				break;
			}
			case "message_end": {
				const msg = frame.message as
					| { role?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } } }
					| undefined;
				if (msg?.role === "assistant" && msg.usage) rec.run?.onAssistantUsage(msg.usage);
				rec.run?.onMessageEnd();
				this.finishThinkingStream(rec);
				this.finishAssistantStream(rec);
				break;
			}
			case "tool_execution_start": {
				const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
				const intent = typeof frame.intent === "string" ? frame.intent : "";
				rec.run?.onTool(toolName, intent);
				this.upsertToolEntry(rec, frame, "running");
				break;
			}
			case "tool_execution_update": {
				this.upsertToolEntry(rec, frame, "running");
				break;
			}
			case "tool_execution_end": {
				this.upsertToolEntry(rec, frame, frame.isError ? "error" : "ok");
				break;
			}
			case "agent_end": {
				this.finishThinkingStream(rec);
				this.finishAssistantStream(rec);
				rec.streaming = false;
				rec.dto.activity = undefined;
				void this.finalizeRun(rec);
				break;
			}
			case "workflow_done":
				// Workflow auto-land must satisfy the same fresh-proof invariant surfaced by Land all.
				// The final land still goes through land(), so merge verification/rollback and issue-close stay one seam.
				void this.autoLandWorkflow(rec, frame.outcome as string | undefined, frame.proof as { state?: string } | undefined);
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

	private updateThinkingStream(rec: AgentRecord, delta: string): void {
		rec.thinkingBuf += delta;
		if (!rec.thinkingBuf.trim()) return;
		if (!rec.thinkingEntry) {
			rec.thinkingEntry = this.append(rec, "thinking", rec.thinkingBuf, { status: "running" });
			return;
		}
		Object.assign(rec.thinkingEntry, { text: redact(rec.thinkingBuf), status: "running", ts: Date.now() });
		this.emit("event", { type: "transcript", id: rec.dto.id, entry: rec.thinkingEntry } satisfies SquadEvent);
	}

	private finishThinkingStream(rec: AgentRecord): void {
		if (!rec.thinkingBuf.trim()) return;
		if (!rec.thinkingEntry) {
			this.append(rec, "thinking", rec.thinkingBuf.trim(), { status: "ok" });
		} else {
			Object.assign(rec.thinkingEntry, { text: redact(rec.thinkingBuf.trim()), status: "ok", ts: Date.now() });
			this.emit("event", { type: "transcript", id: rec.dto.id, entry: rec.thinkingEntry } satisfies SquadEvent);
		}
		rec.thinkingBuf = "";
		rec.thinkingEntry = undefined;
	}

	private updateAssistantStream(rec: AgentRecord, delta: string): void {
		rec.assistantBuf += delta;
		if (!rec.assistantBuf.trim()) return;
		if (!rec.assistantEntry) {
			rec.assistantEntry = this.append(rec, "assistant", rec.assistantBuf, { status: "running" });
			return;
		}
		Object.assign(rec.assistantEntry, { text: redact(rec.assistantBuf), status: "running", ts: Date.now() });
		this.emit("event", { type: "transcript", id: rec.dto.id, entry: rec.assistantEntry } satisfies SquadEvent);
	}

	private finishAssistantStream(rec: AgentRecord): void {
		if (!rec.assistantBuf.trim()) return;
		if (!rec.assistantEntry) {
			this.append(rec, "assistant", rec.assistantBuf.trim(), { status: "ok" });
		} else {
			Object.assign(rec.assistantEntry, { text: redact(rec.assistantBuf.trim()), status: "ok", ts: Date.now() });
			this.emit("event", { type: "transcript", id: rec.dto.id, entry: rec.assistantEntry } satisfies SquadEvent);
		}
		rec.assistantBuf = "";
		rec.assistantEntry = undefined;
	}

	private upsertToolEntry(rec: AgentRecord, frame: { [k: string]: unknown }, status: "running" | "ok" | "error"): void {
		const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
		const callId = typeof frame.toolCallId === "string" ? frame.toolCallId : `${toolName}:${Date.now()}`;
		const intent = typeof frame.intent === "string" ? frame.intent : "";
		const existing = rec.toolEntries.get(callId);
		if (!existing) rec.run?.onTool(toolName);
		rec.dto.activity = intent ? `${toolName}: ${truncate(intent, 60)}` : toolName;
		const tool = {
			...(existing?.tool ?? { callId, name: toolName }),
			callId,
			name: toolName,
			args: frame.args ?? existing?.tool?.args,
			argsText: safeJson(frame.args ?? existing?.tool?.args),
			partial: frame.partialResult ?? existing?.tool?.partial,
			partialText: safeJson(frame.partialResult ?? existing?.tool?.partial),
			result: frame.result ?? existing?.tool?.result,
			resultText: safeJson(frame.result ?? existing?.tool?.result),
			isError: frame.isError === true,
			durationMs: existing ? Date.now() - existing.ts : undefined,
		};
		const text = intent ? `▸ ${toolName}: ${intent}` : `▸ ${toolName}`;
		if (!existing) {
			rec.toolEntries.set(callId, this.append(rec, "tool", text, { status, tool, format: toolName === "stage" ? "stage" : "command" }));
			return;
		}
		Object.assign(existing, { text: redact(text), status, tool });
		this.emit("event", { type: "transcript", id: rec.dto.id, entry: existing } satisfies SquadEvent);
		if (status !== "running") rec.toolEntries.delete(callId);
	}

	/**
	 * Close an agent/member's Plane issue once its branch successfully MERGES — the only close path now
	 * (no premature close-on-gate-pass, no close on no-op land). Gated by OMP_SQUAD_AUTOCLOSE
	 * (closeOnDone). Idempotent via `closedIssues` (a closed id is never re-closed) and best-effort
	 * (`closePlaneIssue` swallows transport errors). A failed close leaves the id unmarked so a later land retries it.
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
		const receipt = run.snapshot({ sampleRatio: traceSampleRatio(), maxSpans: traceMaxSpans() });
		await appendReceipt(this.stateDir, receipt); // full receipt on disk (both modes)
		if (receipt.spans?.length) this.traceExporter?.enqueue(receipt.spans, { service: "omp-squad", repo: receipt.repo, operator: this.operator.id, org: this.operator.orgId });
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
		const scout = this.scoutFor(rec.dto.repo);
		if (scout) {
			const reasoning = this.takeScoutReasoning(rec);
			if (reasoning)
				void scout
					.scan(reasoning, { agent: rec.dto.id, runId: receipt.runId, task: rec.options.task, issue: rec.dto.issue?.identifier ?? rec.dto.issue?.name })
					.catch((err) => this.log("warn", `scout scan failed for ${rec.dto.name}: ${err instanceof Error ? err.message : String(err)}`));
		}
		// Produces audit: did the agent write outside its declared scope? Ground truth is the git
		// branch diff (not the receipt). Advisory low-sev finding only — never blocks a land.
		this.auditProduces(rec);
		rec.dto.receipt = run.rollup();
		rec.run = undefined;
		this.emitAgent(rec);
	}

	/**
	 * Compare an agent's REAL changed files (git branch diff) against its declared `produces`
	 * (falling back to `owns`). Files outside the declared scope — minus a shared-file allowlist —
	 * raise one low-sev scope finding. No declared scope ⇒ nothing to audit. Best-effort.
	 */
	private auditProduces(rec: AgentRecord): void {
		const declared = rec.dto.produces ?? rec.dto.owns ?? [];
		if (!declared.length) return;
		try {
			const actual = this.changedFilesVsBase(rec.dto);
			if (!actual.length) return;
			const outOfScope = outOfScopeWrites(actual, declared, producesAllowlist(process.env.OMP_SQUAD_PRODUCES_ALLOW));
			if (outOfScope.length) {
				const shown = outOfScope.slice(0, 10).join(", ");
				this.fileScopeFinding("low", rec.dto.repo, `agent "${rec.dto.name}" wrote outside declared produces: ${shown}${outOfScope.length > 10 ? ` (+${outOfScope.length - 10} more)` : ""}`);
			}
		} catch {
			/* audit is advisory — a git edge must never break run completion */
		}
	}

	/**
	 * Reasoning (assistant+thinking) an agent has produced since its last scout scan; advances the
	 * per-agent cursor so each chunk is scanned at most once. Returns "" until ≥ MIN_SCAN_CHARS of new
	 * reasoning has accrued (the cursor stays put), so a slow trickle is never skipped past unscanned.
	 */
	private takeScoutReasoning(rec: AgentRecord): string {
		const { text, cursor } = unscannedReasoning(rec.transcript, this.scoutCursor.get(rec.dto.id) ?? 0);
		if (text) {
			this.scoutCursor.set(rec.dto.id, cursor);
			writeScoutCursors(this.stateDir, this.scoutCursor);
		}
		return text;
	}

	/** Pending ack waiters keyed by cmdId (resolved by the bus onAck listener; timed out by the caller). */
	private readonly ackWaiters = new Map<string, (ack: CommandAck) => void>();

	/**
	 * Steer a federation PEER's agent — the outbound half of the remote-command path.
	 * Only a local operator/admin may send (a viewer or remote actor is refused before the
	 * frame leaves this host); the RECEIVING manager still authorizes independently via its
	 * whois-verified actor + RBAC, so sending grants nothing. `to` is required: an
	 * unaddressed broadcast command would execute on every peer that ran it as viewer-plus.
	 * Returns the correlation id; pair with `waitForAck` for the peer's outcome.
	 */
	sendFederationCommand(to: string, cmd: ClientCommand, actor: Actor = LOCAL_ACTOR): string {
		if (!to.trim()) throw new Error("sendFederationCommand: target operator id required");
		if (!roleAtLeast(effectiveRole(actor), "operator")) throw new RbacDenied("operator", effectiveRole(actor), "federation command send");
		const cmdId = this.bus.sendCommand(cmd, to);
		void this.recordAudit(actor, "federation.command", to, "ok", `${cmd.type} → ${to}`);
		return cmdId;
	}

	/**
	 * Wait briefly for the peer's ack to a sent command. `null` after `timeoutMs` — the send
	 * is fire-and-forget underneath; an absent ack means "peer offline / older version", not failure.
	 */
	waitForAck(cmdId: string, timeoutMs = 4000): Promise<CommandAck | null> {
		if (!cmdId) return Promise.resolve(null);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.ackWaiters.delete(cmdId);
				resolve(null);
			}, timeoutMs);
			this.ackWaiters.set(cmdId, (ack) => {
				clearTimeout(timer);
				resolve(ack);
			});
		});
	}

	/** Durable receipt history for one agent (server reads this; keeps stateDir private). */
	async receipts(id: string): Promise<RunReceipt[]> {
		return readReceipts(this.stateDir, id);
	}

	async trace(id: string): Promise<TraceResponse> {
		const receipts = await readAllReceipts(this.stateDir);
		for (const rec of this.agents.values()) {
			if (rec.run && !rec.run.finalized) receipts.push(rec.run.snapshot({ includeSpans: traceSpansEnabled(), maxSpans: traceMaxSpans() }));
		}
		return buildTrace(id, receipts, await readAudit(this.stateDir, { limit: 0 }), this.featureStore.keys());
	}

	/** Scoped, read-only context fabric: DTO facts + digests + receipt hot areas + Scout + leases. */
	async fabric(actor: Actor = LOCAL_ACTOR, opts: { repos?: string[]; includeLeases?: boolean } = {}): Promise<FabricSnapshot> {
		return buildFabricSnapshot({
			actor,
			agents: this.list(),
			stateDir: this.stateDir,
			repos: opts.repos,
			includeLeases: opts.includeLeases,
			listIssues: (repo) => listPlaneIssues(repo),
			features: [...this.featureStore.values()],
		});
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

	private async recordFeedbackAudit(actor: Actor, action: string, target: string, detail?: string): Promise<void> {
		await this.recordAudit(actor, action, target, "ok", detail);
		await this.store.appendAudit({ actor: actor.id, action, target, detail: detail ? { detail } : undefined }).catch((err) => this.log("warn", `feedback audit write failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	/** Fleet-action audit log, newest first (server reads this; keeps stateDir private). */
	async auditLog(query: AuditQuery = {}): Promise<AuditEntry[]> {
		return readAudit(this.stateDir, query);
	}

	/**
	 * Background-loop activity (scout/observer/opportunity/dispatch): the recent event feed plus per-loop
	 * rollups over a trailing window. The observability surface the audit log never carried — it answers
	 * "what is running in the background, how often, and what is it costing" (server reads this for /api/automation).
	 */
	automationActivity(query: AutomationQuery & { windowMs?: number } = {}): { events: AutomationEvent[]; rollup: ReturnType<AutomationLog["rollup"]> } {
		return { events: this.automation.recent(query), rollup: this.automation.rollup(query.windowMs) };
	}

	private async commentPlaneTargets(repo: string, subject: string): Promise<string[]> {
		if (/^[A-Z0-9]+-\d+$/i.test(subject)) return [subject.toUpperCase()];
		const feature = (await this.features(repo)).find((item) => item.id === subject);
		return feature?.issueIdentifiers ?? [];
	}

	/** Add a review comment or anchored plan annotation on a subject. */
	async addComment(input: { repo: string; subject: string; body: string; urgent?: boolean; kind?: "comment" | "plan-annotation"; annotation?: PlanAnnotationTarget }, actor: Actor | string = LOCAL_ACTOR): Promise<ArtifactComment> {
		const author = typeof actor === "string" ? actor : actor.id;
		const at = Date.now();
		const id = nextCommentId(at);
		await appendCommentEvent(this.stateDir, { type: "add", id, repo: input.repo, subject: input.subject, body: input.body, author, urgent: input.urgent, at, kind: input.kind, annotation: input.annotation });
		const comment: ArtifactComment = { id, repo: input.repo, subject: input.subject, body: input.body, author, urgent: input.urgent, createdAt: at, kind: input.kind, annotation: input.annotation };
		this.emit("event", { type: "comment", comment } satisfies SquadEvent);
		// Only regular comments fan out to Plane; plan-annotations are plan-doc-local review chatter
		// anchored to a rendered block/line and arrive in Plane stripped of that context (noise), so suppress them.
		if (input.kind !== "plan-annotation") for (const issue of await this.commentPlaneTargets(input.repo, input.subject)) void addPlaneIssueComment(input.repo, issue, input.body).catch((err) => this.log("warn", `plane comment sync failed: ${err instanceof Error ? err.message : String(err)}`));
		void this.recordAudit(actor, input.kind === "plan-annotation" ? "plan-annotate" : "comment", input.subject, "ok", truncate(input.body, 80));
		return comment;
	}

	/** Review comments on a subject (server reads this; keeps stateDir private). */
	async listComments(q: CommentQuery): Promise<ArtifactComment[]> {
		return readComments(this.stateDir, q);
	}

	/** Resolve (close) a review comment. */
	async resolveComment(id: string, actor: Actor | string = LOCAL_ACTOR): Promise<void> {
		const at = Date.now();
		await appendCommentEvent(this.stateDir, { type: "resolve", id, at });
		this.emit("event", { type: "comment-resolved", id, resolvedAt: at } satisfies SquadEvent);
		void this.recordAudit(actor, "comment-resolve", id, "ok");
	}

	/** Unresolved comments on a subject — consumed by the Slice-2 RPI feed-forward. */
	async addPlanRevisionCandidate(input: Omit<PlanRevisionCandidate, "id" | "state" | "createdAt" | "updatedAt"> & { id?: string; state?: PlanRevisionCandidateState; createdAt?: number; updatedAt?: number }, actor: Actor | string = LOCAL_ACTOR): Promise<PlanRevisionCandidate> {
		const candidate = await addPlanRevisionCandidate(this.stateDir, input);
		this.emitFeaturesChanged();
		void this.recordAudit(actor, "plan-candidate-add", candidate.featureId, "ok", candidate.summary);
		return candidate;
	}

	async listPlanRevisionCandidates(q: { repo?: string; featureId?: string; state?: PlanRevisionCandidateState } = {}): Promise<PlanRevisionCandidate[]> {
		return readPlanRevisionCandidates(this.stateDir, q);
	}

	async transitionPlanRevisionCandidate(id: string, state: PlanRevisionCandidateState, reviewer: Actor | string = LOCAL_ACTOR, reason?: string): Promise<PlanRevisionCandidate | undefined> {
		const name = typeof reviewer === "string" ? reviewer : reviewer.id;
		const candidate = await transitionPlanRevisionCandidate(this.stateDir, id, state, name, reason);
		if (candidate) this.emitFeaturesChanged();
		void this.recordAudit(reviewer, `plan-candidate-${state}`, id, candidate ? "ok" : "error", reason);
		return candidate;
	}

	async getUnresolvedComments(repo: string, subject: string): Promise<ArtifactComment[]> {
		return readComments(this.stateDir, { repo, subject, unresolved: true });
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
			if (req.targetId) this.append(rec, "system", "input request cancelled", { pending: { requestId: req.targetId, action: "cancelled" }, status: "cancelled" });
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
			this.append(rec, "system", `⛔ needs input: ${added.title}`, { pending: { requestId: added.id, action: "created" }, status: "running" });
		}
		rec.dto.status = this.derive(rec);
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
		if (added) this.maybeAutoSupervise(rec, added); // opt-in bounded auto-answer (registers the request first, above)
	}

	/** Advertise the reserved squad host tools to an omp-backed agent once it's ready (and on each
	 *  reconnect/respawn, since omp loses them). Best-effort — never throws into the ready path. */
	private registerHostTools(rec: AgentRecord): void {
		if (rec.options.runtime === "acp") return; // non-omp runtime: no host-tool channel
		try {
			rec.agent.setHostTools?.(SQUAD_HOST_TOOLS);
		} catch (err) {
			this.log("warn", `set_host_tools failed for ${rec.dto.name}: ${String(err)}`);
		}
	}

	private onHostTool(rec: AgentRecord, call: { id: string; toolName: string; arguments: unknown }): void {
		if (call.toolName === KB_SEARCH_TOOL) {
			void this.handleKbSearchTool(rec, call);
			return;
		}
		if (call.toolName === PEER_MESSAGE_TOOL) {
			void this.handlePeerMessageTool(rec, call);
			return;
		}
		// Capability tool-grant enforcement (#3): if this agent was spawned from a capability profile that
		// declared a tool allow-list, hard-deny any host tool call outside it instead of surfacing it for
		// approval. The built-in peer-message tool above is exempt (it's not a capability tool).
		if (rec.toolGrants && !rec.toolGrants.includes(call.toolName)) {
			this.append(rec, "system", `⛔ tool "${call.toolName}" denied — not in this capability's tool grant [${rec.toolGrants.join(", ")}]`, { status: "error", tool: { callId: call.id, name: call.toolName, args: call.arguments, argsText: safeJson(call.arguments) } });
			rec.agent.respondHostTool(call.id, `tool "${call.toolName}" is not granted to this capability (allowed: ${rec.toolGrants.join(", ") || "none"})`, true);
			void this.recordAudit(agentActor(rec.dto.id), "tool.denied", rec.dto.id, "error", `${call.toolName} not in grant`);
			this.emitAgent(rec);
			return;
		}
		const pending: PendingRequest = {
			id: call.id,
			source: "tool",
			kind: call.toolName,
			title: `tool: ${call.toolName}`,
			message: truncate(JSON.stringify(call.arguments ?? {}), 200),
			createdAt: Date.now(),
		};
		rec.dto.pending = [...rec.dto.pending.filter((p) => p.id !== call.id), pending];
		this.append(rec, "system", `⛔ tool call needs host: ${call.toolName}`, { pending: { requestId: pending.id, action: "created" }, status: "running", tool: { callId: call.id, name: call.toolName, args: call.arguments, argsText: safeJson(call.arguments) } });
		rec.dto.status = this.derive(rec);
		this.emitAgent(rec);
	}

	/** squad_kb_search: rank the context fabric (scoped to what this agent may see) and return the
	 *  hits to the calling agent. Read-only; surfaces a one-line note in the transcript for the operator. */
	private async handleKbSearchTool(rec: AgentRecord, call: { id: string; arguments: unknown }): Promise<void> {
		const args = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
		const query = (typeof args.query === "string" ? args.query : typeof args.q === "string" ? args.q : "").trim();
		if (!query) {
			rec.agent.respondHostTool(call.id, `usage: ${KB_SEARCH_TOOL}({ query: string, type?: "decision"|"hot-area"|"digest"|"agent"|"scout"|"lease", topK?: number })`, true);
			return;
		}
		const topK = Math.min(50, Math.max(1, typeof args.topK === "number" && Number.isFinite(args.topK) ? Math.floor(args.topK) : 10));
		const type = typeof args.type === "string" ? (args.type as KbDocType) : undefined;
		try {
			const snapshot = await this.fabric(agentActor(rec.dto.id), { repos: [rec.dto.repo], includeLeases: true });
			const results = searchFabric(snapshot, query, { topK, type });
			const body = results.length
				? results.map((r) => `- [${r.type}] ${r.title}\n  ${r.snippet}${r.repo ? `\n  (${r.repo})` : ""}`).join("\n")
				: "No matching context in the knowledge base.";
			rec.agent.respondHostTool(call.id, body);
			this.append(rec, "system", `🔎 ${KB_SEARCH_TOOL}("${truncate(query, 80)}") → ${results.length} result${results.length === 1 ? "" : "s"}`, {
				status: "ok",
				tool: { callId: call.id, name: KB_SEARCH_TOOL, args: call.arguments, argsText: safeJson(call.arguments), resultText: body },
			});
			void this.recordAudit(agentActor(rec.dto.id), "kb.search", rec.dto.id, "ok", `${results.length} hits for "${truncate(query, 60)}"`);
		} catch (err) {
			rec.agent.respondHostTool(call.id, err instanceof Error ? err.message : String(err), true);
		}
	}

	private async handlePeerMessageTool(rec: AgentRecord, call: { id: string; arguments: unknown }): Promise<void> {
		const args = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
		const to = typeof args.to === "string" ? args.to.trim() : "";
		const text = typeof args.text === "string" ? args.text : "";
		if (!to || !text.trim()) {
			rec.agent.respondHostTool(call.id, `usage: ${PEER_MESSAGE_TOOL}({ to: string, text: string })`, true);
			return;
		}
		try {
			await this.applyCommand({ type: "message", to, text }, agentActor(rec.dto.id));
			rec.agent.respondHostTool(call.id, `delivered advisory message to ${to}`);
		} catch (err) {
			rec.agent.respondHostTool(call.id, err instanceof Error ? err.message : String(err), true);
		}
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
		void this.refreshPlanFeatureSignature();
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

	private featureRepos(): string[] {
		return [...new Set([process.cwd(), ...planeRepos(), ...[...this.featureStore.values()].map((f) => f.repo), ...[...this.agents.values()].map((r) => r.dto.repo)].filter((repo) => repo && !repo.startsWith("(")))].sort();
	}

	private async planFeatureSignatureFor(repo: string): Promise<string> {
		const dirs = await listPlanDirs(repo).catch(() => []);
		return `${repo}\0${dirs.map((dir) => `${dir.dir}:${dir.updatedAt}:${dir.issueIds.join(",")}`).join("|")}`;
	}

	/** Detect direct `plans/` filesystem edits and wake web clients that already reload on features-changed. */
	private async refreshPlanFeatureSignature(): Promise<void> {
		const next = (await Promise.all(this.featureRepos().map((repo) => this.planFeatureSignatureFor(repo)))).join("\n");
		if (this.planFeatureSignature === "") {
			this.planFeatureSignature = next;
			return;
		}
		if (next !== this.planFeatureSignature) {
			this.planFeatureSignature = next;
			this.emitFeaturesChanged();
		}
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
		rec.dto.todoPhases = state.todoPhases;
		rec.dto.session = summarizeSession(state);
		// Rough completion estimate from progress rate (tasks done/total over elapsed). A hint, not a deadline.
		const elapsed = rec.dto.startedAt ? Date.now() - rec.dto.startedAt : 0;
		this.syncAuthority(rec.dto);
		const remaining = next ? estimateEta(next.done, next.total, elapsed) : undefined;
		rec.dto.etaAt = remaining !== undefined ? Date.now() + remaining : undefined;
		// RpcSessionState.contextUsage.percent is a 0..100 percentage; AgentDTO.contextPct is a 0..1 fraction.
		if (state.contextUsage) {
			rec.dto.contextPct = state.contextUsage.percent / 100;
			rec.dto.contextTokens = state.contextUsage.tokens;
			rec.dto.contextWindow = state.contextUsage.contextWindow;
		}
		if (state.model) rec.dto.model = `${state.model.provider}/${state.model.id}`;
		// Reconcile streaming truth without clobbering a pending-input state.
		if (rec.dto.pending.length === 0) {
			rec.streaming = state.isStreaming;
			if (rec.dto.status !== "stopped" && rec.dto.status !== "error") rec.dto.status = this.derive(rec);
		}
		this.emitAgent(rec);
	}

	// ── Transcript + emission ─────────────────────────────────────────────────

	private append(rec: AgentRecord, kind: TranscriptKind, text: string, patch: Partial<TranscriptEntry> = {}): TranscriptEntry {
		// ponytail: append() is the single transcript chokepoint — redact here so secrets reach
		// neither the in-memory buffer, persisted state.json, nor the emitted transcript event.
		// Receipt fields carry paths/tallies (not free text), so they need no separate redaction.
		const seq = ++this.transcriptSeq;
		const entry: TranscriptEntry = { ...patch, id: patch.id ?? `${rec.dto.id}:${seq}`, seq, kind, text: redact(text), ts: Date.now() };
		rec.transcript.push(entry);
		if (rec.transcript.length > MAX_TRANSCRIPT) rec.transcript.shift();
		rec.dto.messageCount = rec.transcript.length;
		this.emit("event", { type: "transcript", id: rec.dto.id, entry } satisfies SquadEvent);
		return entry;
	}

	private emitAgent(rec: AgentRecord): void {
		this.syncAuthority(rec.dto);
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
		const live = [...this.agents.values()].map((r) => r.options);
		// D1 FIX: fold in resumable checkpoints the adoption ceiling dropped this boot so the full-snapshot
		// replace doesn't erase them — a later restart re-attempts them. Live records win on id collision
		// (a deferred run that has since been adopted is now in the live roster).
		const liveIds = new Set(live.map((a) => a.id));
		const agents = this.deferred.length ? [...live, ...this.deferred.filter((d) => !liveIds.has(d.id))] : live;
		const transcripts: Record<string, TranscriptEntry[]> = {};
		for (const r of this.agents.values()) if (r.transcript.length) transcripts[r.dto.id] = r.transcript;
		const features = [...this.featureStore.values()];
		await this.store.save({ agents, transcripts, features, capabilities: this.capabilityStore });
	}

	/** Re-spawn agents persisted from a previous run. Returns how many were restored. */
	async loadPersisted(): Promise<number> {
		const snapshot = await this.store.load();
		this.capabilityStore = normalizeCapabilitySnapshot(snapshot.capabilities);
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
				profileId: p.profileId,
				approvalMode: p.approvalMode,
				thinking: p.thinking,
				issue: p.issue,
				parentId: p.parentId,
				featureId: p.featureId,
				owns: p.owns,
				requires: p.requires,
				produces: p.produces,
				scopeSource: p.scopeSource,
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

function feedbackMaxImageBytes(): number {
	const n = Number(process.env.OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES);
	return Number.isFinite(n) && n > 0 ? n : 2_000_000;
}

function feedbackItemOrThrow(items: FeedbackItem[], id: string): FeedbackItem {
	const item = items.find((x) => x.id === id);
	if (!item) throw new Error("feedback item not found");
	return item;
}

function rewardRecordOrThrow(snap: FeedbackSnapshot, id: string): { item: FeedbackItem; reward: FeedbackReward } {
	const item = feedbackItemOrThrow(snap.items, id);
	const reward = snap.rewards.find((r) => r.feedbackId === id);
	if (!reward || item.rewardStatus === "none") throw new Error("feedback item has no reward");
	return { item, reward };
}

function truncate(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function safeJson(value: unknown, max = 2000): string | undefined {
	if (value === undefined) return undefined;
	try {
		return truncate(redact(JSON.stringify(value, null, 2)), max);
	} catch {
		return truncate(redact(String(value)), max);
	}
}

function summarizeSession(state: RpcSessionState): AgentDTO["session"] {
	return {
		id: state.sessionId,
		name: state.sessionName,
		file: state.sessionFile,
		thinkingLevel: state.thinkingLevel === "minimal" || state.thinkingLevel === "low" || state.thinkingLevel === "medium" || state.thinkingLevel === "high" || state.thinkingLevel === "xhigh" ? state.thinkingLevel : undefined,
		steeringMode: state.steeringMode,
		followUpMode: state.followUpMode,
		interruptMode: state.interruptMode,
		isCompacting: state.isCompacting,
		autoCompactionEnabled: state.autoCompactionEnabled,
		messageCount: state.messageCount,
		queuedMessageCount: state.queuedMessageCount,
		systemPromptLines: state.systemPrompt?.length,
		tools: state.dumpTools?.map((t) => ({ name: t.name, description: t.description })),
	};
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

/** Filesystem-safe slug for a capability binding key (`cap:slug:id`) used as a workflow filename. */
function slugifyForFile(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "capability-workflow";
}

/**
 * Render a capability WorkflowDefinition (inline step graph) into a DOT/`.fabro` source the WorkflowEngine
 * can run. The capability dialect (steps with id/label/owner/next) has no explicit entry/exit, so we
 * synthesize a single `start` (Mdiamond) and single `exit` (Msquare):
 *   - start → every step with no inbound edge (graph roots),
 *   - each step → its declared `next` steps,
 *   - every leaf step (no outbound `next`) → exit.
 * Each step becomes an agent node whose prompt is its label + owner, so the engine executes a real turn.
 * Step ids are sanitized to valid DOT identifiers with a stable id↔dotId map so edges stay consistent.
 */
export function capabilityWorkflowToDot(def: WorkflowDefinition): string {
	const steps = def.steps;
	const dotIds = new Map<string, string>();
	const used = new Set<string>(["start", "exit"]);
	for (const step of steps) {
		let base = step.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "");
		if (!base) base = "step";
		let id = base;
		let n = 1;
		while (used.has(id)) id = `${base}_${n++}`;
		used.add(id);
		dotIds.set(step.id, id);
	}
	const inbound = new Set<string>();
	for (const step of steps) for (const nxt of step.next) if (dotIds.has(nxt)) inbound.add(nxt);
	const roots = steps.filter((step) => !inbound.has(step.id));
	const leaves = steps.filter((step) => step.next.filter((nxt) => dotIds.has(nxt)).length === 0);

	const lines: string[] = [`digraph ${slugifyForFile(def.id).replace(/[^A-Za-z0-9_]/g, "_") || "capability"} {`];
	lines.push(`  goal = ${dotString(def.label || def.id)};`);
	lines.push(`  start [shape=Mdiamond, label="Start"];`);
	lines.push(`  exit [shape=Msquare, label="Exit"];`);
	for (const step of steps) {
		const id = dotIds.get(step.id)!;
		const owner = step.owner ? ` (owner: ${step.owner})` : "";
		const prompt = `${step.label}${owner}. Complete this step toward the goal, then stop.`;
		lines.push(`  ${id} [shape=box, label=${dotString(step.label)}, prompt=${dotString(prompt)}];`);
	}
	for (const root of roots.length ? roots : steps.slice(0, 1)) lines.push(`  start -> ${dotIds.get(root.id)};`);
	for (const step of steps) {
		for (const nxt of step.next) {
			const to = dotIds.get(nxt);
			if (to) lines.push(`  ${dotIds.get(step.id)} -> ${to};`);
		}
	}
	for (const leaf of leaves.length ? leaves : steps.slice(-1)) lines.push(`  ${dotIds.get(leaf.id)} -> exit;`);
	lines.push("}");
	return lines.join("\n");
}

/** Quote a DOT attribute value, escaping `"` and `\` so multi-word labels/prompts parse cleanly. */
function dotString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
