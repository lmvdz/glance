/**
 * SquadManager — authoritative roster of managed agents.
 *
 * Owns each RpcAgent, derives human-meaningful status from its event stream,
 * buffers a transcript, persists roster config, and exposes a single
 * `applyCommand(cmd, actor)` entry point shared by every surface (local TUI /
 * web today, federation peers in Phase 2). Emits a `SquadEvent` stream.
 */

import { EventEmitter } from "node:events";
import { envBool, envInt, envNumber } from "./config.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { resolveStateDir } from "./state-dir.ts";
import * as path from "node:path";
import { type CommandAck, type FederationBus, LOCAL_ACTOR, NullFederationBus, PeerRoster, type RemoteCommand } from "./federation.ts";
import { attachLeaseGossip, LEASE_GOSSIP_INTERVAL_MS, type LeaseGossip } from "./federation-sync.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { AgentDriver, HostToolDef } from "./agent-driver.ts";
import { assessHealth, defaultHealthLimits, type HealthSample } from "./watchdog.ts";
import { estimateEta } from "./eta.ts";
import { FlueServiceDriver } from "./flue-service-driver.ts";
import { type BranchSpec, deriveBranchAgentId, WorkflowDriver, type WorkflowFleet } from "./workflow-driver.ts";
import { SandboxAgentDriver } from "./sandbox-agent-driver.ts";
import { AcpAgentDriver } from "./acp-agent-driver.ts";
import { contextReachesAgent, type HarnessDescriptor, hasSecondVerifiedProviderLane, resolveAcpCommand, resolveBin, resolveHarness, resolveHarnessName, unverifiedHarnessesEnabled } from "./harness-registry.ts";
import { resolveProvider } from "./model-lineage.ts";
import { type Architect, OmpArchitect } from "./architect.ts";
import { validateWorker } from "./validate.ts";
import { CommissionExecutor } from "./workflow/commission-executor.ts";
import { WorkflowEngine } from "./workflow/engine.ts";
import { parseWorkflow } from "./workflow/dot.ts";
import type { EngineCheckpoint, NodeResult, Workflow, WorkflowGraphSnapshot, WorkflowJournalEvent, WorkflowRunState } from "./workflow/types.ts";
import { appendCheckpoint, type CheckpointLogEntry, deleteCheckpointLog, evictCheckpointChain, getLastSeq, readCheckpoints } from "./workflow/checkpoint-log.ts";
import { buildObserveWorkflow, buildTddVerifyWorkflow, buildVerifyWorkflow } from "./workflow/verify-workflow.ts";
import { type Classify, detectVerify, detectVerifyStages, ompClassify, routeIntake } from "./intake.ts";
import type { WorkflowDefinition } from "./workflow-catalog.ts";
import { Dispatcher } from "./dispatch.ts";
import { openDispatchLedger } from "./dispatch-ledger.ts";
import { type Answer, answerBrief, listAnswers, readAnswer, saveAnswer } from "./answers.ts";
import { errText } from "./err-text.ts";
import { isConsolePrompt, stripConsolePrompt } from "./console-prompt.ts";
import { openRemovedLedger, type RemovedLedger } from "./removed-ledger.ts";
import { normalizeRepoPath, openProjectRegistry, readEphemeralProjects, writeEphemeralProjects, type ProjectRegistry } from "./project-registry.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Observer, type Finding } from "./observer.ts";
import { Scout, unscannedReasoning } from "./scout.ts";
import { type Hypothesis, sentinelEnabled } from "./drift-lens.ts";
import { confirmDrift } from "./drift-audit.ts";
import { gitDiffSinceBase } from "./convergence-run.ts";
import { readScoutCursors, writeScoutCursors } from "./scout-cursor.ts";
import { execGatedCommand } from "./gate-runner.ts";
import { Opportunity } from "./opportunity.ts";
import { ResidentPlanner } from "./resident-planner.ts";
import { DECOMPOSE_TIMEOUT_MS } from "./planner.ts";
import { hardenedGit, hardenedGitSync } from "./git-harden.ts";
import { Scheduler, liveAgents, occupyingAgents } from "./scheduler.ts";
import { RateLimitGate } from "./rate-limit.ts";
import { addIssueIdsToFeatureModule, addIssuesToFeatureModule, addPlaneBlockedByRelation, addPlaneIssueComment, closePlaneIssue, createPlaneIssue, deletePlaneModule, ensureFeatureModule, featureTickets, fetchIssueDetail, listPlaneIssues, listPlaneIssuesAllStates, planeRepos, reopenPlaneIssue, startPlaneIssue } from "./plane.ts";
import { syncPlanStatuses } from "./plan-sync.ts";
import { agentsToAdopt, deferredResumable, hardAgentCeiling, newAgentId, planeIssueBranch, selectAdoptable, slugPart } from "./spawn-identity.ts";
import { gateMembraneTokens, loadRepoProfiles, membraneDisciplinePrompt, membraneProfilesEnabled, modelOptionsFromRuntime, profileOptionsFromEnv, toolGrantsPrompt, type RuntimeModelOption } from "./agent-profiles.ts";
import { escapeHtml, planConcernTicketMatches, renderPlanConcernIssueHtml } from "./concern-tickets.ts";
import { capabilityWorkflowToDot, loadCommissionWorkflow, resolveWorkflowPath, slugifyForFile } from "./workflow-source.ts";
export { capabilityWorkflowToDot, resolveWorkflowPath };
import { archivePlanDir, buildFeatures, concernDocStatus, concernNumFromFile, deletePlanDir, featureLandStatus, isClosedConcernStatus, listPlanDirs, parsePlanConcerns, parsePlanDependencyGraph, planDocRefs, planeModuleUrlIn, restorePlanDir, updatePlanConcern, type LandMember, landOrder, type PlanConcern } from "./features.ts";
import { canTransition, dedupeTransitions, deriveStatus, followLineage, type DerivedReason, type TransitionReason } from "./agent-lifecycle.ts";
import { dirtyLandTargetWarnings, landAgent, type LandOpts, type LandResult, withRepoLandLock } from "./land.ts";
// Aliased: WorktreeInfo (worktree-reaper.ts) already has an `aheadOfBase` FIELD of its own — importing
// under the same bare name would read as if that field and this function were the same thing.
import { aheadOfBase as computeAheadOfBase, aheadUnknown, resolveLandMode } from "./land-mode.ts";
import { getDoneProofByBranch, getDoneProofByIssue, hasProof, isAncestor, proofCoversTip, recordDoneProof, type DoneProof } from "./done-proof.ts";
import { assertMerged, deletePendingPr, ensurePr, isFullyConfirmedPendingPr, landAgentPr, listPendingPrs, mergeMethod, type MergeMethod, type PendingPr, updatePendingPr } from "./land-pr.ts";
import { ghJson } from "./gh.ts";
import { repoIdentity } from "./repo-identity.ts";
import { autoLandOnSuccess } from "./autoland.ts";
import { ownershipConflict, requiresConflict, outOfScopeWrites, producesAllowlist } from "./ownership.ts";
import { headCommit, isFresh, proofFingerprint, proofFor, proofGate, runProof, setProofRoot, sweepProofs } from "./proof.ts";
import { setGateLogRoot, sweepGateLogs } from "./gate-logs.ts";
import { type Judge, validatorGate } from "./validator.ts";
import { evaluateCompliance, type ComplianceFinding } from "./compliance.ts";
import { reapDeadSessions, releaseSession, sweepLeases } from "./leases.ts";
import { agentActor, scopeFor } from "./agent-scope.ts";
import { buildFabricSnapshot, loadScoutFacts, type FabricSnapshot } from "./fabric.ts";
import { buildContextPrimer, searchFabric, type KbDocType } from "./fabric-search.ts";
import { sweepPresence, who } from "./presence.ts";
import { harnessEventDecision } from "./harness-hooks.ts";
import { adoptBranchName, adoptBrief, isSafeUntrackedPath, parseNulList } from "./adopt.ts";
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
	FeatureCategory,
	FeatureCriterion,
	FeatureDecision,
	FeatureRelationship,
	PlanRevisionCandidate,
	PlanRevisionCandidateState,
	PlanVoteChoice,
	PlanVoteRound,
	AgentStatus,
	AutomationEvent,
	CommandInfo,
	ClientCommand,
	CreateAgentOptions,
	CommissionResult,
	AgentReport,
	AttentionEvent,
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
	TransitionEntry,
	FeedbackCampaign,
	FeedbackItem,
	FeedbackReward,
	FeedbackValidationResponse,
	ValidationRecord,
	VerifySpec,
} from "./types.ts";
import { type SubagentNode, SubagentTracker, mergeSubagents } from "./subagents.ts";
import { commandRole, effectiveRole, RbacDenied, roleAtLeast } from "./auth.ts";
import { hostAlive, pruneStaleSockets, reapOrphanHosts, shutdownHost, socketPathFor } from "./agent-host.ts";
import { addWorktree, deleteBranchIfMerged, isGitRepo, listWorktrees, provisionWorktreeDeps, removeWorktree, repoRoot, resolveWorktree, worktreeBase, worktreeStatus } from "./worktree.ts";
import { toAcpMcpServers, writeMcpConfig } from "./mcp-config.ts";
import { selectReapable, type WorktreeInfo } from "./worktree-reaper.ts";
import { scrubbedSpawnEnv } from "./spawn-env.ts";
import { changedFiles, filesTouchedSinceBase } from "./explore.ts";
import { appendReceipt, confirmDeliveredFlags, EFFICIENCY_FLAG_PREFIX, readAllReceipts, readReceipts, RunAccumulator, splitCapabilityTokens } from "./receipts.ts";
import { membraneBreakerCadence } from "./membrane-breaker-cadence.ts";
import { appendAudit, type AuditQuery, makeAuditEntry, readAudit } from "./audit.ts";
import { AutomationLog, type AutomationQuery } from "./automation-log.ts";
import { isFirstTryGreen, isOn, learningFlags, LearningMetrics, type MetricRollupRow } from "./metrics.ts";
import { reflect } from "./reflection.ts";
import { failureAnnotation, recordFailureAnnotation } from "./failure-memory.ts";
import { readModelOutcomes, recordModelOutcome, recordModelOutcomeBlocked, tierOf } from "./model-outcomes.ts";
import { shadowCostCheck } from "./cost-gate.ts";
import { buildScoreboard, type Scoreboard } from "./attribution-scoreboard.ts";
import { recordConfidenceOutcome, setThresholdTunerRoot, tunedConfidenceFloor } from "./threshold-tuner.ts";
import { JsonlLog } from "./jsonl-log.ts";
import { buildFactoryStatus, FACTORY_FRESHNESS_FLOOR_MS, FACTORY_LOOPS, type FactoryStatus } from "./factory-status.ts";
import { addPlanRevisionCandidate, appendCommentEvent, type ArtifactComment, type CommentQuery, type PlanAnnotationTarget, listComments as readComments, listPlanRevisionCandidates as readPlanRevisionCandidates, nextCommentId, transitionPlanRevisionCandidate } from "./comments.ts";
import { castPlanVote as appendPlanVoteCast, closePlanVoteRound as appendPlanVoteClose, currentPlanVoteRound as readCurrentPlanVoteRound, listPlanVoteRounds as readPlanVoteRounds, type OpenPlanVoteInput, openPlanVoteRound, recordPlanVoteCommit, tallyPlanVoteRound } from "./plan-votes.ts";
import { isPlanDocPath, planDocHeadRevision, resolveSafeDocPath } from "./plan-doc.ts";
import type { VoteQuorum } from "./plan-vote-quorum.ts";
import { landFailureCount, readForcedLands, readLandLedger, readValidatorOverrides, recordForcedLand, recordLandOutcome, recordValidatorOverride } from "./land-ledger.ts";
import { isLandingUnit, landingRosterOf } from "./is-landing-unit.ts";
import { readTaskOutcomes, recordTaskOutcome, type TaskOutcomeRow } from "./task-outcomes.ts";
import { buildTaskClassMatrix } from "./omp-graph/task-class-matrix.ts";
import { DAY_MS } from "./omp-graph/schema.ts";
import { routeModelForTaskClass } from "./model-route.ts";
import { openOrchestratorState } from "./orchestrator-state.ts";
import { authoredSpecBlock, buildDigest, type DigestReward, fenceUntrusted, readDigest, writeDigest } from "./digest.ts";
import { readChatAttachment, reapStaleChatAttachments, type SavedChatAttachment, writeChatAttachment } from "./chat-attachment.ts";
import { harnessScorecardEnabled, scoreHarness } from "./harness-scorecard.ts";
import { isArmed } from "./convergence-oracle.ts";
import { lensAdvisoryBucket, scoreConfidence } from "./confidence.ts";
import { redact } from "./redact.ts";
import { FileStore, type StateSnapshot, type Store } from "./dal/store.ts";
import { buildTrace, traceMaxSpans, traceSampleRatio, traceSpansEnabled, type TraceResponse } from "./spans.ts";
import { traceExporterFromEnv, type TraceExportQueue } from "./trace-exporter.ts";
import { transcriptSince } from "./transcript-delta.ts";
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
 * How long a built spawn scoreboard is served from cache (see `spawnScoreboard()`). Outcome data
 * only changes on lands, and the board feeds a routing TIE-BREAKER (never a gate/veto), so a
 * minutes-stale read is immaterial — while the alternative is an O(lifetime-receipts) directory
 * walk + parse on EVERY interactive `POST /api/spawn` once `OMP_SQUAD_MODEL_OUTCOMES=1`.
 */
export const SPAWN_SCOREBOARD_TTL_MS = 60_000;
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
/** Epic 5 (HITL safeguards, DESIGN.md D2): NON-blocking — responds immediately, never rides `pending`. */
const REPORT_TOOL = "squad_report";
/** Decision capture (research-tencentdb-agent-memory): NON-blocking like REPORT_TOOL. Advertised only
 *  when the OMP_SQUAD_DECISION_CAPTURE flag is on. Writes a source:"agent" decision to the agent's
 *  feature so future agents inherit it via the cold-start primer / squad_kb_search. */
const RECORD_DECISION_TOOL = "squad_record_decision";
/** cmux-research concern 03: NON-blocking, same shape as REPORT_TOOL — a bare "look here", not a gate. */
const ATTENTION_TOOL = "squad_attention";

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
	{
		name: REPORT_TOOL,
		description:
			"Raise a proposal or flag uncertainty WITHOUT stopping — non-blocking, unlike a confirm/input host call. Use when you're unsure about an approach and want a human to weigh in at their own pace while you keep working. It appears as a 'Needs you' row, not a gate.",
		parameters: {
			type: "object",
			properties: {
				summary: { type: "string", description: "One line: what you're unsure about, or the proposal." },
				proposal: { type: "string", description: "Optional: the proposed diff/approach/next step in more detail." },
				confidence: { type: "number", description: "Optional: your own 0..1 confidence in the current approach." },
			},
			required: ["summary"],
		},
	},
	{
		name: ATTENTION_TOOL,
		description:
			"Flag that you need a human to look at something — non-blocking, unlike a confirm/input host call. Use when you want to surface a finding, a heads-up, or something worth a human's attention without stopping your own work. It appears as a 'Needs you' row, not a gate.",
		parameters: {
			type: "object",
			properties: {
				summary: { type: "string", description: "One line: what needs a human's attention." },
				detail: { type: "string", description: "Optional: more context." },
			},
			required: ["summary"],
		},
	},
];

/** Advertised only when OMP_SQUAD_DECISION_CAPTURE is on (see registerHostTools) — kept out of the
 *  always-on SQUAD_HOST_TOOLS so the flag gates advertisement, not just dispatch. */
const RECORD_DECISION_TOOL_DEF: HostToolDef = {
	name: RECORD_DECISION_TOOL,
	description:
		"Record a consequential decision you made and WHY (an architecture choice, a tradeoff, an approach picked over an alternative) so future agents on this work inherit it instead of re-deciding it. Non-blocking — you keep working. Use SPARINGLY, only for genuinely load-bearing decisions, not routine steps.",
	parameters: {
		type: "object",
		properties: {
			text: { type: "string", description: "The decision and its rationale, in one or two sentences." },
		},
		required: ["text"],
	},
};

/**
 * Re-emit cooldown for the repo-level "land blocked" warn event (research-sirvir/01, review). The
 * orchestrator re-attempts retryable lands every ~30s tick, so an unthrottled emit floods
 * automation.jsonl (append-only, no rotation) at 120 rows/hr/agent. The event CANNOT be suppressed
 * outright, though: factory-status derives the landBlocked banner from FRESH "land" rollup rows, so a
 * persisting refusal must keep re-emitting inside that freshness window or the banner silently
 * self-clears while landing is still blocked. Derived from the exported window floor minus one
 * orchestrator-tick margin (never an independent number that could drift past the window): a
 * persistent dirty main re-emits every ~4 minutes — one warn per repo condition, not per agent-tick.
 */
const LAND_BLOCKED_WARN_COOLDOWN_MS = FACTORY_FRESHNESS_FLOOR_MS - 60_000;

/**
 * Greppable marker for a membrane-breaker/staleness escalation filed with NO live triggering unit
 * (`fileMembraneBreakerFinding`'s rec-less arm). Verified investigation (blind-review follow-up,
 * see the doc comment on `fileMembraneBreakerFinding`): as of this fix there is NO rendered UI
 * surface — cockpit or graph — that a repo/daemon-scoped automation event with no live `agentId`
 * reaches. This marker exists so the escalation is still trivially findable by anyone grepping
 * automation.jsonl, `/api/automation`, or `glance automation --loop land`, until a real
 * repo-scoped attention surface exists to carry it.
 */
export const UNATTACHED_ESCALATION_MARKER = "UNATTACHED-ESCALATION (no live triggering unit — CLI/API only, see automation.jsonl)";

function peerMessageBudget(): number {
	return envInt("OMP_SQUAD_PEERMSG_BUDGET", 5);
}

function commandTarget(cmd: ClientCommand): string | undefined {
	return cmd.type === "message" ? cmd.to : "id" in cmd ? cmd.id : undefined;
}

/** Observability-only provenance tag carried on the mutating variants ("voice" | "composer", kept
 *  open) — never consulted for authz/tier decisions (see authz.ts#commandTier). */
function commandSource(cmd: ClientCommand): string | undefined {
	return "source" in cmd ? cmd.source : undefined;
}

function autoLandFailCap(): number {
	return envInt("OMP_SQUAD_AUTOLAND_FAIL_CAP", 3);
}

/**
 * Cross-lineage review (grok-4.5, eap-borrows) finding #2: `autoLandFailCap` above deliberately EXCLUDES
 * retryable refusals from the fail streak (a transient dirty-main window must never park a healthy
 * branch — see the `land()` comment at its `!result.retryable` gate), so a RETRYABLE refusal
 * (stale-branch probe failure, transplant probe failure, dirty-main) has NO bounded escalation path of
 * its own: `fileLandBlockedFinding` re-warns forever on a cooldown, but nothing ever stops retrying or
 * tells a human "this one specific episode has been stuck for a while, go look" — the taxonomy in
 * `classify-probe-failure.ts` calls this `escalate`, but land.ts/land-pr.ts's callers hardcode
 * `retryable: true` on the LandResult without ever consulting a budget. Bounds how many consecutive
 * attempts on the SAME episode (repo+branch+headSha+reasonClass — see `landBlockedEpisode`) run before
 * `land()` files a "Needs you" attention item on top of the routine automation warn. 0 disables (pure
 * opt-out, never the default — an unbounded factory that silently thrashes forever is the exact failure
 * mode this closes). At the ~30s auto-land retry cadence, the default is roughly 10 minutes.
 */
function landBlockedEscalateCap(): number {
	return envInt("OMP_SQUAD_LAND_BLOCKED_ESCALATE_CAP", 20);
}

/**
 * Bounded-escalation budget for `agentHasUnlandedWork`'s aheadUnknown streak (finding #1,
 * cross-lineage review of af3d534). A transient `aheadOfBase` fault costs one wasted acceptance-suite
 * run (the assume-work-exists polarity af3d534 chose, unchanged here) — but a PERSISTENT fault on the
 * SAME (repo, branch) used to cost one wasted run PER ORCHESTRATOR TICK, forever, with the only bound
 * being the unrelated `landBlockedEscalateCap` budget inside `land()` itself, which nothing guarantees
 * this path ever reaches (a fault narrow to `aheadOfBase`'s own git call may never make `land()` itself
 * return `retryable`). This is the independent budget for THAT path: how many consecutive
 * "couldn't determine" reads on the same branch run before `agentHasUnlandedWork` stops re-entering
 * verify/land and instead files a "Needs you" attention item. Small default (3, not 20) — this gates a
 * COSTLY suite run every ~30s tick, not a cheap land probe, so the wasted-work budget should be tighter.
 * 0 disables (pure opt-out, never the default).
 */
function aheadUnknownEscalateCap(): number {
	return envInt("OMP_SQUAD_AHEAD_UNKNOWN_ESCALATE_CAP", 3);
}

/**
 * Epic 5 (HITL safeguards, DESIGN.md D1): below this run-end confidence score, `syncAuthority`
 * caps the agent's effective mode to `assist` (propose-only) regardless of requested/approval/
 * autoLand policy. Read fresh (not cached) so tests can flip it per-case. Default 0.4.
 *
 * Epic 6 concern 08 (confidence-threshold tuner): when OMP_SQUAD_THRESHOLD_TUNER is on, the floor
 * is read from the tuner's persisted, evidence-adjusted value instead of the bare env default — the
 * tuner only ever loosens it (see threshold-tuner.ts), so this can never end up MORE restrictive
 * than the operator's own setting, only less. Flag off (default) ⇒ byte-identical to before.
 */
function confidenceFloor(): number {
	const base = envNumber("OMP_SQUAD_CONFIDENCE_FLOOR", 0.4);
	return isOn(learningFlags().thresholdTuner) ? tunedConfidenceFloor(base) : base;
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

/**
 * Gates applyState's poll-based ghost-expiry fallback (#lifecycle-truth finding 6). Default OFF: the
 * rule infers a replayed pending is stale from two consecutive `isStreaming === false` polls, but that
 * assumption — `isStreaming` reads false only when NOT suspended on a blocking UI request — is
 * unverified against a live `omp` genuinely blocked on a confirm (DESIGN.md's own risk log flags this
 * and calls for a live acceptance test before the rule ships on). The deterministic, proof-based
 * replay-tag expiry (a completed live turn after settle — `expireReplayedPending` off `agent_end`) is
 * NOT gated by this flag and stays always on. Read fresh on every call (not cached) so tests can flip it
 * per-case.
 */
function pendingGhostExpiryEnabled(): boolean {
	return process.env.OMP_SQUAD_PENDING_GHOST_EXPIRY === "1";
}

/**
 * Sentinel v0 (plans/sentinel-drift-probe) eligibility escape hatch — DESIGN.md's Risks table calls
 * for an "env allowlist/denylist" against the criteria-presence gate being too coarse. A comma-
 * separated list of agent ids/names to EXCLUDE from drift monitoring even when they declare
 * acceptance criteria. Unset/empty ⇒ nothing denied (the criteria-presence gate is the only filter).
 */
function sentinelDenied(...ids: (string | undefined)[]): boolean {
	const raw = process.env.OMP_SQUAD_SENTINEL_DENY;
	if (!raw) return false;
	const deny = new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	return ids.some((id) => id !== undefined && deny.has(id));
}

// liveAgents + the WIP cap live in ./scheduler.ts; spawn identity/adoption policy in ./spawn-identity.ts;
// profile/model parsing in ./agent-profiles.ts. Re-exports keep the public import paths stable.
export { liveAgents };
export { agentsToAdopt, deferredResumable, hardAgentCeiling, newAgentId, planeIssueBranch, selectAdoptable } from "./spawn-identity.ts";
export { loadRepoProfiles, modelOptionsFromRuntime, profileOptionsFromEnv, toolGrantsPrompt, type RuntimeModelOption } from "./agent-profiles.ts";

/** UI methods that block the agent on a human decision. */
/**
 * Is this UI request a decision a HUMAN must make?
 *
 * TIGHTEN-ONLY. The frame may ESCALATE a request to gate-class; it can never de-escalate one. Both
 * inputs are honored, and the union wins:
 *
 *   - `gateClass: true` from a driver that knows it is relaying an approval gate (every ACP
 *     `session/request_permission` — the harness stopped because it may not grant itself the action).
 *   - omp's naming conventions (`gate_` id, `GATE:` title), which were the ENTIRE classifier and only
 *     ever described omp. An ACP id is `acpui_<n>`, so every foreign harness's permission prompt failed
 *     the test and became eligible for the auto-supervisor's "when in doubt … approve".
 *
 * The asymmetry is the point. `extension_ui_request` is deliberately NOT schema-validated
 * (`schema/agent-host-frame.ts` validates only the two frames that mutate daemon state), and it arrives
 * from the agent process — which runs model-authored tool calls and now carries a fabric primer of
 * other agents' text. If a frame could assert `gateClass: false`, a prompt-injected agent would opt its
 * own `gate_` request out of human review and hand it to a small model. Trust the claim only in the
 * direction that asks for MORE human attention.
 *
 * A gate-class request is never auto-answered by any supervisor: no LLM call, no fallback, no spend. (R7)
 */
export function gateClassOf(req: { id: string; title?: string; gateClass?: boolean }): boolean {
	return req.gateClass === true || req.id.startsWith("gate_") || (typeof req.title === "string" && req.title.startsWith("GATE:"));
}

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

function isAgentDisconnected(err: unknown): boolean {
	return err instanceof Error && /agent (not connected|connection lost)/i.test(err.message);
}

/** Cause payload passed to transition()/setPending() — `error` is the one field transition() itself
 *  consumes (assigns to `rec.dto.error`); everything else rides along for the log entry only. */
type TransitionCause = { error?: string; priorId?: string; [k: string]: unknown };

/** Redact every string field of `cause` (error/title/message/etc.) through the same chokepoint
 *  append() uses (redact.ts) — matches the design's redact-at-write decision (secrets never touch
 *  transitions.jsonl or the emitted event, at the cost of not covering display-time changes). */
function redactCause(cause: TransitionCause): TransitionCause {
	const out: TransitionCause = {};
	for (const [k, v] of Object.entries(cause)) out[k] = typeof v === "string" ? redact(v) : v;
	return out;
}

/** The lineage/topology fields threaded onto EVERY PersistedAgent/AgentDTO/CreateAgentOptions
 *  construction site (create()'s persisted+dto literals, attachExisting, reattachTerminal,
 *  adoptOrphanedAgents' and loadPersisted's create() calls). Field names are identical across all three
 *  shapes, so the same picked object spreads cleanly into any of them.
 *
 * Topology review finding 9: hand-copying these at five call sites means the next field WILL be missed
 * at one of them — finding 7 caught exactly that (traceId shipped on AgentDTO in cfeeade with no
 * PersistedAgent counterpart, so a restarted run's trace link silently went dark). Route every site
 * through here so a future field is added in ONE place instead of five. */
function lineageFieldsFrom(p: {
	parentNodeId?: string;
	branchIndex?: number;
	subagents?: SubagentNode[];
	workflowGraph?: WorkflowGraphSnapshot;
	traceId?: string;
}): { parentNodeId?: string; branchIndex?: number; subagents?: SubagentNode[]; workflowGraph?: WorkflowGraphSnapshot; traceId?: string } {
	return {
		parentNodeId: p.parentNodeId,
		branchIndex: p.branchIndex,
		subagents: p.subagents,
		workflowGraph: p.workflowGraph,
		traceId: p.traceId,
	};
}

/** Carry the harness lineage (harness name / legacy runtime alias / bin override) through the COLD
 *  restore + adopt create() calls, which rebuild options from a PersistedAgent with an explicit field
 *  list. Without this a restored pi/ACP unit silently reverts to omp — the exact respawn-as-omp bug the
 *  `harness` field exists to prevent (the warm reconnect path reads the record directly and is unaffected). */
function harnessFieldsFrom(p: { harness?: string; runtime?: "omp" | "acp"; bin?: string }): { harness?: string; runtime?: "omp" | "acp"; bin?: string } {
	return { harness: p.harness, runtime: p.runtime, bin: p.bin };
}

/**
 * The ACTUAL inner runtime a persisted record's turns execute on — never the env default when the
 * kind pins something else (cross-lineage review, PR #112 finding 2). `resolveHarnessName` resolves
 * to `GLANCE_HARNESS` for a record with no explicit harness, but:
 *  - a workflow-kind unit's inner coder/tester is ALWAYS an omp-dialect `RpcAgent`
 *    (`WorkflowDriver.acquireInner`/`acquireTester` — createInnerDriver aside, there is no harness
 *    selection on that path), so under `GLANCE_HARNESS=codex` its receipts must still read "omp";
 *  - a flue-service unit runs `flue run` (FlueServiceDriver) — its own runtime, labeled "flue".
 *    Not a registry harness name, which is fine: `RunReceipt.harness` is free-form by contract
 *    (the claude-code/codex ingesters already stamp non-registry names), and every reader
 *    (attribution, scoreboard) treats it as an opaque label.
 * Only plain omp-operator units resolve through the registry (explicit harness > legacy runtime
 * alias > global default).
 */
export function actualUnitHarness(p: { kind?: string; harness?: string; runtime?: string }): string {
	const kind = p.kind ?? "omp-operator";
	if (kind === "workflow") return "omp";
	if (kind === "flue-service") return "flue";
	return resolveHarnessName(p);
}

/**
 * THE one provider-resolution helper for the degradation ladder (cross-lineage review, PR #112
 * finding 1): both the dispatcher's `providerFor` gate and the `auto_retry_start` record site derive
 * their provider key from THIS function, so the two can never drift apart — a cap recorded under a
 * key the gate never checks would let per-provider gating keep dispatching straight into the capped
 * lane.
 *
 * INVARIANT — the key is derived from DECLARED configuration only:
 *  - `declaredModel` is an operator/profile-declared model; a model the pre-spawn model-route loop
 *    applied (OMP_SQUAD_MODEL_OUTCOMES=1, shadow off — see `PersistedAgent.routing.routedModel`)
 *    is intentionally EXCLUDED on both sides, because the dispatcher cannot predict routing for a
 *    prospective issue. Excluding it is the fail-safe direction: a routed unit's cap folds into the
 *    declared/default lane (over-pause), instead of the gate under-pausing into a capped routed lane.
 *  - The harness axis is the ACTUAL inner runtime (`actualUnitHarness`), so a workflow unit's cap
 *    lands where its omp inner actually consumed capacity. The dispatcher gates prospective issues
 *    with kind "omp-operator" (intake routing's kind outcome is unknowable pre-spawn); with the
 *    fleet default harness (omp — unknown lineage, folded to the dominant provider by the gate)
 *    that resolves to the SAME bucket as a workflow inner, so gate ≡ record in every real config.
 *    Divergence needs a vendor-pinned DEFAULT harness (today gated behind
 *    OMP_SQUAD_UNVERIFIED_HARNESS=1) — accepted and documented here rather than guessed around.
 */
export function unitProviderKey(p: { kind?: string; harness?: string; runtime?: string; declaredModel?: string }): string {
	return resolveProvider(p.declaredModel, actualUnitHarness(p));
}

/** The DECLARED model of a persisted record — `model` unless it is byte-for-byte the model the
 *  pre-spawn router applied (`routing.routedModel`), which is excluded from provider keys by
 *  `unitProviderKey`'s invariant. */
export function declaredModelOf(p: { model?: string; routing?: { routedModel?: string } }): string | undefined {
	return p.model !== undefined && p.model === p.routing?.routedModel ? undefined : p.model;
}

/**
 * The ONE place a `VerifySpec.mode` maps to a synthesized workflow builder. `makeDriver` and the
 * fork-resume re-parse (createFork) both call this identical expression so the two paths can never
 * drift apart on which mode selects which graph. Default (mode unset, or "verify") is byte-for-byte
 * today's `buildVerifyWorkflow` — no behavior change for existing verify-routed runs.
 */
function buildVerifyLoop(spec: VerifySpec): Workflow {
	if (spec.mode === "tdd") return buildTddVerifyWorkflow(spec);
	if (spec.mode === "observe") return buildObserveWorkflow(spec);
	return buildVerifyWorkflow(spec);
}

interface AgentRecord {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	/** Resolved harness descriptor backing this unit — the single source for capability gating
	 *  (hostTools/toolApproval/resumable/contextInjection) instead of `runtime === "acp"` string checks. */
	harness?: HarnessDescriptor;
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
	/** Set true the first time an `agent_end` frame lands (a fully completed turn — end_turn, cancel,
	 *  refusal, and error all fire it per acp-agent-driver.ts / the RpcAgent-side equivalent). Read by the
	 *  `exit` handler below: a process exit AFTER at least one completed turn, with the agent currently at
	 *  rest (not streaming, nothing pending), is a normal one-shot/session teardown — including a
	 *  signal-kill exit code (143 SIGTERM, 130 SIGINT, 137 SIGKILL) — never a crash. Never reset back to
	 *  false; once an agent has proven it can finish a turn, a LATER exit is judged by the CURRENT
	 *  streaming/pending state, not by re-demanding a fresh completed turn. */
	completedTurn?: boolean;
	/** Live subagent (task-spawned children) tree for this agent. */
	subs: SubagentTracker;
	/** Available slash commands (builtin + skills + extensions) reported by the agent. */
	commands?: CommandInfo[];
	/** Live receipt accumulator for the in-flight run (one per agent_start..end). */
	run?: RunAccumulator;
	/** The checkpoint listener's in-flight `appendCheckpoint` call, if any — awaited by the
	 *  `workflow_terminal` handler before computing `forkPoint.seq` so it references the checkpoint
	 *  entry just durably appended rather than racing it (both events fire from the same driver call in
	 *  quick succession). */
	checkpointAppending?: Promise<void>;
	/** In-flight rich tool transcript entries keyed by the runtime toolCallId. */
	toolEntries: Map<string, TranscriptEntry>;
	/** Review finding 8: set by applyCommand's "kill" case BEFORE calling `agent.stop()`, consumed (and
	 *  cleared) by `runAgentTask`'s `onExit` listener — distinguishes a deliberate operator kill (records a
	 *  permanent "failed" branch disposition, never re-spawned by a resume) from an unexpected exit/crash
	 *  (records "not_attempted", re-spawnable). Only meaningful for a branch agent's own record; harmless
	 *  no-op for any other kind. */
	killedByOperator?: boolean;
	/** Capability tool-grant allow-list (from the spawning profile's `capabilities`). When present, the
	 *  agent's declared allow-list is injected into its system prompt AND host tool calls outside the list
	 *  are hard-denied at the onHostTool seam. Absent ⇒ full tool access (unscoped, the historical default). */
	toolGrants?: string[];
	/** CONFIRMED-delivered efficiency-flag tokens (`receipts.ts#confirmDeliveredFlags`), computed once at
	 *  spawn from the same profile `capabilities` array `toolGrants` comes from. Threaded into the
	 *  `RunSeed` at `agent_start` so every receipt this run produces carries the same confirmed set —
	 *  never recomputed mid-run, and (like `toolGrants`) not persisted across a daemon restart. */
	efficiencyFlags?: string[];
	/** Consecutive `applyState` polls seen with `isStreaming === false` while pending is non-empty — the
	 *  poll-based ghost-expiry fallback's counter (concern 04). Reset to 0 the instant a poll reports
	 *  streaming, or pending drains to empty. */
	nonStreamingPolls?: number;
	/** Timestamps (ms epoch) of this agent's own recent error-class transitions (to:"error", reason
	 *  "fail"|"catastrophe"|"exit-error") — per-agent and unbounded-by-other-agents, unlike the
	 *  fleet-shared transitionLog ring (#lifecycle-truth finding 9: a busy fleet's 500-entry shared ring
	 *  can evict a quiet agent's own error entries well before the 1h window elapses, undercounting
	 *  exactly the flapping agent errorTransitions1h exists to surface). Trimmed to the trailing 1h by
	 *  countErrorTransitions1h on every read (recordTransition appends, applyState's poll path also
	 *  re-trims so the count DECAYS even once an agent stops transitioning — finding 8). On cold adopt,
	 *  closeOrphanedPending seeds this from the (already-hydrated, so cheap) in-memory ring's entries for
	 *  the prior agent id, so a fresh-id lineage stitch doesn't reset the flapping signal to zero. */
	errorTransitionTimestamps?: number[];
	/** Voice-loop completion push: set true when a `workflow_done` frame lands, consumed (and cleared) by
	 *  the `agent_end` frame the workflow driver always pairs it with immediately after (execRun's
	 *  cleanup — see workflow-driver.ts) — distinguishes the graph's real terminal completion from an
	 *  intermediate per-run `agent_end` (a human-gate/checkpoint boundary mid-graph, which never carries a
	 *  preceding `workflow_done`). In-memory only, never persisted — a fresh daemon boot has no in-flight
	 *  frame pair to track. Read by `onAgentEvent`'s `agent_end` case to gate `dto.voicePushArmed`
	 *  exposure so a multi-node workflow never mistakes a mid-graph idle blip for its actual finish. */
	workflowJustFinished?: boolean;
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
	/** Extra repo paths to always gossip file leases for (OMP_SQUAD_FED_REPOS), on top of those the
	 *  presence registry discovers. The daemon gossips owned leases in-process over `bus` (SEAM 1). */
	fedRepos?: string[];
	/** Owned-lease gossip cadence override (default {@link LEASE_GOSSIP_INTERVAL_MS}); tests use a fast tick. */
	leaseGossipIntervalMs?: number;
	/** Fallback timeout (ms) for concern 2's replay-completion marker on reattach — default 2000. An OLD
	 *  agent-host process (spawned before the marker frame shipped, surviving a daemon upgrade) never
	 *  sends it, so attachExisting's settle gate falls back to closing after this long instead of
	 *  wedging forever. Overridable so tests using a fake driver that never emits "replayComplete" don't
	 *  pay the full production timeout. */
	replaySettleTimeoutMs?: number;
}

/**
 * Internal-only spawn options carrying a caller-chosen agent id. NEVER added to `CreateAgentOptions` —
 * that type is what `server.ts`'s `{...cmd.options}` spread deserializes wire commands into, so any
 * field on it is attacker-reachable. `explicitId` only exists on this module-private type, which only
 * `createInternal` (a private method, never wire-reachable) can construct and pass down.
 */
type InternalCreateOptions = CreateAgentOptions & { explicitId: string };

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
	/** Peer operator presence observed off the bus's existing presence stream (SEAM 2: collapses the
	 *  server's former second, read-only coordinator socket). Own-echo dropped, stale peers pruned. */
	private readonly peerRoster: PeerRoster;
	/** In-process owned-lease gossip engine (SEAM 1), attached to `bus` on start when federation is live. */
	private leaseGossip?: LeaseGossip;
	private leaseGossipTimer?: Timer;
	/** Extra repo paths to always gossip leases for (OMP_SQUAD_FED_REPOS). */
	private readonly fedRepos: string[];
	private readonly leaseGossipIntervalMs: number;
	private availability: OperatorPresence["availability"] = "active";
	/** Per-feature serialization for plan-vote mutations (open/cast). Mirrors land.ts's `repoLands`
	 *  chain: every open-round and every cast for one feature runs strictly one-at-a-time, so
	 *  check-and-open is atomic (no two concurrent calls both see "no open round") and a deciding cast's
	 *  fold→close→onVotePassed side-effect fires exactly once (a racing second deciding cast re-reads
	 *  AFTER the first closed the round, sees it's no longer "voting", and does not re-fire). */
	private readonly voteLocks = new Map<string, Promise<unknown>>();
	private readonly stateDir: string;
	/** Resumable checkpointed records dropped by the adoption ceiling this boot — kept (not erased) so
	 *  persistNow folds them back into the snapshot for a later restart to re-attempt (D1 loss fix). */
	private deferred: PersistedAgent[] = [];
	/** Source runIds with a fork() call currently past the guards and not yet resolved — claimed
	 *  synchronously before the first `await` in fork() (readCheckpoints) and released in a `finally`, so
	 *  two concurrent fork() calls for the same source (double-click, webapp+TUI, a federated peer) can't
	 *  both pass the one-live-fork guard during the hundreds-of-ms-to-seconds window before createInternal
	 *  durably claims the slot itself (#never-lose-work concern 04 review finding 1). */
	private readonly forkInFlight = new Set<string>();
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
	/** TTL cache for `spawnScoreboard()` (see its doc): the last built board + build time. */
	private scoreboardCache?: { at: number; board: Scoreboard };
	/** Single-flight slot for `spawnScoreboard()` rebuilds — concurrent TTL-expired callers await the
	 *  same scan instead of each walking the whole receipts directory. Cleared on settle (either way). */
	private scoreboardInflight?: Promise<Scoreboard>;
	private orchestrator?: Orchestrator;
	/** Observers — one per configured Plane repo so every repo's backlog is audited (OMPSQ-137). */
	private readonly observers: Observer[] = [];
	/** Plan-sync tick timers (one per configured Plane repo); cleared in stop(). */
	private readonly planSyncTimers: Timer[] = [];
	/** PR-reconciler backstop timer (concern 07) — always-on, NOT gated by OMP_SQUAD_OBSERVE; cleared in stop(). */
	private prReconcileTimer?: Timer;
	/** Untracked-otherwise 20s post-boot stagger for the PR-reconciler tick; cleared in stop() so a
	 *  manager stopped within the stagger window never fires a tick after shutdown. */
	private prReconcileStaggerTimer?: Timer;
	/** Scouts keyed by configured Plane repo — one per repo so multi-repo reasoning is all harvested. */
	private readonly scouts = new Map<string, Scout>();
	/** Opportunity clusterers — one per configured Plane repo, fed by Scout facts + receipt hot areas. */
	private readonly opportunities: Opportunity[] = [];
	/** Resident planners — one per configured Plane repo; gated OMP_SQUAD_RESIDENT_PLANNER (default OFF,
	 *  opt-in unlike the loops above — an LLM-cost-bearing writer of source-tree files). */
	private readonly residentPlanners: ResidentPlanner[] = [];
	/** Per-agent scout scan cursor (agentId → last-scanned transcript ts); advanced by takeScoutReasoning.
	 *  Persisted (scout-cursor.json) so a warm daemon restart doesn't re-scan whole transcripts —
	 *  each re-scan was a redundant Scout LLM call per reattached agent. Loaded in the constructor. */
	private readonly scoutCursor: Map<string, number>;
	/** Durable "explicitly rm'd, never resurrect" tombstone (rm-doesn't-stick incident) — keyed by
	 *  agent id, NOT Plane issue id, so a later dispatch tick can still mint a fresh agent for a
	 *  still-open issue. Consulted by reconnectLive/adoptOrphanedAgents/loadPersisted; written by
	 *  remove(); CLEARED by createWithId when an authorized creator deliberately reuses the id
	 *  (deterministic workflow-branch ids must stay resurrectable by their parent's resume). */
	private readonly removedLedger: RemovedLedger;
	/** Durable repos-this-operator-works-in set; unioned into `projects()`. See project-registry.ts. */
	private readonly projectRegistry: ProjectRegistry;
	/** In-flight spawn-time dependency provisioning, keyed by agent id (cross-lineage review HIGH 1).
	 *  createWithId KICKS provisioning here without awaiting it — the invariant is "the verify gate
	 *  must not run before provisioning settles", NOT "the dispatch tick must wait", so the await
	 *  lives in makeDriver's workflow execCommand instead. Entries self-delete on settle; awaiting a
	 *  missing entry is a no-op (provisioning long since settled, or was never applicable). */
	private readonly provisioning = new Map<string, Promise<void>>();
	/** Observability spine for the background loops (scout/observer/opportunity/dispatch) — the surface
	 *  behind GET /api/automation. Live events also broadcast as a `type:"automation"` SquadEvent.
	 *  Assigned in the constructor (needs stateDir, which the constructor body sets). */
	private readonly automation: AutomationLog;
	/** Agentic-learning-loop baseline (concern 01) — the five metrics (first-try-green, fixups-to-green,
	 *  escalation, land-failure-streak, primer-empty) the rest of the learning loop is A/B'd against.
	 *  Assigned in the constructor (needs stateDir). Never gates behavior — read-only observability. */
	private readonly learningMetrics: LearningMetrics;
	/** Per-repo epoch ms until which the cold-start primer is skipped, after a fabric read of THAT repo
	 *  blew its budget. Per-repo, not global: one repo with thousands of receipts (or a Plane project
	 *  behind a stalled fetch) must not silently mute priming for every other repo the daemon serves.
	 *  (gpt-5.6-sol.) Overridable in tests via the protected `now()` seam. */
	protected primerBreakerUntil = new Map<string, number>();
	/** OMP_SQUAD_AUTOCLOSE (default ON): close a tracking issue when its branch LANDS — never on a bare gate-pass. */
	private readonly closeOnDone = process.env.OMP_SQUAD_AUTOCLOSE !== "0";
	private llmClassify?: Classify;
	private readonly closedIssues = new Set<string>();
	/** Idempotency for the "unverified DoneProof" escalation (finding #11, eap-borrows wave 2) — mirrors
	 *  `closedIssues`'s own pattern: fire the attention-lane/automation dual-write exactly once per issue
	 *  id, not once per reconciler tick (which would keep re-attempting the close forever). */
	private readonly unverifiedProofEscalated = new Set<string>();
	/** Per-agent count of auto-supervised answers spent this run (OMP_SQUAD_AUTOSUPERVISE attempt budget). */
	private readonly superviseBudget = new Map<string, number>();
	/** Per-agent count of advisory peer messages spent this run (OMP_SQUAD_PEERMSG_BUDGET). */
	private readonly peerMessageBudget = new Map<string, number>();
	/** Agent ids the daemon reattached to (surviving hosts) this run. */
	private readonly reattached = new Set<string>();
	/** Edge-trigger for the blocked model-outcome counter (research-sirvir/01, review): the orchestrator
	 *  re-attempts a retryable land every ~30s, so an unconditional increment turns `blocked` into a
	 *  tick-rate artifact instead of "attempted, couldn't land cleanly" per EPISODE. Keyed
	 *  `${repo}::${branch}` → `${headSha}::${reasonClass}`; increment only when the episode value
	 *  changes, cleared for a branch when a non-retryable outcome records for it. In-memory on purpose:
	 *  a daemon restart re-records at most once per still-live episode, which is acceptable noise. */
	private readonly landBlockedEpisode = new Map<string, string>();
	/** Last warn-emit ms per `${repo}::${reasonClass}` for the land-blocked automation event — one
	 *  re-emit per LAND_BLOCKED_WARN_COOLDOWN_MS per repo condition (a dirty main is ONE repo-level
	 *  fact, not a per-agent fact), keeping the factory-status banner alive without the per-tick flood. */
	private readonly landBlockedWarnAt = new Map<string, number>();
	/** Bounded-escalation budget (finding #2, cross-lineage review): consecutive `land()` attempts on
	 *  the SAME `landBlockedEpisode` value, keyed identically (`${repo}::${branch}`). Reset to 0 the
	 *  moment the episode changes (a new commit or a different refusal reason is a genuinely new
	 *  problem, not a continuation) and cleared entirely once a non-retryable outcome lands/rejects. */
	private readonly landBlockedAttempts = new Map<string, number>();
	/** Idempotency for `fileLandBlockedEscalation` — fires the "Needs you" attention item at most once
	 *  per live episode (mirrors `unverifiedProofEscalated`'s pattern), not once per tick past the cap. */
	private readonly landBlockedEscalated = new Set<string>();
	/** Consecutive `aheadUnknown` reads for `agentHasUnlandedWork`'s `${repo}::${branch}` scope (finding
	 *  #1, cross-lineage review of af3d534). Reset to 0 the INSTANT `aheadOfBase` next returns a real
	 *  number for that scope — a persistent fault must reach a human, but a transient one must self-clear
	 *  with no human involvement, and the reset is what makes the self-clear automatic. */
	private readonly aheadUnknownStreak = new Map<string, number>();
	/** Idempotency for `fileAheadUnknownEscalation` — fires at most once per unresolved streak (mirrors
	 *  `landBlockedEscalated`'s pattern). Cleared alongside `aheadUnknownStreak` the moment the scope's
	 *  git read recovers, so a LATER persistent fault on the same branch can escalate again. */
	private readonly aheadUnknownEscalated = new Set<string>();
	/** Deterministic branch agent ids `reconcileParallelResume` just stopped, so the next `spawnFleetBranch`
	 *  call under the same id knows to append the "resuming after a restart" addendum to the branch's
	 *  re-prompt. Consumed (deleted) the moment spawnFleetBranch checks it — short-lived, not persisted. */
	private readonly reconciledStops = new Set<string>();
	/** Agent ids currently draining agent-host ring replay on reattach — transition()/setPending() apply
	 *  the state change but record nothing, and maybeAutoSupervise is suppressed, until settling clears. */
	private readonly settling = new Set<string>();
	/** Resolvers awaiting concern 2's replay-completion marker frame from a reattached agent's host,
	 *  keyed by agent id. Armed by attachExisting BEFORE agent.start() is called (a host that replays
	 *  its whole ring inside the first socket read can emit the marker synchronously during start()'s
	 *  own await chain — arming after start() resolves would miss it and always fall through to the
	 *  timeout) and consumed by wire()'s "replayComplete" listener. */
	private readonly replayCompleteWaiters = new Map<string, () => void>();
	/** See {@link SquadManagerOptions.replaySettleTimeoutMs}. */
	private readonly replaySettleTimeoutMs: number;
	/** Persisted {agentId,from,to,reason,at} history (stateDir/transitions.jsonl) — ring-authoritative,
	 *  file best-effort. recordTransition/recordDenied append here; transitionHistory() reads it for
	 *  GET /api/agents/:id/transitions. Constructed in the constructor (needs stateDir). */
	private readonly transitionLog: JsonlLog<TransitionEntry>;
	private readonly traceExporter?: TraceExportQueue;
	/** Reward disbursement provider (Tremendous / Manual). Injectable for tests; default from env. */
	private readonly paymentProvider: PaymentProvider;
	private idSeq = 0;
	private transcriptSeq = 0;
	/** Last observed `plans/` signature for repos the feature board scans. */
	private planFeatureSignature = "";
	private readonly mainGateCache = new Map<string, { fp: string; result: { ok: boolean; firstFailure?: string; skipped?: boolean; unrunnable?: boolean }; tick: number }>();

	constructor(opts: SquadManagerOptions = {}) {
		super();
		this.operator = opts.operator ?? LOCAL_ACTOR;
		this.bus = opts.bus ?? new NullFederationBus();
		this.peerRoster = new PeerRoster(this.operator.id);
		this.fedRepos = opts.fedRepos ?? [];
		this.leaseGossipIntervalMs = opts.leaseGossipIntervalMs ?? envInt("OMP_SQUAD_LEASE_GOSSIP_MS", LEASE_GOSSIP_INTERVAL_MS);
		this.stateDir = opts.stateDir ?? resolveStateDir();
		setProofRoot(this.stateDir);
		setThresholdTunerRoot(this.stateDir);
		setGateLogRoot(this.stateDir);
		this.scoutCursor = readScoutCursors(this.stateDir);
		this.removedLedger = openRemovedLedger(this.stateDir);
		this.projectRegistry = openProjectRegistry(this.stateDir);
		// Reload session-scoped registration markers so a mid-session daemon restart cannot promote an
		// ephemeral `glance here` registration to permanent — start() reconciles them against the
		// restored roster (reconcileEphemeralProjects).
		this.ephemeralProjects = readEphemeralProjects(this.stateDir);
		this.automation = new AutomationLog(this.stateDir, { onEvent: (event) => this.emit("event", { type: "automation", event } satisfies SquadEvent) });
		this.learningMetrics = new LearningMetrics(this.stateDir, { log: (m) => this.log("warn", `learning-metrics: ${m}`) });
		this.transitionLog = new JsonlLog<TransitionEntry>({ path: path.join(this.stateDir, "transitions.jsonl"), log: (m) => this.log("warn", `transitions.jsonl: ${m}`) });
		this.bin = opts.bin;
		this.autoLand = opts.autoLand ?? false;
		this.worktreeBaseDir = opts.worktreeBase;
		this.store = opts.store ?? new FileStore(this.stateDir);
		this.skipGlobalJanitors = opts.skipGlobalJanitors ?? false;
		this.llmClassify = process.env.OMP_SQUAD_LLM_ROUTER ? ompClassify(this.bin) : undefined;
		this.traceExporter = traceExporterFromEnv((m) => this.log("warn", m), this.stateDir);
		this.paymentProvider = opts.paymentProvider ?? paymentProviderFromEnv();
		this.replaySettleTimeoutMs = opts.replaySettleTimeoutMs ?? 2000;
	}

	private blockedReason(dto: Pick<AgentDTO, "pending" | "error">): string | undefined {
		if (dto.error) return dto.error;
		return dto.pending.length ? "waiting for operator input" : undefined;
	}

	/**
	 * Epic 5 propose-only: is this run's confidence below the operator's floor? Mirrors the EXACT
	 * condition `effectiveAutonomyMode` (autonomy.ts) uses to cap the mode to `assist`, so the
	 * autonomous-land hold in `land()` and the UI/authority cap can never drift apart. Undefined
	 * confidence (no run has finished — a fresh agent) never holds.
	 */
	private confidenceBelowFloor(dto: Pick<AgentDTO, "confidence">): boolean {
		return dto.confidence !== undefined && dto.confidence < confidenceFloor();
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
			confidence: dto.confidence,
			confidenceFloor: confidenceFloor(),
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
			this.reconcileForkLineage();
		}
		// AFTER roster restore (needs the surviving agents to tell live `glance here` sessions from dead
		// ones) and outside the snapshot guard: a fresh-state boot with leftover markers means every
		// flagged session is dead, which is exactly the case that must be reaped.
		this.reconcileEphemeralProjects();
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
		// SEAM 2: observe peer operator presence off the bus's OWN presence stream (which already receives
		// coordinator frames) instead of dialing a second read-only socket. Own loopback echoes are dropped
		// by PeerRoster (self id). NullFederationBus never fires this, so the roster stays empty (inert).
		this.bus.onPresence((presence) => this.peerRoster.record(presence));
		// SEAM 1: gossip THIS operator's owned file leases in-process over the same bus, on a timer — so a
		// normal daemon shares leases without the standalone federation-sync worker. Skipped for the inert
		// NullFederationBus (OMP_SQUAD_FEDERATION=0 stays a pure no-op: no timer, no registry reads).
		if (!(this.bus instanceof NullFederationBus)) {
			this.leaseGossip = attachLeaseGossip({
				bus: this.bus,
				operator: this.operator,
				repos: this.fedRepos,
				onMirror: (frame) => this.log("info", `federation: mirrored ${frame.leases.length} lease(s) for ${frame.repoId} from ${frame.operator.id}`),
			});
			void this.leaseGossip.publishNow().catch(() => {});
			this.leaseGossipTimer = setInterval(() => void this.leaseGossip?.publishNow().catch(() => {}), this.leaseGossipIntervalMs);
			this.leaseGossipTimer.unref?.();
		}
		this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
		await this.refreshPlanFeatureSignature();
		// Auto-dispatch + auto-land (Orchestrator) live in start(), so they are per-org for free in DB
		// mode (one loop per SquadManager). ponytail: Plane repo config (planeRepos) is still read
		// daemon-global, so every org would dispatch the same repos — meaningful only for single-org
		// self-host. Ceiling: no per-tenant Plane wiring. Upgrade path: thread per-org Plane config
		// through RegistryDeps and pass it into each manager (deferred follow-up, out of P2 scope).
		if (process.env.OMP_SQUAD_AUTODISPATCH !== "0" && planeRepos().length > 0) {
			const interval = envInt("OMP_SQUAD_DISPATCH_INTERVAL_MS", 60_000);
			const maxActive = envInt("OMP_SQUAD_DISPATCH_MAX", 3);
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
				paused: (provider) => this.rateLimit.paused(provider),
				// Degradation ladder (concern 06, plans/research-sirvir/06-degradation-ladder.md): wire the
				// real provider-resolution + second-lane detector so dispatch.ts can gate per-issue instead of
				// once globally. `secondLaneAvailable` is a live registry check (not cached) — a harness
				// getting smoke-verified mid-boot flips the ladder live without a restart.
				providerFor: (repo, issue) => this.dispatchProviderFor(repo, issue),
				secondLaneAvailable: () => hasSecondVerifiedProviderLane(),
				record: this.automation.for("dispatch"),
				ledger: openDispatchLedger(this.stateDir),
				alreadyDone: (repo, issue) => this.issueAlreadyDone(repo, issue),
				liveAgents: () => this.list(),
				scopeFinding: (repo, message) => this.fileScopeFinding("low", repo, message),
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

		// Land-mode probe — resolved + logged per repo at boot so an operator sees WHY a repo landed in
		// PR vs local mode without digging ("all 5 probes passed" or the exact reason it forced local).
		for (const repo of observeRepos) {
			void resolveLandMode(repo)
				.then((r) => {
					this.log("info", `land mode for ${repo}: ${r.mode.toUpperCase()} (${r.reason})`);
					// The divergence probe (probe 5) forced local mode — give the operator the actual
					// runbook here, since the probe's own reason string just points back at this log line.
					if (r.mode === "local" && r.reason.includes("diverged")) {
						this.log("warn", `${repo}: local default branch has diverged from origin — reconcile it by either (a) pushing the local commits to origin if they're real forward progress the remote is missing, or (b) confirming they're already merged upstream some other way and then resetting the local checkout onto origin/<default> (e.g. \`git reset --hard origin/<default>\`)`);
						this.log("info", `${repo}: PR mode re-enables automatically once the two branches converge — no restart needed, the next resolved probe picks it up`);
					}
				})
				.catch((e) => this.log("warn", `land mode probe failed for ${repo}: ${String(e)}`));
		}
		if (process.env.OMP_SQUAD_OBSERVE !== "0" && observeRepos.length > 0) {
			observeRepos.forEach((repo, i) => {
				const observer = new Observer({
					listAgents: () => this.list(),
					listIssues: () => listPlaneIssues(repo),
					fileIssue: (title) => createPlaneIssue(repo, title),
					closeIssue: (ref) => closePlaneIssue(ref),
					reopenIssue: (ref) => reopenPlaneIssue(ref),
					removeAgent: async (id) => {
						await this.remove(id, false);
					},
					spawnObserver: (f) => this.dispatchObserver(repo, f),
					runGate: () => this.runMainGate(repo),
					gitAheadOfMain: (a) => this.aheadOfMain(a),
					untrackedInMain: () => this.untrackedInMain(repo),
					filesOnAgentBranch: (a) => this.filesOnAgentBranch(a),
					uncommittedInWorktree: (a) => this.uncommittedInWorktree(a),
					landLedger: () => readLandLedger(this.stateDir),
					recordLandFailureStreak: (count) => this.learningMetrics.record("land-failure-streak", count),
					annotateFailure: (finding, branch) => this.annotateRecurringFailure(repo, finding, branch),
					complianceFindings: () => this.complianceFindings(),
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
			const intervalMs = envInt("OMP_SQUAD_PLANSYNC_INTERVAL_MS", 300_000);
			for (const repo of observeRepos) {
				const tick = (): void => {
					void syncPlanStatuses({
						repo,
						listIssues: () => listPlaneIssuesAllStates(repo),
						hasProof: (identifier) => hasProof(this.stateDir, identifier),
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

		// PR-reconciler backstop (concern 07) — the synchronous `landAgentPr` path already writes
		// truth at merge-click; this loop only exists for what that path can't see: a human merging (or
		// closing) a PR directly in GitHub's UI, and the crash-ordering windows between push/create,
		// merge/proof, and proof/Plane-close. Deliberately NOT gated by OMP_SQUAD_OBSERVE (a toggleable
		// self-audit must not silently stop Done-writes for merged PRs) and NOT gated on
		// `observeRepos.length` (its own activity gate is "is there any ledger/roster work at all",
		// checked fresh inside every tick) — runs in DB mode too, same as every other manager-owned loop.
		const prReconcileIntervalMs = envInt("OMP_SQUAD_PR_RECONCILE_INTERVAL_MS", 120_000);
		this.prReconcileTimer = setInterval(() => void this.prReconcileTick().catch((e) => this.log("warn", `pr-reconcile: tick failed: ${e instanceof Error ? e.message : String(e)}`)), prReconcileIntervalMs);
		this.prReconcileStaggerTimer = setTimeout(() => void this.prReconcileTick().catch((e) => this.log("warn", `pr-reconcile: tick failed: ${e instanceof Error ? e.message : String(e)}`)), 20_000); // stagger past plan-sync's own 15s

		// Scout (sibling to the Observer) — semantic harvest, not operational audit: it reads agents'
		// reasoning and files the latent items they surfaced but didn't do. One per configured Plane repo
		// (OMPSQ-137); each only harvests agents whose repo it owns (scoutFor), so a finding lands in the
		// right tracker. Mid-run via the periodic sweep (liveReasoning) + run-end via finalizeRun.
		//
		// Gated on scout-enabled OR sentinel-enabled (not scout alone): Sentinel v0 (plans/sentinel-drift-probe)
		// rides Scout's shared cursor/sweep by design (one read, two lenses) — if this block were gated on
		// OMP_SQUAD_SCOUT alone, `OMP_SQUAD_SENTINEL=1` with the backlog harvest turned off (OMP_SQUAD_SCOUT=0)
		// would construct no Scout at all, so the drift sweep would silently never run (no timer, no log).
		if ((process.env.OMP_SQUAD_SCOUT !== "0" || sentinelEnabled()) && observeRepos.length > 0) {
			observeRepos.forEach((repo, i) => {
				// Sentinel v0 (plans/sentinel-drift-probe) is default OFF: only pay for criteria resolution /
				// the drift one-shot factory / the onHypothesis closure when the flag is actually on, so a
				// daemon with OMP_SQUAD_SENTINEL unset is byte-for-byte unchanged (Scout's own runDrift also
				// re-checks sentinelEnabled() itself — this is belt-and-suspenders against needless work).
				const sentinelOn = sentinelEnabled();
				const scout: Scout = new Scout({
					extract: ompClassify(this.bin),
					listIssues: () => listPlaneIssues(repo),
					fileIssue: (title, body) => createPlaneIssue(repo, title, body),
					liveReasoning: () =>
						[...this.agents.values()]
							.filter((r) => r.dto.status === "working" && this.scoutFor(r.dto.repo) === scout)
							.map((r) => ({
								agent: r.dto.id,
								runId: r.run?.snapshot().runId,
								task: r.options.task,
								issue: r.dto.issue?.identifier ?? r.dto.issue?.name,
								text: this.takeScoutReasoning(r),
								criteria: sentinelOn ? this.monitorCriteriaFor(r) : undefined,
							}))
							.filter((s) => s.text.length > 0),
					stateDir: this.stateDir,
					seenFile: i === 0 ? undefined : `scout-seen.${slug(repo)}.json`,
					log: (m) => this.log("info", `scout[${repo}]: ${m}`),
					record: this.automation.for("scout", repo),
					// Own automation channel (never `record` above) — a drift hypothesis is not a scout "found"
					// ticket, and conflating the two channels would double-count LLM spend/finds on the scout
					// backlog loop's rollup.
					driftRecord: sentinelOn ? this.automation.for("sentinel", repo) : undefined,
					driftExtract: sentinelOn ? ompClassify(this.bin) : undefined,
					onHypothesis: sentinelOn ? (h) => this.onDriftHypothesis(h) : undefined,
				});
				scout.start();
				this.scouts.set(repo, scout);
			});
			this.log("info", process.env.OMP_SQUAD_SCOUT !== "0" ? `scout on (harvesting reasoning → ${observeRepos.join(", ")})` : `scout backlog off, sentinel-only sweep on (drift monitoring → ${observeRepos.join(", ")})`);
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

		// Resident planner (Epic 1) — the inverse of plan-sync: ingests plans/<name>/OBJECTIVE.md and
		// maintains its concern-DAG against verified (DoneProof) state. Opt-IN ("=== 1", not "!== 0")
		// unlike every loop above — it is an LLM-cost-bearing writer of source-tree files.
		if (process.env.OMP_SQUAD_RESIDENT_PLANNER === "1" && observeRepos.length > 0) {
			observeRepos.forEach((repo, i) => {
				const planner = new ResidentPlanner({
					repo,
					stateDir: this.stateDir,
					// Per-repo state file (first repo keeps the bare name for upgrade continuity, the rest are
					// repo-suffixed): the state map is keyed by repo-RELATIVE planDir, so two repos each with a
					// `plans/<same-name>/` would otherwise share one entry and clobber each other's hash after
					// a restart (m1) — matching the scout/opportunity/observer per-repo seen-file convention.
					seenFile: i === 0 ? undefined : `resident-planner.${slug(repo)}.json`,
					classify: ompClassify(this.bin, DECOMPOSE_TIMEOUT_MS),
					hasProof: (identifier) => hasProof(this.stateDir, identifier),
					onChanged: () => this.emitFeaturesChanged(),
					log: (m) => this.log("info", `resident-planner[${repo}]: ${m}`),
					record: this.automation.for("resident-planner", repo),
				});
				planner.start();
				this.residentPlanners.push(planner);
			});
			this.log("info", `resident-planner on (decomposing objectives → ${observeRepos.join(", ")})`);
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
			// Sweep the finished agent's uncommitted work into a commit before the orchestrator reads its
			// HEAD. `runProof` refuses a dirty worktree and nothing else in a unit's lifecycle commits, so
			// without this every unit's verify fails and it dies at the escalate cap. It runs ahead of
			// `stateKey` (not inside `verifyAgent`) so the durable records aren't keyed to a HEAD the sweep
			// is about to replace. See `commitAgentWip`.
			settleWork: async (id) => {
				await this.commitAgentWip(id);
			},
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
			continueAgent: (id, note) => {
				// Belt-and-suspenders (RT2-A5): while a convergence loop is armed, its Stop-hook oracle already
				// owns turn-boundary reinjection — don't double-inject from the daemon side.
				if (isArmed(this.stateDir)) return Promise.resolve();
				const rec = this.agents.get(id);
				if (!rec) return Promise.resolve();
				// Recovery metric: the subsequent land verdict is already on the confidence/land ledger, so
				// recording the reprompt event is enough to correlate whether reprompted units re-pass.
				this.learningMetrics.record("veto-reprompt", 1);
				return this.promptConnected(rec, note).catch((err) => this.log("warn", `veto reprompt for ${id} failed: ${String(err)}`));
			},
			log: (m) => this.log("info", `orchestrator: ${m}`),
			persist: openOrchestratorState(this.stateDir), // OMPSQ-139: halted/landed/staged survive restart, keyed by branch
			scheduler: this.scheduler, // OMPSQ-134: drain the SAME queue create() parks into (OMP_SQUAD_QUEUE_ON_FULL)
		});
	}

	/**
	 * Degradation ladder (concern 06): the provider a prospective auto-dispatch spawn for `repo`/`issue`
	 * would resolve onto — dispatch.ts's per-issue gate. `dispatchSpawn` → `create()` never threads a
	 * per-issue model or harness today (no `profileId`, no `opts.model`: see `createWithId`), so this
	 * evaluates the SHARED `unitProviderKey` helper (the same function the `auto_retry_start` record
	 * site uses — gate key and record key cannot drift) with exactly what a dispatched spawn would
	 * declare: no model, no harness, kind "omp-operator" (intake routing's kind outcome is unknowable
	 * pre-spawn — see the helper's invariant doc). `repo`/`issue` are accepted for the `DispatchDeps`
	 * shape and future per-repo/issue differentiation; unused today since every auto-dispatched unit
	 * declares the same (empty) configuration.
	 */
	private dispatchProviderFor(_repo: string, _issue: IssueRef): string | undefined {
		return unitProviderKey({ kind: "omp-operator" });
	}

	/** Spawn a routed agent for a Plane issue — the auto-dispatch entry point (intent → process). Returns
	 *  the created DTO (concern 03: `Dispatcher.tick()` reads its `harnessScorecard` off this return value
	 *  to log a red-flag line at the moment of admission — never gates on it). */
	private async dispatchSpawn(repo: string, issue: IssueRef): Promise<AgentDTO> {
		const task = `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.name}`;
		// Materialize the AUTHORED SPEC (learn-harness-engineering "repo IS the spec"): the dispatcher
		// works off the lightweight list IssueRef, which carries only the title — the Tier-2 / plan-concern
		// body the promote-issue skill authored is otherwise discarded at dispatch. Pull it (cached,
		// best-effort, null on any failure so dispatch never blocks on Plane) and carry it on the issue;
		// createWithId fences + injects it. UNTRUSTED — see the injection site.
		const enriched = await this.dispatchSpec(repo, issue);
		return this.create({ repo, name: issue.identifier?.toLowerCase(), branch: planeIssueBranch(issue), task, issue: enriched, autoRoute: true, approvalMode: "yolo", requires: issue.requires, owns: issue.owns, produces: issue.produces, scopeSource: issue.scopeSource });
	}

	/** Best-effort enrich an issue with its authored spec body for context injection. Never throws;
	 *  returns the issue unchanged when the body is unavailable (title-only fallback). */
	private async dispatchSpec(repo: string, issue: IssueRef): Promise<IssueRef> {
		if (issue.description) return issue;
		try {
			const detail = await fetchIssueDetail(repo, issue.id);
			const body = detail?.body?.trim();
			if (!body) return issue;
			const cap = envInt("OMP_SQUAD_SPEC_MAX_CHARS", 4000);
			const spec = body.length > cap ? `${body.slice(0, cap)}\n…(spec truncated at ${cap} chars)` : body;
			return { ...issue, description: spec };
		} catch {
			return issue;
		}
	}

	/**
	 * Stale-issue guard for the Dispatcher (visual-plan-blocks incident): true when the issue's plan
	 * concern is already closed in the repo's checked-out tree, so the open Plane issue is drift, not
	 * work. Two probes, cheapest first:
	 *   1. plan-doc paths embedded in the issue name (plan-to-plane issue names carry them verbatim) —
	 *      this catches issues filed WITHOUT a PLANE: backlink in the doc;
	 *   2. a concern whose PLANE: pointer names this issue's identifier.
	 * On a hit, also close the Plane issue (best-effort, closeOnDone-gated like closeLandedIssue) so
	 * the drift heals instead of being re-skipped forever.
	 */
	async issueAlreadyDone(repo: string, issue: IssueRef): Promise<boolean> {
		let closedRef: string | undefined;
		for (const ref of planDocRefs(issue.name)) {
			const status = await concernDocStatus(repo, ref);
			if (status && isClosedConcernStatus(status)) {
				closedRef = `${ref} (STATUS: ${status})`;
				break;
			}
		}
		if (!closedRef && issue.identifier) {
			outer: for (const planDir of await listPlanDirs(repo).catch(() => [])) {
				for (const concern of await parsePlanConcerns(repo, planDir.dir).catch(() => [])) {
					if (concern.planeId === issue.identifier && !concern.open) {
						closedRef = `${concern.path} (STATUS: ${concern.status})`;
						break outer;
					}
				}
			}
		}
		if (!closedRef) return false;
		this.log("warn", `stale issue ${issue.identifier ?? issue.id}: ${closedRef} is already closed — skipping dispatch`);
		if (this.closeOnDone && !this.closedIssues.has(issue.id)) {
			// Skip-dispatch above stays proofless (gating it would re-open PR #18's stale-re-dispatch
			// incident); only this direct closePlaneIssue write requires a recorded DoneProof. A doc
			// terminal from before this wave shipped (grandfathered) has no ledger entry — its close is
			// suppressed and surfaced, never silently written, but dispatch remains skipped either way.
			const proof = issue.identifier ? getDoneProofByIssue(this.stateDir, issue.identifier) : undefined;
			if (!proof) {
				this.log("warn", `terminal-without-proof: ${issue.identifier ?? issue.id} is doc-closed but has no DoneProof — NOT closing in Plane (dispatch still skipped)`);
				void this.recordAudit(LOCAL_ACTOR, "close.suppressed-unproven", issue.identifier ?? issue.id, "error", `doc says ${closedRef} but no DoneProof exists`);
			} else if (proof.verified === "unverified") {
				// Same tri-state authorization as closeLandedIssue (finding #11): a doc-closed concern whose
				// only DoneProof is an out-of-band, never-re-verified merge is not auto-closed here either —
				// this path has no branch/rec context to route a full attention-lane escalation, so it
				// surfaces via the audit log only (still never silent).
				this.log("warn", `terminal-with-unverified-proof: ${issue.identifier ?? issue.id} is doc-closed but its DoneProof was never re-verified by this daemon's own gate (out-of-band merge) — NOT auto-closing in Plane (dispatch still skipped)`);
				void this.recordAudit(LOCAL_ACTOR, "close.suppressed-unverified", issue.identifier ?? issue.id, "error", `doc says ${closedRef} but DoneProof.verified="unverified" (out-of-band merge, not re-checked)`);
			} else if (await closePlaneIssue(issue)) {
				this.closedIssues.add(issue.id);
			} else {
				this.log("warn", `could not close stale issue ${issue.identifier ?? issue.id}`);
			}
		}
		return true;
	}

	/** Start (or return the existing) agent advancing a Plane issue — the web "Start task" action. */
	async startTask(repo: string, issue: IssueRef, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		const existing = [...this.agents.values()].find((r) => r.dto.issue?.id === issue.id);
		if (existing) return existing.dto;
		const task = `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.name}`;
		return this.create({ repo, name: issue.identifier?.toLowerCase(), branch: planeIssueBranch(issue), task, issue, autoRoute: true, approvalMode: "yolo" }, actor);
	}

	async stop(): Promise<void> {
		// Flush any in-flight pending-persist debounce (concern 04) so a graceful shutdown never loses the
		// ≤1s window — only an actual crash can. The persist() call below already serializes the flushed
		// snapshot through the normal write chain.
		for (const t of this.pendingPersistTimers.values()) clearTimeout(t);
		this.pendingPersistTimers.clear();
		clearInterval(this.pollTimer);
		this.dispatcher?.stop();
		this.orchestrator?.stop();
		for (const o of this.observers) o.stop();
		for (const t of this.planSyncTimers.splice(0)) clearInterval(t);
		clearInterval(this.prReconcileTimer);
		clearTimeout(this.prReconcileStaggerTimer);
		for (const s of this.scouts.values()) s.stop();
		for (const o of this.opportunities) o.stop();
		for (const p of this.residentPlanners) p.stop();
		clearInterval(this.leaseGossipTimer);
		await this.persist();
		// Best-effort timeline marker (#lifecycle-truth finding 4 / DESIGN's "a best-effort daemon-stop
		// entry in stop()") — a graceful shutdown DETACHES agents (below), it does not actually stop them,
		// so this is a same-state note for the transitions timeline ("supervision paused here"), not a
		// status change. Never allowed to block shutdown.
		for (const r of this.agents.values()) {
			try {
				this.transition(r, r.dto.status, "daemon-stop");
			} catch (err) {
				this.log("warn", `daemon-stop transition record failed for ${r.dto.name}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
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

	/** On daemon start, reattach to any agent whose detached host survived (upgrade/restart).
	 *
	 *  Two passes, not one: a workflow's live parallel-branch children are ordinary (non-"workflow")
	 *  snapshot entries and can appear ANYWHERE in `snapshot.agents`, including after their parent. If a
	 *  workflow parent's `attachExisting` (which reconciles + resumes the graph — see its own comment)
	 *  ran before all of that parent's children were reattached, a fresh deterministic re-spawn from the
	 *  resumed fan-out could claim a child's id before the later loop iteration reattaches the still-live
	 *  old host under that same id — two agents racing one worktree. Attaching every non-workflow agent
	 *  first closes that race: by the time a workflow parent's `attachExisting` runs, every live branch
	 *  child it could reconcile against is already in `this.agents`. */
	private async reconnectLive(snapshot: StateSnapshot): Promise<number> {
		this.capabilityStore = normalizeCapabilitySnapshot(snapshot.capabilities);
		for (const f of snapshot.features) this.featureStore.set(f.id, f);
		let n = 0;
		const workflows: PersistedAgent[] = [];
		for (const p of snapshot.agents) {
			if (this.agents.has(p.id)) continue;
			// rm-doesn't-stick fix: an explicitly-removed id must never come back, live host or not.
			if (this.removedLedger.has(p.id)) continue;
			if (p.kind === "flue-service") continue; // flue workers are not reattached
			if (p.kind === "workflow") {
				workflows.push(p);
				continue;
			}
			if (!(await hostAlive(socketPathFor(p.id)))) continue;
			await this.attachExisting(p, snapshot.transcripts[p.id] ?? []).catch((err) => this.log("warn", `reattach ${p.name} failed: ${String(err)}`));
			n++;
		}
		for (const p of workflows) {
			// rm-doesn't-stick fix: this is the actual resurrection mechanism the live incident traced —
			// a terminal-marked (CATASTROPHE) workflow is reattached BELOW unconditionally, verbatim id, no
			// hostAlive gate on the record itself. Without this check an explicit `rm` of a stuck/escalated
			// unit reappears on the very next org eviction+recreate cycle in DB-root mode.
			if (this.removedLedger.has(p.id)) continue;
			// A terminal-marked run is reattached as an INERT roster entry (no driver connection, no
			// execRun) regardless of whether its inner thread happens to still be alive — the marker must
			// survive every restart so it stays visible/forkable (the concern's own goal) instead of being
			// silently dropped by persistNow's full-snapshot replace the moment this boot persists anything.
			// If its inner thread somehow survived, it is explicitly shut down here rather than left for
			// reapOrphans: once this id is back in `this.agents`, reapOrphanHosts treats `<id>-wf` as
			// OWNED by a live id and would never reap it on its own, leaking the process forever.
			if (p.workflowState?.terminal) {
				if (await hostAlive(socketPathFor(`${p.id}-wf`))) {
					this.log("warn", `workflow ${p.name} is terminal-marked (${p.workflowState.terminal.reason}) — shutting down its surviving inner thread, not auto-resuming`);
					await shutdownHost(socketPathFor(`${p.id}-wf`)).catch(() => {});
				}
				this.reattachTerminal(p, snapshot.transcripts[p.id] ?? []);
				continue;
			}
			// A non-terminal workflow run survives a restart only if its inner thread is still alive AND we
			// have a checkpoint to resume the graph from; otherwise the orchestration is unrecoverable.
			const innerAlive = await hostAlive(socketPathFor(`${p.id}-wf`));
			if (innerAlive && p.workflowState) {
				await this.attachExisting(p, snapshot.transcripts[p.id] ?? []).catch((err) => this.log("warn", `resume ${p.name} failed: ${String(err)}`));
				n++;
			} else if (innerAlive) {
				this.log("warn", `workflow ${p.name} has a live thread but no checkpoint — cannot resume the graph`);
			}
		}
		if (n) this.log("info", `reattached ${n} live agent(s)`);
		return n;
	}

	/** After live reattach + orphan reap: take over persisted agents whose host is gone but whose worktree
	 *  still holds built-up context — re-create them in place (idle; the orchestrator then verifies/lands).
	 *  So a restart RESUMES the issue with its context instead of re-dispatching a fresh worktree. */
	private async adoptOrphanedAgents(snapshot: StateSnapshot): Promise<number> {
		const halted = openOrchestratorState(this.stateDir);
		// Terminal-marked runs are excluded: re-adopting one would re-trip the same escalate condition and
		// burn a ceiling slot every restart (the boot-loop this marker exists to kill). It stays visible via
		// its sticky catastrophe error; the operator's only forward path is fork. The PRIMARY exclusion is
		// `reconnectLive`'s `reattachTerminal`, called before this method runs — every terminal-marked
		// workflow is already back in `this.agents` by now, so `agentsToAdopt`'s `!rosterIds.has(p.id)`
		// filter drops it from `eligible` before this predicate ever runs. `resumable()`'s own `!terminal`
		// check is a defensive backstop, not the load-bearing guard.
		const resumable = (p: PersistedAgent): boolean => p.kind === "workflow" && p.workflowState !== undefined && !p.workflowState.terminal;
		// Eligible = adoptable (dead host, on-disk worktree, not a branch child) AND not a branch the
		// orchestrator already halted (re-adopting a halted run burns a ceiling slot + a resume attempt
		// before the orchestrator re-skips it).
		// rm-doesn't-stick fix: an explicitly-removed id's worktree can still be sitting on disk (rm
		// without --delete-worktree) — never let a fresh adopt bring the tombstoned id back.
		const eligible = agentsToAdopt(
			snapshot.agents.filter((p) => !this.removedLedger.has(p.id)),
			new Set(this.agents.keys()),
			(wt) => existsSync(wt),
		)
			.filter((p) => !(p.branch && halted.isHalted(p.branch)))
			// Concern 07: a non-resumable harness (ACP — direct spawn, no detached host) can't be adopted;
			// re-spawning would mint a fresh session that loses the prior one. Drop it rather than orphan-respawn.
			.filter((p) => this.harnessResumable(p));
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
				// Restore the original system prompt (tool grants / profile memory / fabric primer) on both
				// fresh-id resume paths. It was dropped, so a resumed unit's child spawned with NO
				// --append-system-prompt and silently lost its capability scoping. For profiled units
				// createWithId re-prepends profile.memory+toolGrants (the persisted value is already-composed)
				// — cosmetic, idempotent content, no behavioral effect; non-profiled fleet units compose cleanly.
				appendSystemPrompt: p.appendSystemPrompt,
				issue: p.issue,
				parentId: p.parentId,
				...lineageFieldsFrom(p),
				// Restore the harness lineage so a cold-adopted/restored pi or ACP unit keeps its harness
				// instead of silently reverting to omp (audit finding — the warm path was already safe).
				...harnessFieldsFrom(p),
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
				// Completion-push arm survives orphan-adoption too — a voice-dispatched agent that produced
				// real work, went idle, and never got its push before the daemon restarted still owes it
				// under its freshly-minted post-adopt id (see createWithId's own comment on this field).
				voicePushArmed: p.voicePushArmed,
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
			})
				.then(async (dto) => {
					n++;
					// The fresh id create() minted has a dead RPC correlation for anything p carried — close it,
					// never restore it (concern 04: RT2-5, restored:true is internally contradictory).
					// Called UNCONDITIONALLY (not gated on p.pending?.length) — closeOrphanedPending itself now
					// unconditionally stitches the cause.priorId lineage entry too (#lifecycle-truth finding 4:
					// previously that only happened inside the pending-close loop, so the common no-pending
					// adopt never recorded lineage and followLineage's crash-spanning stitch never fired for it).
					await this.closeOrphanedPending(dto.id, p);
					// Give the cold-adopted plain unit its prior context back (surfacing only, no auto-prompt).
					await this.surfaceResumeDigest(dto.id, p);
				})
				.catch((err) => this.log("warn", `take over ${p.name} failed: ${String(err)}`));
		}
		if (n || skipped) this.log("info", `took over ${n} orphaned worktree(s) with work; skipped ${skipped} (done/clean or over the ${hardAgentCeiling()}-agent cap)`);
		return n;
	}

	/** Surface a resumed unit's prior-session digest as a fenced system transcript entry — the same
	 *  "surfacing only, never auto-prompt the live agent (no silent spend)" treatment restart() gives
	 *  (see there). Both fresh-id resume paths (adoptOrphanedAgents above, the restore loop in
	 *  loadPersisted) mint a NEW agent id from a PersistedAgent, so the digest — written during the
	 *  original run under p.id (writeDigest keys by the run-time dto.id) — is read under the OLD id,
	 *  never the new dto.id. Plain units only: a resuming workflow re-executes its checkpointed node
	 *  and carries its own rollup, so it needs no prose digest injected. Best-effort — the whole body
	 *  is caught (an unhandled rejection detached from the boot sequence would crash the Bun daemon). */
	private async surfaceResumeDigest(newId: string, p: PersistedAgent): Promise<void> {
		if (p.kind === "workflow") return;
		try {
			const rec = this.agents.get(newId);
			if (!rec) return;
			const digest = await readDigest(this.stateDir, p.id);
			if (!digest) return;
			this.append(rec, "system", "📒 Resume digest — prior session memory:\n" + fenceUntrusted("resume digest", digest));
			this.emitAgent(rec);
		} catch (err) {
			this.log("warn", `resume digest surface for ${p.name} failed: ${String(err)}`);
		}
	}

	/** A cold-adopted agent's persisted pending can never be legitimately answered (fresh id, dead RPC
	 *  correlation) — record its closure so the operator sees "this agent was waiting on you before the
	 *  crash" without a permanently-unanswerable entry in dto.pending. If the resumed workflow's checkpoint
	 *  shows the same gate will re-ask, mark it reask-expected so the operator isn't alarmed by what's
	 *  actually a normal re-prompt. Reuses the "pending-cancel" DerivedReason for the per-question close
	 *  (rather than a new TransitionReason) — the distinguishing detail lives in `cause`, matching how
	 *  `catastrophe` carries its detail in `cause.error` instead of a new reason per catastrophe flavor.
	 *  Called from both the cold-adopt path (adoptOrphanedAgents, above) and the plain `--restore` path
	 *  (loadPersisted, below) — both mint a fresh agent id from a PersistedAgent, so both can leak a stale
	 *  pending the same way, and both need the lineage stitch below regardless of pending.
	 *
	 *  Called UNCONDITIONALLY now (#lifecycle-truth finding 4) — every call records an "adopted"
	 *  cause.priorId entry FIRST, even when there is nothing to close, so followLineage's crash-spanning
	 *  timeline stitch works for the common no-pending adopt too. Previously the lineage entry only fired
	 *  from inside the pending-close loop below, gated on `persisted.pending?.length`, leaving "adopted"
	 *  effectively dead code for the far more common clean-adopt case. */
	private async closeOrphanedPending(newAgentId: string, persisted: PersistedAgent): Promise<void> {
		const rec = this.agents.get(newAgentId);
		if (!rec) return;
		// Same-state (rec.dto.status -> itself), event-class reason — recorded per the recording-semantics
		// rule (a same-state EXPLICIT-reason call always records; only same-state "turn-progress" is a
		// silent no-op), so this always lands in the ledger regardless of pending.
		this.transition(rec, rec.dto.status, "adopted", { priorId: persisted.id });
		// Seed this agent's own error-transition history from the prior id's entries still sitting in the
		// already-hydrated in-memory ring (#lifecycle-truth finding 9) — cheap (a linear scan over the
		// ≤500-entry ring, no extra disk I/O) since the ring is already loaded at construction; a
		// cold-adopt's fresh id must not reset a genuinely flapping agent's errorTransitions1h to zero.
		rec.errorTransitionTimestamps = this.transitionLog
			.recent()
			.filter((e) => e.agentId === persisted.id && e.to === "error" && (e.reason === "fail" || e.reason === "catastrophe" || e.reason === "exit-error"))
			.map((e) => e.at);
		rec.dto.errorTransitions1h = this.countErrorTransitions1h(rec);
		const reaskExpected = persisted.kind === "workflow" && persisted.workflowState !== undefined && (await this.gateWillReask(persisted));
		for (const p of persisted.pending ?? []) {
			this.transition(rec, rec.dto.status, "pending-cancel", {
				priorId: persisted.id,
				question: redact(p.title + (p.message ? `: ${p.message}` : "")),
				reaskExpected,
			});
			this.append(rec, "system", `⛔ prior question orphaned by adoption${reaskExpected ? " (workflow will re-ask)" : ""}: ${redact(p.title)}`, { pending: { requestId: p.id, action: "cancelled" } });
		}
	}

	/** Read-only check: will resuming this persisted workflow re-present the SAME human gate the operator
	 *  was already asked (so the orphan-close note shouldn't alarm them as an unrelated new question)?
	 *
	 *  Deviation from the plan's literal snippet: the plan named `GATE_FOLD_VAR` (actually defined in
	 *  src/workflow/executor.ts, not engine.ts/types.ts as guessed) as the marker to inspect, but that var
	 *  means the OPPOSITE of what's needed here — it is set once a gate has ALREADY resolved, to fold the
	 *  reviewer's comments into the next agent turn, and says nothing about whether a not-yet-answered gate
	 *  will re-ask. The engine-verified signal for "will re-ask" is structural instead: `WorkflowEngine.run()`'s
	 *  entry checkpoint (engine.ts:101) sets `currentNode` to a `human`-kind node's own id ONLY while it is
	 *  about to call `executor.humanGate()` for it (i.e. before resolution); the exit checkpoint (engine.ts:125)
	 *  immediately advances `currentNode` past it the instant it's answered. So `currentNode` pointing at a
	 *  `human` node in the persisted checkpoint is exactly "resuming this graph will re-ask this gate".
	 *  Best-effort: any read/parse failure (missing graph file, malformed DOT) answers `false` rather than
	 *  throwing — this only feeds an advisory transcript note, never a workflow-engine decision. */
	private async gateWillReask(persisted: PersistedAgent): Promise<boolean> {
		const graphPath = persisted.workflow?.path;
		const currentNode = persisted.workflowState?.currentNode;
		if (!graphPath || !currentNode) return false;
		try {
			const wf = parseWorkflow(await fs.readFile(graphPath, "utf8"));
			return wf.nodes.get(currentNode)?.kind === "human";
		} catch {
			return false;
		}
	}

	/** Does a persisted (pre-adoption) agent still have local work to resume — uncommitted edits or commits
	 *  ahead of base? Mirrors agentHasUnlandedWork for a record not yet in the roster.
	 *  DoneProof is consulted before the arithmetic (same proof-first idiom as agentHasUnlandedWork /
	 *  observer.ts's hasDoneProof), gated on `proofCoversTip` so a follow-up commit pushed after the
	 *  proof was recorded falls back to the arithmetic instead of being permanently invisible: a
	 *  squash/rebase merge landed out-of-band while the daemon was down would otherwise permanently
	 *  re-adopt an already-landed branch as "has work" on every restart. */
	protected async persistedHasWork(p: { repo: string; branch?: string; worktree?: string }): Promise<boolean> {
		if (!p.worktree) return false;
		const st = await worktreeStatus(p.worktree).catch(() => ({ branch: undefined, dirtyFiles: [] as string[] }));
		if (st.dirtyFiles.length > 0) return true;
		if (!p.branch) return false;
		const proof = getDoneProofByBranch(this.stateDir, p.branch);
		if (proof && (await proofCoversTip(proof, p.branch, p.repo))) return false;
		// Routed through the shared `aheadOfBase` primitive (not a bespoke `HEAD..branch` rev-list) so
		// squash/rebase-merged persisted branches are judged the same origin-aware way as every other
		// "still ahead?" check in the codebase, per land-mode.ts's ONE-primitive intent.
		const ahead = await this.computeAheadOfBaseFor({ repo: p.repo, branch: p.branch, cwd: p.repo });
		// -1 ⇒ the git read failed and we genuinely don't know whether this persisted agent still has
		// work — assume it DOES. The cost of a false positive is one wasted resume/acceptance run; the
		// cost of a false negative (treating a fault as "clean") is permanently dropping the agent's
		// work on the floor, unresumed. See aheadOfBase's doc comment in land-mode.ts.
		return aheadUnknown(ahead) || ahead > 0;
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
			executionRole: p.executionRole,
			parentId: p.parentId,
			...lineageFieldsFrom(p),
			featureId: p.featureId,
			owns: p.owns,
			requires: p.requires,
			produces: p.produces,
			scopeSource: p.scopeSource,
			workflow: p.workflow,
			workflowState: p.workflowState,
			promoted: p.promoted, // a promoted console chat stays visibly a unit across restarts
			// Recomputed from the persisted marker (not carried as an independent flag) so a fresh boot's
			// reattach reflects forkAvailable correctly even if it was never set in-memory before the restart.
			forkAvailable: this.deriveForkAvailable(p.workflowState),
		};
		this.seedAuthority(dto, p.autonomyMode);
		const agent = this.makeDriver(p);
		const rec: AgentRecord = { dto, agent, options: p, harness: this.harnessFor(p), transcript, assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
		// Reseed the fresh tracker from persisted history BEFORE wiring, so a reconnect starts warm instead
		// of empty — otherwise the first live frame for an already-known subagent id would look like a brand
		// new node (defaulted fields) and the next flush's merge would drop everything the frame didn't carry.
		if (p.subagents?.length) rec.subs.applySnapshot(p.subagents);
		dto.messageCount = transcript.length;
		this.agents.set(p.id, rec);
		this.wire(rec);
		this.emitAgent(rec);
		// Settle gate (replay-phantom-transition fix): the agent-host replays up to 4000 ring frames on
		// reconnect, across however many socket reads that takes, re-emitting event/ui frames from inside
		// (and, for a slow/chunked replay, well after) `agent.start()`'s own await chain. Without
		// suppression each replayed frame would pump a phantom transition into history on every daemon
		// restart. transition()/setPending() apply state changes but record nothing, and
		// maybeAutoSupervise is suppressed, while this agent's id is in both `reattached` and `settling` —
		// `reattached` is seeded here (before start(), not after) specifically so transition()'s
		// suppression check is already armed for the frames replayed synchronously inside start() itself.
		this.settling.add(p.id);
		this.reattached.add(p.id);
		// Armed BEFORE agent.start() — see armReplayCompleteWaiter's own comment for why arming after
		// start() resolves would miss a marker delivered inside start()'s first socket read.
		const replaySettled = this.armReplayCompleteWaiter(p.id);
		// A WARM reattach (this path) still re-runs the graph from its checkpoint the instant `agent.start()`
		// resolves — WorkflowDriver.start() fires `execRun` off `resumeState` unconditionally, `cold` only
		// changes whether the in-flight node re-executes on a fresh inner thread. So a mid-fan-out checkpoint
		// resumed here re-enters `runParallel` exactly like the cold/adopt path does, and needs the same
		// stop-stale-branch-ids reconciliation first — otherwise the re-spawn collides with (or races) a
		// branch child `reconnectLive` already reattached under the very same deterministic id. Safe to call
		// unconditionally on every reattach: it no-ops unless `currentNode` is actually a parallel fork
		// (reconcileParallelResume's own early-return). reconnectLive's two-pass ordering guarantees every
		// live branch child is already in `this.agents` by the time a workflow parent gets here.
		if (p.kind === "workflow" && p.workflowState) await this.reconcileParallelResume(p);
		try {
			await agent.start();
			await this.drainOneTick(); // cheap floor: let a purely-synchronous burst land even for a driver that never sends a marker at all
			await replaySettled.promise; // the real settle point: the replay-completion marker, or the timeout fallback for an old agent-host
			this.settling.delete(p.id);
			this.transition(rec, this.derive(rec), "reattach"); // ONE synthetic entry now that settling is off — derive() assigns via transition(), never a raw write
		} catch (err) {
			// Runs on the failure path too (host died between the hostAlive() probe and connect, or the
			// RPC handshake rejected): both callers swallow the rejection with .catch(log) and leave `rec`
			// in `this.agents`. Two bugs this branch fixes (#lifecycle-truth findings 1 & 3):
			//  (1) previously the `finally` block derived a non-terminal status here (pending=[],
			//      streaming=false, status="starting" derives to "idle") and the thrown error was
			//      swallowed by both callers' .catch(log) — a failed reattach landed as a healthy-looking
			//      "idle" agent with a dead driver, indistinguishable from a real idle agent on the dashboard.
			//  (3) the raw `rec.dto.status = this.derive(rec)` write immediately before transition() made
			//      every recorded "reattach" entry from===to by construction — a third raw-write site the
			//      enforcement test had to whitelist attachExisting for.
			// Also: without closing the settle window here, this id would stay in `settling` forever,
			// permanently disabling maybeAutoSupervise and silencing transition()'s ledger for it.
			replaySettled.cancel(); // start() rejected — the marker (or a timeout wait for one) can never help now
			this.settling.delete(p.id);
			this.transition(rec, "error", "reattach", { error: `reattach failed: ${err instanceof Error ? err.message : String(err)}` });
			this.emitAgent(rec);
			throw err;
		}
		this.emitAgent(rec);
	}

	/**
	 * Reattach a terminal-marked workflow's PersistedAgent as an INERT roster entry: visible with its
	 * sticky catastrophe error and `forkAvailable` derived from the marker, but never given a live driver
	 * connection — no `agent.start()`, no `execRun`, no resume of any kind. This is the load-bearing half
	 * of D1's "never overwrite a checkpointed workflow into oblivion" for terminal runs specifically:
	 * once `p.id` is back in `this.agents`, persistNow's `live` snapshot (built from `this.agents.values()`
	 * every time) carries `rec.options` — the same PersistedAgent, terminal marker intact — through every
	 * subsequent persist for the rest of the daemon's life, instead of the full-snapshot replace silently
	 * dropping a never-rostered record the first time anything else triggers a persist. It also makes the
	 * run reachable via `this.agents.get(id)`, which both `restart()` (already guards terminal — refuses
	 * and points at fork) and concern 04's `fork()` require.
	 *
	 * Reuses `markCatastrophe` to (re-)derive the sticky "error" status + `CATASTROPHE:` message from the
	 * persisted `terminal.reason` — the exact channel `handleWorkflowTerminal` used the first time this run
	 * escalated — so a fresh boot reconstructs the same operator-visible signal from the marker alone.
	 */
	private reattachTerminal(p: PersistedAgent, transcript: TranscriptEntry[] = []): void {
		const subs = new SubagentTracker();
		// Topology review finding 3: this is the fourth boot path that reseeds persisted subagents
		// (create()'s restore reseed, restart(), and loadPersisted's --restore already closeNonTerminal
		// — see the create() reseed above) but this record gets NO live driver connection at all, ever
		// (that's the whole point of "terminal-marked ⇒ inert"). A subagent left "running" in the
		// persisted snapshot would otherwise claim that forever with no run left alive to ever close it.
		if (p.subagents?.length) {
			subs.applySnapshot(p.subagents);
			subs.closeNonTerminal();
			if (subs.isDirty()) {
				p.subagents = mergeSubagents(p.subagents, subs.snapshot());
				subs.clearDirty();
			}
		}
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
			messageCount: transcript.length,
			issue: p.issue,
			kind: p.kind ?? "omp-operator",
			executionRole: p.executionRole,
			parentId: p.parentId,
			...lineageFieldsFrom(p),
			featureId: p.featureId,
			owns: p.owns,
			requires: p.requires,
			produces: p.produces,
			scopeSource: p.scopeSource,
			workflow: p.workflow,
			workflowState: p.workflowState,
			promoted: p.promoted, // a promoted console chat stays visibly a unit across restarts
			forkAvailable: this.deriveForkAvailable(p.workflowState),
		};
		this.seedAuthority(dto, p.autonomyMode);
		const agent = this.makeDriver(p); // constructed but never started — this record has no live connection
		// Review finding 9: transcript threaded through (was hardcoded `[]`) — a terminal run's history is
		// exactly what the operator needs to decide whether to fork, and `attachExisting` already does this.
		const rec: AgentRecord = { dto, agent, options: p, harness: this.harnessFor(p), transcript, assistantBuf: "", thinkingBuf: "", streaming: false, subs, toolEntries: new Map() };
		this.agents.set(p.id, rec);
		this.wire(rec); // no-op until/unless something ever starts `agent`, which this path never does
		this.markCatastrophe(p.id, p.workflowState!.terminal!.reason);
	}

	list(): AgentDTO[] {
		return [...this.agents.values()].map((r) => r.dto);
	}

	/**
	 * Denominator honesty (Epic 6 concern 02): the merge-rate denominator population, anchored on the
	 * durable dispatched-unit roster rather than land receipts (a unit that dies before `finalizeRun`
	 * never appends a receipt, so a receipts-based count structurally excludes the worst failures).
	 * Every unit in `this.agents` survived its own `create()`'s `persist()` — including one killed a
	 * moment later — so it stays a denominator member (a failure, if it never lands) unless
	 * `isLandingUnit` says its kind/role/mode never lands by design (concern 05 consumes this to
	 * compute `landed / landingRoster().length`).
	 */
	landingRoster(): AgentDTO[] {
		return landingRosterOf(this.list());
	}

	/**
	 * The `landingRoster()` population enriched with each unit's routing decision + model — concern
	 * 05's task-class matrix denominator. `routing` (`{mode, tier}`, concern 03) lives on the durable
	 * `PersistedAgent` (`rec.options`), NOT on `AgentDTO` — it was deliberately never added to the
	 * wire-facing DTO (a field only this one server-side aggregator needs isn't worth touching the
	 * five `AgentDTO` literal construction sites in this already load-bearing file for). Same
	 * membership as `landingRoster()` (filters `isLandingUnit` on the same `dto`), just read from the
	 * record's stored options instead of the DTO. A unit dispatched before routing existed, or via a
	 * path that never stamped it, falls back to `{mode:"unknown", tier:"unknown"}` — it still counts
	 * in the denominator (that's the whole point of C02), just bucketed honestly as unrouted rather
	 * than silently dropped.
	 */
	landingRosterRouting(): { agentId: string; taskClass: { mode: string; tier: string }; model?: string }[] {
		return [...this.agents.values()]
			.filter((r) => isLandingUnit(r.dto))
			.map((r) => ({
				agentId: r.dto.id,
				taskClass: { mode: r.options.routing?.mode ?? "unknown", tier: r.options.routing?.tier ?? "unknown" },
				model: r.dto.model,
			}));
	}

	getTranscript(id: string): TranscriptEntry[] {
		return this.agents.get(id)?.transcript ?? [];
	}

	/** Transcript delta (`seq > since`) — what a polling client (the cockpit conversation pane,
	 *  fleet-ide-intervention I01) reads to avoid refetching the whole transcript each poll. */
	getTranscriptSince(id: string, since: number): TranscriptEntry[] {
		return transcriptSince(this.getTranscript(id), since);
	}

	getAgent(id: string): AgentDTO | undefined {
		return this.agents.get(id)?.dto;
	}

	/** Merge order (base → override): repo catalog (`.glance/profiles.json`, sanitized — see
	 *  loadRepoProfiles) ← env `OMP_SQUAD_PROFILES` (override by id) ← installed capability profiles.
	 *  `repo` is optional so the repo-less callers (the `/api/profiles` picker, which has no cwd in
	 *  scope) keep today's env+capability-only behavior; create() always passes `opts.repo`. */
	profiles(repo?: string): AgentProfile[] {
		const repoProfiles = repo ? loadRepoProfiles(repo) : [];
		const envProfiles = profileOptionsFromEnv();
		const envIds = new Set(envProfiles.map((p) => p.id));
		const merged = [...repoProfiles.filter((p) => !envIds.has(p.id)), ...envProfiles];
		const mergedIds = new Set(merged.map((p) => p.id));
		const installed = capabilityProfiles(this.capabilityStore).filter((p) => !mergedIds.has(p.id));
		return [...merged, ...installed];
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

	private profileFor(id: string | undefined, repo?: string): AgentProfile | undefined {
		if (!id) return undefined;
		return this.profiles(repo).find((p) => p.id === id);
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
			repo: normalizeRepoPath(opts.repo) || process.cwd(),
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

	/** The single read contract for subagent lineage: persisted history merged with the live tracker, live
	 *  wins per id (mergeSubagents — see subagents.ts). `rec.subs.list()` here returns full untruncated live
	 *  text; `rec.options.subagents`/`rec.dto.subagents` carry the truncated `snapshot()` projection written
	 *  at the last flush, so a currently-tracked node is always full-fidelity and only a node the live
	 *  tracker has forgotten (should not happen outside restart()'s clear, which flushes first) falls back to
	 *  the truncated persisted text. */
	subagents(id: string): SubagentNode[] {
		const rec = this.agents.get(id);
		if (!rec) return [];
		return mergeSubagents(rec.options.subagents, rec.subs.list());
	}

	/** True if this agent was reattached to a surviving host (vs freshly spawned this run). */
	wasReattached(id: string): boolean {
		return this.reattached.has(id);
	}

	/**
	 * The command-center's top level: every repo this operator works in, with live rollups.
	 *
	 * The union of three sources, because any one alone lies:
	 *   - the durable REGISTRY (`project-registry.ts`) — repos the operator explicitly added;
	 *   - repos with LIVE AGENTS — a `glance add <repo>` that was never registered still shows up;
	 *   - repos with PERSISTED FEATURES — work that outlives the agent that was doing it.
	 *
	 * This used to be live agents ONLY, which meant a project existed exactly as long as it had a
	 * running agent. Observed on the operator's daemon: `/api/projects` returned only `omp-squad`
	 * seconds after lunarpup's last agent was reaped, so lunarpup — the daemon's own cwd, holding two
	 * persisted features — disappeared from the sidebar entirely, then reappeared when an agent
	 * respawned. A project blinking in and out with the roster is the "system lies about state" class,
	 * at the top level of the UI.
	 *
	 * `registered` distinguishes "I asked for this repo" from "this repo happens to have work in it",
	 * so the UI can offer to un-register the former without pretending it can hide the latter.
	 */
	projects(): ProjectDTO[] {
		const byRepo = new Map<string, ProjectDTO>();
		const ensure = (repo: string): ProjectDTO => {
			const key = normalizeRepoPath(repo);
			let p = byRepo.get(key);
			if (!p) {
				p = { id: key, name: path.basename(key) || key, repo: key, agentCount: 0, statusCounts: {}, pendingCount: 0, lastActivity: 0, featureCount: 0, registered: false };
				byRepo.set(key, p);
			}
			return p;
		};

		for (const repo of this.projectRegistry.list()) ensure(repo).registered = true;
		for (const pf of this.featureStore.values()) if (pf.repo) ensure(pf.repo).featureCount++;
		for (const { dto } of this.agents.values()) {
			const p = ensure(dto.repo);
			p.agentCount++;
			p.statusCounts[dto.status] = (p.statusCounts[dto.status] ?? 0) + 1;
			p.pendingCount += dto.pending.length;
			p.lastActivity = Math.max(p.lastActivity, dto.lastActivity);
		}
		// Busiest first, then a stable alphabetical tail so idle registered projects don't shuffle.
		return [...byRepo.values()].sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
	}

	/**
	 * Register a repo as a project. Validated, not trusted: an absolute path to a real git worktree.
	 *
	 * This path is where the daemon will later create worktrees and spawn agents, so a relative path is
	 * REFUSED rather than resolved against the daemon's cwd — that cwd is an accident of how the
	 * operator launched it (this daemon runs from `~/lunarpup` while its code lives elsewhere), and
	 * silently resolving against it is how you register the wrong tree.
	 */
	async registerProject(repo: string, opts: { promoteEphemeral?: boolean } = {}): Promise<{ ok: true; repo: string; added: boolean } | { ok: false; reason: string }> {
		const raw = normalizeRepoPath(repo ?? "");
		if (!raw) return { ok: false, reason: "repo is required" };
		if (!path.isAbsolute(raw)) return { ok: false, reason: `repo must be an absolute path (got "${raw}")` };
		if (!existsSync(raw)) return { ok: false, reason: `no such directory: ${raw}` };

		// Canonicalize to the repo ROOT, through symlinks. `isGitRepo` is true for any directory INSIDE a
		// repo (it shells `rev-parse --show-toplevel` and only falls back to a `.git` probe), so registering
		// `/repo/src` — or a symlink to `/repo` — used to mint a project whose id matched no agent's
		// `dto.repo` and no feature's `repo`: the workspace showed two rows for one repository and the
		// task↔project join missed. Found by cross-lineage review (grok-4.5).
		let root: string;
		try {
			root = normalizeRepoPath(await repoRoot(await fs.realpath(raw)));
		} catch {
			return { ok: false, reason: `not a git repository: ${raw}` };
		}

		// Never register anything inside glance's OWN data directory.
		//
		// A glance worktree is a git repo too, and its lifetime belongs to an agent, not the operator. But
		// the sharper reason is tenancy: per-org managers put their worktrees under
		// `<stateRoot>/orgs/<orgId>/worktrees` (manager-registry.ts), while `worktreeBase()` only names the
		// ROOT manager's `<stateRoot>/worktrees`. Guarding the latter alone let one org's admin register
		// ANOTHER org's managed worktree — and registration widens the viewer-readable `/api/graph*`
		// allowlist (`resolveGraphRepo`), whose `/api/graph/commit` returns source diffs. That is a
		// cross-tenant read, not a role bypass. Refusing the whole state root closes every variant at once:
		// orgs/*/worktrees, the root worktrees dir, proof/, receipts/, and anything added later.
		// Found by cross-lineage review (gpt-5.6-sol).
		const forbidden = [resolveStateDir(), worktreeBase(), this.stateDir].map(normalizeRepoPath);
		const inside = forbidden.find((base) => base.length > 0 && (root === base || root.startsWith(`${base}${path.sep}`)));
		if (inside) {
			return { ok: false, reason: `${root} is inside glance's own state directory (${inside}) — register the source repository instead` };
		}

		const outcome = this.projectRegistry.add(root);
		if (outcome === "error") return { ok: false, reason: `could not persist the project registry — ${root} was NOT added` };
		if (outcome === "added") this.log("info", `project registered: ${root}`);
		// An explicit durable registration of a repo a live `glance here` session registered only for its
		// lifetime is a PROMOTION ("keep it") — clear the session-scoped marker so end-of-session release
		// no longer silently un-registers what the operator just asked to keep. Idempotent add ⇒ this is the
		// exact case `add()` returns "exists" for. clearEphemeralMarker is a no-op when the repo was never
		// ephemeral, so it's safe unconditionally on this explicit path. registerEphemeralProject's own
		// delegated call passes no opts, so a fresh session registration never promotes itself.
		if (opts.promoteEphemeral) this.clearEphemeralMarker(root);
		this.emitFeaturesChanged();
		return { ok: true, repo: root, added: outcome === "added" };
	}

	/** Un-register a repo. Deletes NOTHING on disk; a repo with live agents or features keeps listing. */
	unregisterProject(repo: string): { ok: true; repo: string; removed: boolean } | { ok: false; reason: string } {
		const key = normalizeRepoPath(repo ?? "");
		const outcome = this.projectRegistry.delete(key);
		if (outcome === "error") return { ok: false, reason: `could not persist the project registry — ${key} was NOT removed` };
		if (outcome === "removed") this.log("info", `project un-registered: ${key}`);
		this.emitFeaturesChanged();
		return { ok: true, repo: key, removed: outcome === "removed" };
	}

	/**
	 * Repos registered only for the lifetime of a `glance here` session (daily-onramp 02). Persisted as
	 * a sidecar (`ephemeral-projects.json`, loaded in the constructor) BECAUSE the registration it must
	 * undo is durable: the first cut kept this set in-memory only, so a daemon restart mid-session lost
	 * the marker while the `projects.json` row survived — every restart silently promoted a
	 * session-scoped registration to a permanent, admin-gated one (fail-open; blind-review finding).
	 * `start()` reconciles the reloaded markers against the restored roster: a session that survived the
	 * restart (concern 04) keeps its marker for the ordinary end-of-session hooks; a session that died
	 * with the old daemon is reaped at boot. Keys are the canonical repo roots `registerProject`
	 * returns — the same key `projects()` groups by.
	 */
	private readonly ephemeralProjects: Set<string>;

	/** Drop a repo's session-scoped marker (promote / release) and persist the shrunken sidecar. A
	 *  failed sidecar write here is self-healing: boot reconciliation drops markers whose repo is no
	 *  longer registered, and re-releasing an already-durable repo is a no-op by design. */
	private clearEphemeralMarker(repo: string): void {
		if (this.ephemeralProjects.delete(normalizeRepoPath(repo))) {
			writeEphemeralProjects(this.stateDir, this.ephemeralProjects);
		}
	}

	/**
	 * Boot reconciliation for the reloaded ephemeral markers — runs in start() AFTER the roster is
	 * restored (reconnectLive/adoptOrphanedAgents), so it can tell surviving sessions from dead ones:
	 *   - marker whose repo still has a live agent → the session outlived the restart (concern 04);
	 *     keep the marker so the ordinary session-end hooks (release route, `remove()`) still undo it;
	 *   - marker whose repo has NO live agent → the session died with the old daemon; un-register now.
	 *     This is the restart leak the sidecar exists to close;
	 *   - marker whose repo is no longer registered at all → stale (released after a failed sidecar
	 *     write, or the operator removed the project); just drop it.
	 * A failed un-register keeps its marker so the NEXT boot retries — never drop the undo obligation
	 * on an error.
	 */
	private reconcileEphemeralProjects(): void {
		if (this.ephemeralProjects.size === 0) return;
		const liveRepos = new Set([...this.agents.values()].map((r) => normalizeRepoPath(r.options.repo)));
		let dirty = false;
		for (const repo of [...this.ephemeralProjects]) {
			if (liveRepos.has(repo)) continue;
			if (this.projectRegistry.has(repo)) {
				const dropped = this.unregisterProject(repo);
				if (!dropped.ok) {
					this.log("warn", `could not reap ephemeral project ${repo} at boot (${dropped.reason}) — marker kept for the next attempt`);
					continue;
				}
				this.log("info", `ephemeral project reaped at boot (its session did not survive the restart): ${repo}`);
			}
			this.ephemeralProjects.delete(repo);
			dirty = true;
		}
		if (dirty) writeEphemeralProjects(this.stateDir, this.ephemeralProjects);
	}

	/** Test/observability read: is this repo's registration session-scoped right now? */
	isEphemeralProject(repo: string): boolean {
		return this.ephemeralProjects.has(normalizeRepoPath(repo ?? ""));
	}

	/**
	 * Register a repo for the lifetime of a casual session: same validation and durable write as
	 * `registerProject`, plus a marker so session end can undo it. Only a repo THIS call actually ADDED
	 * becomes ephemeral — a repo the operator had already registered durably must never be silently
	 * un-registered when a passing `glance here` session ends (`add()` is idempotent, so `added:false`
	 * is exactly that case).
	 */
	async registerEphemeralProject(repo: string): Promise<{ ok: true; repo: string; added: boolean; ephemeral: boolean } | { ok: false; reason: string }> {
		const result = await this.registerProject(repo);
		if (!result.ok) return result;
		if (result.added) {
			this.ephemeralProjects.add(result.repo);
			// The registration this marker must undo is already durable — a marker that exists only in
			// memory would not survive a restart, silently promoting the session-scoped registration to
			// permanent. Fail CLOSED: no durable marker ⇒ no ephemeral registration at all.
			if (!writeEphemeralProjects(this.stateDir, this.ephemeralProjects)) {
				this.ephemeralProjects.delete(result.repo);
				const rollback = this.unregisterProject(result.repo);
				return {
					ok: false,
					reason: rollback.ok
						? `could not persist the ephemeral session marker for ${result.repo} — the registration was rolled back`
						: `could not persist the ephemeral session marker for ${result.repo} AND the rollback failed (${rollback.reason}) — the repo is now durably registered; un-register it explicitly`,
				};
			}
		}
		return { ...result, ephemeral: this.ephemeralProjects.has(result.repo) };
	}

	/**
	 * Undo an ephemeral registration on ordinary session end (REPL exit, or the daemon's own removal
	 * path — see `remove()`). No-op for repos that were never session-scoped, so callers can fire it
	 * unconditionally. Deletes nothing on disk, per `unregisterProject`'s own contract.
	 */
	releaseEphemeralProject(repo: string): { ok: boolean; repo: string; released: boolean; reason?: string } {
		const key = normalizeRepoPath(repo ?? "");
		if (!this.ephemeralProjects.has(key)) return { ok: true, repo: key, released: false };
		const dropped = this.unregisterProject(key);
		if (!dropped.ok) return { ok: false, repo: key, released: false, reason: dropped.reason };
		this.clearEphemeralMarker(key);
		return { ok: true, repo: key, released: true };
	}

	/** Feature view: persisted features + derived plan-dir/agent features with live land status, per repo. */
	async features(repo?: string): Promise<FeatureDTO[]> {
		const list = this.list();
		const persisted = [...this.featureStore.values()];
		// Include the configured Plane repos so the planner shows a project (repo) + its plan-dir features
		// even before any agent runs — otherwise a fresh daemon (0 agents) renders an empty planner.
		const repos = repo !== undefined ? [repo] : [...new Set([...list.map((a) => a.repo), ...persisted.map((f) => f.repo), ...planeRepos()])];
		const out: FeatureDTO[] = [];
		for (const r of repos) out.push(...(await buildFeatures(r, list.filter((a) => a.repo === r), persisted, this.operator.id)));
		for (const feature of out) feature.planRevisionCandidates = await this.listPlanRevisionCandidates({ repo: feature.repo, featureId: feature.id });
		return out;
	}

	/** The single operator identity this manager acts as (`db:<userId>`-style base actor in DB mode,
	 *  `LOCAL_ACTOR.id` in file mode) — the default assignee for features created here. */
	get operatorId(): string {
		return this.operator.id;
	}

	createFeature(opts: { title: string; repo: string; planDir?: string; stageOverride?: FeatureStage; author?: string }): PersistedFeature {
		const id = `feat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const now = Date.now();
		// Seed the human assignee list so the vote substrate is never A=0: the creating author (a
		// real `db:<userId>` in DB mode) when known, else this manager's operator identity.
		// Store the SAME normalized key `projects()` groups by. A feature persisted as "/srv/app/" used to
		// live under project "/srv/app" in the UI while every server-side `pf.repo !== repo` comparison
		// missed it — TaskDetail's pipeline 404s, and project scoping drops the task. (gpt-5.6-sol)
		const pf: PersistedFeature = { id, title: opts.title.trim() || "feature", repo: normalizeRepoPath(opts.repo), stageOverride: opts.stageOverride, origin: opts.planDir ? { planDir: opts.planDir } : undefined, assignees: [opts.author ?? this.operator.id], createdAt: now, updatedAt: now };
		this.featureStore.set(id, pf);
		this.emitFeaturesChanged();
		return pf;
	}

	/** Spawn a research-plan-implement workflow agent and wrap it in a feature whose stage tracks the live run. */
	async createAutoFeature(opts: { title: string; repo: string; goal: string; model?: string; author?: string }): Promise<{ feature: PersistedFeature; agent: AgentDTO }> {
		const pf = this.createFeature({ title: opts.title, repo: opts.repo, author: opts.author });
		const name = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || undefined;
		const agent = await this.create({ repo: opts.repo, name, workflow: "research-plan-implement", task: opts.goal, featureId: pf.id, approvalMode: "yolo", model: opts.model });
		pf.workflowAgentId = agent.id;
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return { feature: pf, agent };
	}

	/**
	 * Atomically append one agent-captured decision to a feature, resolving the feature the SAME way
	 * updateFeature does (adopting a plan-derived feature that isn't yet persisted — so capture works
	 * for exactly the plan-driven agents it targets, not just already-adopted features). Reads the
	 * feature's CURRENT decisions at write time and appends in one synchronous step — no stale
	 * read-modify-write over a client snapshot, so concurrent agent captures can't clobber each other.
	 * De-dupes on normalized text. Returns the outcome so the caller can tell the agent what happened.
	 */
	async recordAgentDecision(featureId: string, decision: FeatureDecision, repo?: string): Promise<"recorded" | "duplicate" | "no-feature"> {
		const pf = this.featureStore.get(featureId) ?? (await this.adoptDerivedFeature(featureId, repo));
		if (!pf) return "no-feature";
		const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
		const target = norm(decision.text);
		const existing = pf.decisions ?? [];
		if (existing.some((d) => norm(d.text) === target)) return "duplicate";
		pf.decisions = [...existing, decision];
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return "recorded";
	}

	async updateFeature(id: string, patch: { title?: string; stageOverride?: FeatureStage | null; category?: FeatureCategory | null; archived?: boolean; repo?: string; description?: string; acceptanceCriteria?: FeatureCriterion[]; decisions?: FeatureDecision[]; relationships?: FeatureRelationship[]; contextBundle?: PersistedFeature["contextBundle"] }): Promise<PersistedFeature | undefined> {
		const pf = this.featureStore.get(id) ?? await this.adoptDerivedFeature(id, patch.repo);
		if (!pf) return undefined;
		const wasArchived = !!pf.archived;
		if (patch.title !== undefined) pf.title = patch.title;
		if (patch.stageOverride !== undefined) pf.stageOverride = patch.stageOverride ?? undefined;
		if (patch.category !== undefined) pf.category = patch.category ?? undefined;
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
	 * The human assignees for a feature (the vote substrate). Reads the derived DTO so it works for
	 * BOTH persisted and plan-dir/agent-derived features without forcing an adopt-on-read — a legacy
	 * persisted feature with no stored value surfaces the defaulted `[operator]` here. Returns
	 * `undefined` only when no such feature exists.
	 */
	async featureAssignees(id: string, repo?: string): Promise<string[] | undefined> {
		const f = (await this.features(repo)).find((x) => x.id === id);
		return f ? f.assignees : undefined;
	}

	/**
	 * Replace a feature's human assignees (the vote substrate). Resolves the feature the SAME way
	 * updateFeature does — adopting a plan-derived feature that isn't yet persisted — so it works for
	 * exactly the features the board shows. Membership/identity VALIDATION is the caller's job (the
	 * server checks DB-mode ids against the org roster, file-mode against the operator identity);
	 * this is pure storage. De-dupes while preserving order. Returns the feature, or undefined if
	 * none resolves.
	 */
	async setAssignees(id: string, assignees: string[], repo?: string): Promise<PersistedFeature | undefined> {
		const pf = this.featureStore.get(id) ?? (await this.adoptDerivedFeature(id, repo));
		if (!pf) return undefined;
		pf.assignees = [...new Set(assignees)];
		pf.updatedAt = Date.now();
		this.emitFeaturesChanged();
		return pf;
	}

	/**
	 * Edit one concern of a feature's plan from the flow diagram: rewrite its STATUS and/or the
	 * concerns that block it, persisting to the concern doc + overview dependency table. Works for
	 * stored AND derived (plan-dir-scanned) features — it resolves the feature via features().
	 *
	 * This is the human-override lane: a status write here is deliberately NOT gated on a DoneProof
	 * (the flow-diagram editor is exactly where an operator asserts truth the ledger doesn't have yet).
	 * It gains an audit record instead, so the write is visible rather than invisible.
	 */
	async updateConcern(id: string, opts: { repo?: string; file: string; status?: string; blockedBy?: number[] }, actor: Actor = LOCAL_ACTOR): Promise<PlanConcern | undefined> {
		const f = (await this.features(opts.repo)).find((x) => x.id === id);
		if (!f || !f.planDir) return undefined;
		const concern = await updatePlanConcern(f.repo, f.planDir, opts.file, { status: opts.status, blockedBy: opts.blockedBy });
		if (concern) {
			this.emitFeaturesChanged();
			if (opts.status != null) void this.recordAudit(actor, "concern.status", opts.file, "ok", `-> ${opts.status} (operator/webapp edit, no land proof required)`);
		}
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
			// The derived DTO already carries a defaulted assignee list (buildFeatures seeds it to
			// [operator]); persist it verbatim so adoption doesn't reset the vote substrate.
			assignees: found.assignees.length ? found.assignees : [this.operator.id],
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
			// Reroute through the SAME mode-dispatching seam land() uses (concern 06) — landFeature used
			// to call landAgent directly here, which meant PR mode would keep local-merging every
			// multi-branch feature land regardless of the resolved mode (the "two worlds inside the
			// daemon" hole). Issue fields thread through so PR mode's DoneProof/PendingPr ledger entries
			// are retrievable by issue identifier, same as the single-agent path.
			const res = await this.landBranch({
				repo: pf.repo,
				worktree: w.worktree,
				branch: w.branch,
				message: `feature(${pf.title}): land ${w.branch ?? "changes"}`,
				commitWip: !busy,
				requireProof: !force,
				staleGate: !force,
				riskOverride: force, // human force-land clears the blast-radius gate too (C-LAND)
				verify: pf.acceptance ?? undefined,
				issueId: rec?.dto.issue?.id,
				issueIdentifier: rec?.dto.issue?.identifier,
				issueProjectId: rec?.dto.issue?.projectId,
				agentId: w.agentId,
				featureId: id,
			});
			results.push({ agentId: w.agentId, branch: w.branch, ok: res.ok, detail: res.detail });
			// Forced member land without a passing proof gate — audit the override per branch.
			if (res.forcedWithoutProof) {
				recordForcedLand(this.stateDir, w.branch, actor.id, `${reason ? `${reason}: ` : ""}${res.detail ?? ""}`);
				void this.store.appendAudit({ actor: actor.id, action: "land.forced-unproven", target: id, detail: { branch: w.branch, reason, at: Date.now() } }).catch(() => {});
			}
			if (res.mode === "pr" && rec) {
				rec.dto.prUrl = res.prUrl;
				rec.dto.prNumber = res.prNumber;
				rec.dto.prState = res.prState;
				this.emitAgent(rec);
			}
			if (!res.ok) { this.emitFeaturesChanged(); void this.recordAudit(LOCAL_ACTOR, "land", id, "error", `feature land failed on ${w.branch}`); void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land", target: id, detail: { outcome: "error", branch: w.branch } }).catch(() => {}); return { ok: false, stopped: `land failed on ${w.branch}`, results }; }
			if (res.merged) {
				// PR mode already wrote its own (richer) DoneProof inside landAgentPr — only the local
				// path needs one written here, mirroring land()'s manager-layer write.
				if (res.mode !== "pr") {
					recordDoneProof(this.stateDir, {
						branch: w.branch ?? "",
						repo: repoIdentity(pf.repo),
						issueId: rec?.dto.issue?.id,
						issueIdentifier: rec?.dto.issue?.identifier,
						mode: "local",
						commit: w.branch ? await headCommit(w.worktree) : "",
						baseRef: "HEAD",
						verified: res.detail?.includes("landed onto a red baseline") ? "red-baseline" : "green",
						detail: res.detail ?? "",
						provenAt: Date.now(),
					});
				}
				void this.closeLandedIssue(rec?.dto.issue, { branch: w.branch, repo: pf.repo }); // real merge ⇒ close its tracking issue (idempotent)
			}
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
	async land(id: string, message?: string, opts: { auto?: boolean; force?: boolean; actor?: Actor; reason?: string; validatorOverride?: { reasonClass: string } } = {}): Promise<LandResult> {
		const rec = this.agents.get(id);
		if (!rec) return { ok: false, committed: false, merged: false, message: "no such agent", detail: "no such agent" };
		const dto = rec.dto;
		// An OBSERVER never lands. `is-landing-unit.ts` reads exactly like this rule, but it is only a
		// metrics DENOMINATOR ("don't count a missing land against a unit that never lands by design") —
		// no land path ever consulted it. I assumed it was a gate while building `glance ask`, and it was
		// not: an answer unit runs with `--approval yolo` in a worktree whose origin is the operator's real
		// repo, so nothing but a prompt ("do not edit") stood between an answer and a merge. `--force`
		// does not open this door either; refusing to land a unit that was never supposed to produce a
		// commit is not a safety valve an operator should be able to talk their way past.
		if (rec.options.executionRole === "observer" || rec.options.ask) {
			return { ok: false, committed: false, merged: false, message: "observer never lands", detail: `${dto.name} is an answer/observer unit — its deliverable is a report, not a branch` };
		}
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
		// Epic 5 propose-only ENFORCEMENT (review SIGNIFICANT). The leaf-03 cap set effectiveMode="assist"
		// and stripped "land" from availableActions, but those gate ONLY the UI land-ready row + operator
		// verify — the AUTONOMOUS land path (autoLandWorkflow and the orchestrator's landAgentWork, both
		// via `land(id)` with auto:true) never consulted them, so a sub-floor run got auto-merged anyway,
		// silently bypassing the operator's configured brake. Hold it here instead: proof is already
		// GREEN (proofGate passed above), so this is a genuine "verified but low-confidence" state —
		// stage it for a one-tap operator Land (staged ⇒ the orchestrator HOLDS, never parks/fails; a
		// hold is not a land failure, so it must return BEFORE recordLandOutcome below). An OPERATOR land
		// (auto:false) deliberately bypasses this: explicitly clicking Land in assist mode IS the intended
		// propose-only approval flow. A force land also bypasses (an explicit human override).
		if (auto && !opts.force && this.confidenceBelowFloor(dto)) {
			rec.dto.landReady = true;
			this.emitAgent(rec);
			this.floatPrOnLandReady(rec);
			this.log("info", `auto-land held for ${dto.name}: confidence ${dto.confidence?.toFixed(2)} below floor ${confidenceFloor()} — awaiting operator approval (propose-only)`);
			void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land.held-low-confidence", target: id, detail: { confidence: dto.confidence, floor: confidenceFloor() } }).catch(() => {});
			return { ok: false, committed: false, merged: false, staged: true, message: "auto-land held (low confidence)", detail: `held for operator approval: confidence ${dto.confidence?.toFixed(2)} is below the ${confidenceFloor()} floor` };
		}
		const busy = dto.status === "working" || dto.status === "starting" || dto.status === "input";
		const overrideReasonClass = opts.validatorOverride?.reasonClass?.trim();
		const result = await this.landBranch({
			repo: dto.repo,
			worktree: dto.worktree,
			branch: dto.branch,
			message: message ?? `squad(${dto.name}): land ${dto.branch ?? "changes"}`,
			commitWip: !busy,
			confirmResolved: auto && autoresolveConfirm(), // OMPSQ-138: an AUTO resolved-conflict land stages, not merges
			requireProof: !opts.force,
			staleGate: !opts.force,
			riskOverride: opts.force, // a human force-land clears the blast-radius gate too (C-LAND)
			issueId: dto.issue?.id,
			issueIdentifier: dto.issue?.identifier,
			issueProjectId: dto.issue?.projectId,
			agentId: dto.id,
			featureId: dto.featureId,
			validatorOverride: !!overrideReasonClass,
		});
		// Validator-override audit (Epic 3, leaf 03): a real veto was bypassed by an explicit,
		// non-empty reason class — a STRONGER act than a proof-force, logged separately (never folded
		// into recordForcedLand). A reasonClass supplied on a land the gate never vetoed records nothing
		// (there was no veto to override).
		if (overrideReasonClass && rec.dto.validation?.verdict === "veto") {
			const overrideActor = opts.actor ?? LOCAL_ACTOR;
			recordValidatorOverride(this.stateDir, dto.branch, overrideActor.id, overrideReasonClass, rec.dto.validation.rationale || "validator override");
			void this.recordAudit(overrideActor, "land", id, "ok", `validator override (${overrideReasonClass})`);
			void this.store.appendAudit({ actor: overrideActor.id, action: "land.validator-override", target: id, detail: { reasonClass: overrideReasonClass } }).catch(() => {});
		}
		// PR-mode metadata (concern 06): set directly on the dto at push/merge time, the same pattern
		// `landReady` already uses. Absent (mode !== "pr") ⇒ local mode, untouched.
		if (result.mode === "pr") {
			rec.dto.prUrl = result.prUrl;
			rec.dto.prNumber = result.prNumber;
			rec.dto.prState = result.prState;
			this.emitAgent(rec);
		}
		// Staged (OMPSQ-138): the conflict was auto-resolved but held for a one-tap Land. Not a failure
		// (never bump the fail streak) and not landed — surface the ready-to-land flag and return.
		if (result.staged) {
			rec.dto.landReady = true;
			this.emitAgent(rec);
			this.log("info", `land-confirm: ${id} auto-resolved a conflict — ready to land`);
			this.floatPrOnLandReady(rec);
			return result;
		}
		// Effective-model fix (Epic 6 concern 06, carried forward from the C05 review): `dto.model` is
		// undefined ("unknown") for a dispatched fleet unit — nothing back-stamps it — so reading
		// `dto.model` here would key BOTH the model-outcome ledger below and the C05 row-write further
		// down on an all-"unknown" model axis. Hoisted above both write sites (previously the row-write
		// alone did this fetch, a few lines further down) so the ledger `shiftedModel`/C06's router reads
		// is keyed on the SAME real effective model as the row. Gated on `!result.retryable` — the
		// precondition common to both write sites below — so a retryable refusal never pays for a
		// receipts read it doesn't need.
		const lastReceipt = !result.retryable ? (await readReceipts(this.stateDir, dto.id)).at(-1) : undefined;
		const effectiveModel = lastReceipt?.model ?? dto.model;
		// Update the branch's failure streak: an auto-land failure bumps it (drives the cap above), any
		// success clears it. A manual (auto:false) failure is the operator's call — never penalized.
		// A retryable refusal (dirty main checkout) is an environmental precondition, not a branch failure —
		// never bump the streak for it, else transient dirty windows park a healthy branch.
		if (!result.retryable && (auto || result.ok)) {
			// Any non-retryable outcome (landed OR rejected) closes the branch's blocked EPISODE: the next
			// retryable refusal is a genuinely new "attempted, couldn't land cleanly" fact, not a repeat.
			this.landBlockedEpisode.delete(`${dto.repo}::${dto.branch ?? ""}`);
			// Bounded-escalation state closes with the same episode (finding #2): a branch that lands or
			// gets a genuine rejection starts the NEXT retryable episode's attempt count from zero.
			this.landBlockedAttempts.delete(`${dto.repo}::${dto.branch ?? ""}`);
			this.landBlockedEscalated.delete(`${dto.repo}::${dto.branch ?? ""}`);
			recordLandOutcome(this.stateDir, dto.branch, result.ok, result.detail ?? result.message);
			// Model-outcome ledger (Epic 6 concern 06): a cheap, always-on statistic — like land-ledger
			// itself — so concern 07's default-shift has data on day one even before it's turned on.
			// Never gates the land above; purely record-only, after the outcome is already known.
			try {
				recordModelOutcome(this.stateDir, effectiveModel, tierOf(rec.options.thinking), result.ok);
				this.learningMetrics.record("model-outcome-recorded", 1, { flag: "model-outcomes", variant: learningFlags(dto.id).modelOutcomes });
			} catch (err) {
				this.log("warn", `model-outcomes record failed for ${dto.name} (non-fatal): ${errText(err)}`);
			}
			// Confidence-threshold tuner (Epic 6 concern 08): record the SAME land outcome against this
			// run's Epic 5 confidence score. `dto.confidence` is undefined for a run that never finished a
			// turn (e.g. re-adopted/direct land) — recordConfidenceOutcome treats that as no evidence, never
			// a penalty. Recording is unconditional (cheap, like model-outcomes); only the READ (confidenceFloor
			// above) is flag-gated, so the tuner has data from day one even before it's turned on.
			try {
				recordConfidenceOutcome(this.stateDir, envNumber("OMP_SQUAD_CONFIDENCE_FLOOR", 0.4), dto.confidence, result.ok);
			} catch (err) {
				this.log("warn", `threshold-tuner record failed for ${dto.name} (non-fatal): ${errText(err)}`);
			}
			// Membrane breaker cadence (eap-borrows concern 05 / DESIGN.md "Membrane measurement" — the
			// real, not ceremonial, auto-disable red-team B M3 required): the SAME threshold-tuner cadence
			// above — once per non-retryable land outcome — but only when THIS land actually contributes new
			// flagged-cohort evidence (rec.efficiencyFlags carries a CONFIRMED-delivered membrane:* token;
			// see receipts.ts#confirmDeliveredFlags) and the discipline is armed at all. A healthy fleet with
			// the flag off pays nothing. Fire-and-forget: membraneBreakerCadence walks the whole fleet's
			// receipts + task-outcomes (not O(1)), so it must never delay `land()`'s own completion, and a
			// failure here must never fail the land it's grading — mirrors every other non-fatal ledger write
			// in this block.
			if (membraneProfilesEnabled() && rec.efficiencyFlags?.some((f) => f.startsWith(EFFICIENCY_FLAG_PREFIX))) {
				const flaggedTaskClass = { mode: rec.options.routing?.mode ?? "unknown", tier: rec.options.routing?.tier ?? "unknown" };
				const unitId = rec.dto.id;
				// finding #4: re-resolve liveness at CALLBACK time, not closure-capture time — this cadence
				// call is fire-and-forget and may resolve well after `unitId` is reaped off `this.agents`
				// (a reap racing the async I/O). Passing the stale `rec` reference in that case would attach
				// the attention event to a detached DTO no client's roster still contains; pass `undefined`
				// instead so `fileMembraneBreakerFinding` skips the pointless attention-lane write and relies
				// on its unconditional automation-channel write, which is the whole point of that dual-write.
				const liveRec = () => this.agents.get(unitId);
				void membraneBreakerCadence(this.stateDir, this.landingRosterRouting(), flaggedTaskClass, {
					// eap-borrows follow-up (concern 01 DESIGN decision 4): this cadence call is also the one
					// live site that selects+persists a taskClass's baseline (baseline-tracker.ts). Route a
					// rotted baseline through the SAME escalation `fileMembraneBreakerFinding` uses below — a
					// silently-rotting baseline is exactly this repo's signature failure mode.
					onStaleness: (event) => this.fileMembraneBreakerFinding(liveRec(), dto.repo, event),
				})
					.then((event) => {
						if (event) this.fileMembraneBreakerFinding(liveRec(), dto.repo, event);
					})
					.catch((err) => this.log("warn", `membrane-breaker cadence check failed for ${dto.name} (non-fatal): ${errText(err)}`));
			}
		} else if (result.retryable) {
			// research-sirvir/01-recording-unlock (part 2, durable fix): a retryable/environmental refusal
			// (dominantly a dirty main checkout — a human-editing-the-shared-checkout precondition, not a
			// branch defect) previously skipped this WHOLE block, including the "cheap, always-on"
			// model-outcome statistic above — so a fleet that rarely reaches a clean land recorded NOTHING,
			// not even a failure, and every learning ledger looked empty rather than "blocked". Decoupled:
			// record the attempt in its own `blocked` bucket (model-outcomes.ts), distinct from
			// landed/rejected, so the ledger reflects "attempted, couldn't land cleanly" WITHOUT polluting
			// land-rate — a dirty main isn't the model's fault, and landed/rejected readers (smart-spawn's
			// outcome-driven default, attribution-scoreboard, cost-gate) must see the SAME numbers as
			// before this fix. `dto.model` (not `effectiveModel`) here — the receipts read above is
			// skipped on a retryable result on purpose (comment above), and this statistic doesn't need
			// the precision fix-up that keying the router's routing-quality read does.
			//
			// EDGE-TRIGGERED (review): the orchestrator retries a retryable land every ~30s tick, so an
			// unconditional increment would make `blocked` a tick-rate artifact (120/hr/agent on a
			// persistently dirty main), not an episode count. One increment per
			// (repo, branch, headSha, reasonClass) episode: a new commit on the branch or a different
			// refusal reason opens a new episode; the non-retryable arm above closes it. In-memory ⇒ a
			// daemon restart re-records at most once per still-live episode (acceptable).
			const blockDetail = result.detail ?? result.message;
			const reasonClass = blockDetail.includes("uncommitted tracked changes") ? "dirty-main" : "retryable";
			const episodeScope = `${dto.repo}::${dto.branch ?? ""}`;
			const headSha = await headCommit(dto.worktree).catch(() => "");
			const episode = `${headSha}::${reasonClass}`;
			const isNewEpisode = this.landBlockedEpisode.get(episodeScope) !== episode;
			if (isNewEpisode) {
				this.landBlockedEpisode.set(episodeScope, episode);
				// A new episode is a genuinely NEW problem (different commit or different refusal reason) —
				// restart the escalation budget below from zero, same rationale as the model-outcome counter.
				this.landBlockedAttempts.set(episodeScope, 0);
				this.landBlockedEscalated.delete(episodeScope);
				try {
					recordModelOutcomeBlocked(this.stateDir, dto.model, tierOf(rec.options.thinking));
					this.learningMetrics.record("model-outcome-blocked", 1, { flag: "model-outcomes", variant: learningFlags(dto.id).modelOutcomes });
				} catch (err) {
					this.log("warn", `model-outcomes blocked-record failed for ${dto.name} (non-fatal): ${errText(err)}`);
				}
			}
			// Loud surfaced state (part 2 continued): a retryable refusal must not ONLY accumulate in
			// land-failures.json (a file nobody looks at until they go forensic) — route it through the
			// automation observability channel too, the same way `fileScopeFinding` routes a scope-contract
			// finding, so /api/automation + the automation panel + factory status all see "fleet cannot
			// land" without a live daemon restart or a manual grep. Cooldown-throttled per repo condition
			// inside fileLandBlockedFinding (NOT edge-triggered like the counter above: the factory-status
			// banner needs periodic fresh rows to stay up while the condition persists).
			this.fileLandBlockedFinding(dto.repo, dto.branch, blockDetail, reasonClass);
			// Bounded escalation (finding #2, cross-lineage review): `autoLandFailCap` deliberately never
			// sees a retryable refusal (see the `!result.retryable` gate above), so absent this, a
			// persisting retryable episode retries forever at the ~30s tick cadence with nothing but a
			// cooldown-throttled log line — the exact "forever-soft interlock" pathology named by the
			// review. Count every ATTEMPT (not edge-triggered like the model-outcome stat above — the
			// budget must actually track how long the SAME episode has been stuck) and fire a "Needs you"
			// attention item, once per episode, the moment it crosses the cap.
			const attempts = (this.landBlockedAttempts.get(episodeScope) ?? 0) + 1;
			this.landBlockedAttempts.set(episodeScope, attempts);
			const cap = landBlockedEscalateCap();
			if (cap > 0 && attempts >= cap && !this.landBlockedEscalated.has(episodeScope)) {
				this.landBlockedEscalated.add(episodeScope);
				this.fileLandBlockedEscalation(rec, dto.repo, blockDetail, reasonClass, attempts);
			}
		}
		// Joined task-outcome row (Epic 6 concern 03): idempotent, agentId-keyed row joining the routing
		// decision (`rec.options.routing`) with the terminal land outcome. Deliberately a WIDER gate than
		// the block above — `!result.retryable` alone, not `!result.retryable && (auto || result.ok)` —
		// because a manual (auto:false) FAILURE is exactly the combination the narrower guard drops
		// (auto=false, result.ok=false ⇒ `(auto||result.ok)` is false), and an operator-driven land failure
		// must not be silently missing from the observability surface. A retryable refusal (dirty main,
		// etc.) is an environmental precondition, not a terminal outcome — no row for it; the roster
		// denominator (isLandingUnit) already accounts for it correctly without one. Never gates the land
		// itself; purely record-only, after the outcome is already known, same as its two siblings above.
		if (!result.retryable) {
			try {
				// Independent difficulty signals (Epic 6 concern 04) — neither is a router output, unlike
				// `routing.{mode,tier}` above, so grading the router against these is non-circular.
				// filesTouched: the confidence scorer's own blast-radius proxy (finalizeRun's
				// `scoreConfidence({ filesTouched: receipt.filesTouched.length, ... })`), read off this
				// agent's LAST finalized RunReceipt (`lastReceipt`, hoisted above alongside `effectiveModel`
				// so both this row-write and the model-outcome ledger write above key on the SAME receipt
				// read). `readReceipts` returns rows in append order, so the last entry is the most recent
				// run; its `filesTouched` is now BASE-RELATIVE (`runFilesTouched` → `filesTouchedSinceBase`),
				// spanning committed and uncommitted work alike. It used to be a bare `git status` probe,
				// resting on "nothing is committed until land()'s own commitWip" — false for any agent that
				// commits its own work, and false for every unit now that `commitAgentWip` sweeps before
				// verify. That assumption zeroed 16 of 18 rows in this host's live ledger.
				// Undefined when no run ever finalized for this agent (e.g. a re-adopted/direct land with no
				// receipt on disk) — never fabricated.
				// fixupCount: the SAME workflow-engine visit counter (`WorkflowRunState.visits.fixup`)
				// concern 01's fixups-to-green metric (recordWorkflowOutcomeMetrics above) and
				// digestReward's firstTryGreen already read. IN-RUN churn, not post-merge regression — see
				// task-outcomes.ts's module doc for why no post-merge rework signal exists in this codebase.
				const fixupCount = rec.options.workflowState?.visits?.fixup;
				await recordTaskOutcome(this.stateDir, {
					agentId: dto.id,
					branch: dto.branch,
					routing: rec.options.routing ?? { mode: "none", tier: tierOf(rec.options.thinking) },
					// Effective model from the finalized receipt (concern 01's noteModel writes the model
					// omp ACTUALLY ran onto RunReceipt.model), NOT dto.model — dispatch sets no model and
					// nothing back-stamps dto.model for a dispatched fleet unit, so bare dto.model would be
					// undefined here and collapse the whole scoreboard model axis to "unknown". Fall back to
					// dto.model only for the rare explicit-model path where no receipt landed on disk.
					model: effectiveModel,
					costUsd: dto.receipt?.costUsd,
					confidence: dto.confidence,
					validation: rec.dto.validation?.verdict,
					filesTouched: lastReceipt?.filesTouched.length,
					fixupCount,
					outcome: result.ok ? "landed" : "rejected",
					source: "land",
					ts: Date.now(),
				} satisfies TaskOutcomeRow);
			} catch (err) {
				this.log("warn", `task-outcome record failed for ${dto.name} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		// Forced land that merged WITHOUT a passing proof gate — audit it so the override is never invisible trust.
		if (result.forcedWithoutProof) {
			const forceActor = opts.actor ?? LOCAL_ACTOR;
			recordForcedLand(this.stateDir, dto.branch, forceActor.id, `${opts.reason ? `${opts.reason}: ` : ""}${result.detail ?? result.message}`);
			void this.recordAudit(forceActor, "land", id, "ok", `landed WITHOUT proof (FORCED)${opts.reason ? `: ${opts.reason}` : ""}`);
			void this.store.appendAudit({ actor: forceActor.id, action: "land.forced-unproven", target: id, detail: { branch: dto.branch, reason: opts.reason, at: Date.now() } }).catch(() => {});
		}
		if (result.ok) {
			rec.dto.landReady = false; // successful land attempt ⇒ clear the confirm-mode staged flag
			this.emitAgent(rec);
			if (result.merged) {
				// PR mode already wrote its own (richer, method/mergeCommit-aware) DoneProof inside
				// landAgentPr — writing a generic "mode: local" one here too would clobber it.
				if (result.mode !== "pr") {
					// Retrievable proof that this branch's work is now in main — the ONE artifact later
					// consumers (closeLandedIssue's proof gate, plan-sync, Observer arithmetic) can trust
					// instead of re-deriving truth from rev-list math. Best-effort, additive: never blocks land().
					// TODO: land.ts's LandResult carries no explicit tri-state flag for the red-baseline escape
					// (verifyMerged :390-414) — this substring match on its own detail wording is the only signal
					// today. If that wording ever changes, this silently stops matching and falls back to "green".
					recordDoneProof(this.stateDir, {
						branch: dto.branch ?? "",
						repo: repoIdentity(dto.repo),
						issueId: dto.issue?.id,
						issueIdentifier: dto.issue?.identifier,
						mode: "local",
						commit: dto.branch ? await headCommit(dto.worktree) : "",
						baseRef: "HEAD",
						verified: result.detail?.includes("landed onto a red baseline") ? "red-baseline" : "green",
						detail: result.detail ?? result.message,
						provenAt: Date.now(),
					});
				}
				await this.closeLandedIssue(dto.issue, { branch: dto.branch, repo: dto.repo }); // real merge ⇒ close its tracking issue (idempotent, best-effort)
			} else this.log("info", `not closing ${dto.issue?.identifier ?? dto.issue?.id ?? id}: land made no merge`);
		}
		void this.recordAudit(LOCAL_ACTOR, "land", id, result.ok ? "ok" : "error", result.detail ?? result.message);
		void this.store.appendAudit({ actor: LOCAL_ACTOR.id, action: "land", target: id, detail: { outcome: result.ok ? "ok" : "error" } }).catch(() => {});
		return result;
	}

	/**
	 * Learning-loop baseline (agentic-learning-loop concern 01): derive first-try-green / fixups-to-green
	 * / escalation from the run's already-persisted engine visit counts (`WorkflowRunState.visits`) — no
	 * new tracking, just reads what the engine already recorded. Fires for EVERY workflow_done regardless
	 * of autoLand/landConfirm mode (unlike `autoLandWorkflow`, which only fires when actually auto-landing)
	 * so the baseline stays populated even when auto-land is off. Best-effort: a metrics failure must
	 * never break run completion.
	 */
	private recordWorkflowOutcomeMetrics(rec: AgentRecord, outcome: string | undefined): void {
		try {
			const visits = rec.options.workflowState?.visits ?? {};
			const fixupVisits = visits.fixup ?? 0;
			const escalated = (visits.escalate ?? 0) > 0;
			const succeeded = outcome === "succeeded";
			// Tag with the reflexion arm — concern 04 is the one most likely to move these three numbers,
			// so this is the natural A/B slice; `learningFlags` is read fresh (per-run, per-id) like every
			// other flag check in the codebase.
			const tags = { flag: "reflexion", variant: learningFlags(rec.dto.id).reflexion };
			this.learningMetrics.record("first-try-green", isFirstTryGreen(succeeded, fixupVisits) ? 1 : 0, tags);
			if (succeeded) this.learningMetrics.record("fixups-to-green", fixupVisits, tags);
			this.learningMetrics.record("escalation", escalated ? 1 : 0, tags);
		} catch (err) {
			this.log("warn", `learning metrics record failed for ${rec.dto.name} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Recurring-failure memory (agentic-learning-loop concern 05, downscoped): annotate a land-failure
	 * streak's root cause ONCE per fingerprint, reusing concern 04's `reflect()` (no second LLM path).
	 * Idempotency lives HERE (not in the caller's timing) — a fingerprint already annotated short-
	 * circuits before ever calling `reflect()`, so a capped/retried observer tick can call this every
	 * time without spending a second LLM call. Gated behind `OMP_SQUAD_FAILURE_MEMORY` (default off).
	 */
	private async annotateRecurringFailure(repo: string, finding: Finding, branch: string): Promise<void> {
		if (!isOn(learningFlags().failureMemory)) return;
		if (failureAnnotation(this.stateDir, finding.fingerprint)) return; // already annotated — no-op
		const r = await reflect({ output: finding.detail ?? finding.title });
		if (!r) return;
		recordFailureAnnotation(this.stateDir, { fingerprint: finding.fingerprint, repo, branch, rootCause: r.rootCause, at: Date.now() });
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
		// "Ready to land" is meaningless for a unit that must never land, and it is the flag the UI's Land
		// button and `floatPrOnLandReady` both key off. (grok-4.5)
		if (rec.options.executionRole === "observer" || rec.options.ask) return;
		rec.dto.landReady = true;
		this.emitAgent(rec);
		this.log("info", `land-confirm: ${id} verified — ready to land`);
		this.floatPrOnLandReady(rec);
	}

	/**
	 * PR-mode landReady float (concern 06/DESIGN mode-dispatch ruling + the autoLand×PR matrix's
	 * "landConfirm ON (default): landReady ⇒ push+draft" row): the moment an agent is flagged
	 * ready-to-land — confirm-mode verified GREEN, or a staged auto-resolved conflict — PR mode should
	 * already have pushed the branch and opened/adopted its PR, so the badge/URL exist at landReady
	 * time instead of only appearing at merge-click. Concern 07's reconciler (`landReady && pr-mode &&
	 * no ledger entry ⇒ retry ensurePr`) is a backstop for a FAILED float, not a substitute for one that
	 * was never attempted — this is that attempt. Local mode (no `defaultBranch`) is a no-op.
	 * Fire-and-forget: never blocks flagging the agent ready; a failure here is left for the
	 * reconciler to retry from the PendingPr ledger.
	 */
	private floatPrOnLandReady(rec: AgentRecord): void {
		const dto = rec.dto;
		if (rec.options.executionRole === "observer" || rec.options.ask) return; // an answer opens no PR
		if (!dto.branch || dto.worktree === dto.repo) return; // nothing to land in PR mode
		void (async () => {
			try {
				const mode = await this.resolveLandModeFor(dto.repo);
				if (mode.mode !== "pr" || !mode.defaultBranch) return;
				const ensure = await ensurePr({
					repo: dto.repo,
					branch: dto.branch as string,
					defaultBranch: mode.defaultBranch,
					title: `squad(${dto.name}): land ${dto.branch}`,
					issueId: dto.issue?.id,
					issueIdentifier: dto.issue?.identifier,
					issueProjectId: dto.issue?.projectId,
					agentId: dto.id,
					stateDir: this.stateDir,
				});
				if (ensure.ok && ensure.prNumber !== undefined && ensure.prUrl !== undefined) {
					rec.dto.prUrl = ensure.prUrl;
					rec.dto.prNumber = ensure.prNumber;
					rec.dto.prState = ensure.prState ?? "draft";
					this.emitAgent(rec);
				} else {
					this.log("warn", `land-confirm: PR float failed for ${dto.name} (${dto.branch}): ${ensure.detail ?? "unknown"}`);
				}
			} catch (e) {
				this.log("warn", `land-confirm: PR float threw for ${dto.name} (${dto.branch}): ${e instanceof Error ? e.message : String(e)}`);
			}
		})();
	}

	/** Best-effort `git rev-parse HEAD` in a worktree — data only (no rewind behavior this slice), used to
	 *  stamp each checkpoint-log entry with the commit it was taken at. Never throws: an unreadable/gone
	 *  worktree just means the entry carries no headSha. */
	private async captureHeadSha(worktree: string): Promise<string | undefined> {
		try {
			const r = await hardenedGit(["rev-parse", "HEAD"], { cwd: worktree });
			return r.code === 0 ? r.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	/** True exactly when a workflow run has hit a persisted terminal marker that hasn't been superseded
	 *  by a fork yet — the single source `dto.forkAvailable` derives from, so it's recomputed the same
	 *  way at every reload site (checkpoint listener's workflow_terminal handler, attachExisting,
	 *  createWithId) instead of drifting between an in-memory flag and the persisted marker. */
	private deriveForkAvailable(state: WorkflowRunState | undefined): boolean {
		return !!state?.terminal && !state.terminal.supersededBy;
	}

	/** Self-heal the crash window between createInternal's persist of a new fork (which durably records
	 *  `workflowState.forkedFrom`) and fork()'s OWN later persist of the source's `terminal.supersededBy`
	 *  marker: a daemon death in that gap otherwise leaves the source stuck forever advertising
	 *  `forkAvailable: true` for an offer that can never be accepted (the `liveFork` guard in fork() sees
	 *  the already-persisted fork and refuses every subsequent attempt with "a fork of this run already
	 *  exists", while the source's own marker never gets cleared to reflect it). Called once at the end of
	 *  `start()`'s recovery sequence, after every reattach/adopt path has had a chance to put both the fork
	 *  and its source back in `this.agents` (review finding 3). */
	private reconcileForkLineage(): void {
		for (const rec of this.agents.values()) {
			const forkedFrom = rec.options.workflowState?.forkedFrom;
			if (!forkedFrom) continue;
			const source = [...this.agents.values()].find((r) => r.options.workflowState?.runId === forkedFrom.runId);
			if (!source) continue;
			const terminal = source.options.workflowState?.terminal;
			if (!terminal || terminal.supersededBy) continue;
			terminal.supersededBy = rec.dto.id;
			source.dto.forkAvailable = false;
			source.dto.workflowState = source.options.workflowState;
			this.emitAgent(source);
		}
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
		this.transition(rec, "error", "catastrophe", { error: `CATASTROPHE: ${detail}` });
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
		this.log("warn", `catastrophe: ${id} — ${detail}`);
		void this.recordAudit(LOCAL_ACTOR, "catastrophe", id, "error", truncate(detail, 120));
	}
	/**
	 * Thin, overridable wrapper around land-mode.ts's `resolveLandMode` — exists so tests can force
	 * PR/local mode deterministically without fighting `bun test`'s PROCESS-WIDE `mock.module`
	 * semantics: a different test file module-mocking `land-mode.ts` for an unrelated reason (e.g.
	 * `aheadOfBase`-isolation) permanently rebinds squad-manager.ts's own `resolveLandMode` import for
	 * the rest of the test process the moment this module is first evaluated, regardless of import
	 * order in any OTHER file. Injecting through a method sidesteps that entirely.
	 */
	protected resolveLandModeFor(repo: string): ReturnType<typeof resolveLandMode> {
		return resolveLandMode(repo);
	}

	/**
	 * Thin, overridable wrapper around land-mode.ts's `aheadOfBase` — mirrors `resolveLandModeFor`
	 * immediately above, same reason: `bun test`'s PROCESS-WIDE `mock.module` permanently rebinds
	 * every consumer's import of `land-mode.ts` the moment ANY test file module-mocks it, regardless
	 * of which file's tests run when — so a test needing `aheadOfBase`'s REAL git behavior (e.g. a
	 * PATH-shimmed git-fault repro) can silently get another file's canned mock instead. Every
	 * "unlanded work?" consumer below routes through this method (never the bare `computeAheadOfBase`
	 * import directly) so tests inject a fake ahead-count by overriding the method, never by mocking
	 * the module.
	 */
	protected computeAheadOfBaseFor(opts: { repo: string; branch: string; cwd?: string }): Promise<number> {
		return computeAheadOfBase(opts);
	}

	/**
	 * Injection seam (mirrors `resolveLandModeFor` above) so tests can supply a fake independent
	 * judge without a real `omp` binary on PATH. `undefined` ⇒ `validatorGate`'s own default judge
	 * (an independent one-shot `omp -p --model opus` call).
	 */
	protected validatorJudgeOverride(): Judge | undefined {
		return undefined;
	}

	/**
	 * Independent-validator veto (Epic 3, DESIGN §1) — runs BEFORE any mode dispatch, on every
	 * `landBranch` call INCLUDING forced lands (`requireProof:false` never skips it — a forced land
	 * bypasses the proof gate, not the semantic one). Scores the diff against the feature's declared
	 * `acceptanceCriteria` (resolved via `opts.featureId`, or `opts.criteria` directly); a real veto
	 * blocks unless `opts.validatorOverride` is set (leaf 03's logged override — read here only as a
	 * boolean-ish gate). Always stamps the resulting `ValidationRecord` onto the agent's DTO so it
	 * rides the roster broadcast and (via `finalizeRun`, leaf 04) the durable run receipt.
	 */
	private async runValidatorGate(opts: LandOpts): Promise<LandResult | undefined> {
		const pf = opts.featureId ? this.featureStore.get(opts.featureId) : undefined;
		const criteria = opts.criteria ?? pf?.acceptanceCriteria ?? [];
		const proof = await proofFor(opts.repo, opts.worktree);
		// Read the author's lineage BEFORE the gate: `dto.model` is the poll-backfilled `provider/id`
		// spec (applyState) on the common omp/pi path; `harness` is the fallback for vendor-pinned ACP
		// runtimes. Threaded so the ValidationRecord can flag a same-lineage (self-graded) review.
		const rec = opts.agentId ? this.agents.get(opts.agentId) : undefined;
		const { record, veto, inconclusive } = await validatorGate({
			criteria,
			repo: opts.repo,
			worktree: opts.worktree,
			branch: opts.branch,
			proof,
			judge: this.validatorJudgeOverride(),
			authorModel: rec?.dto.model,
			authorHarness: rec?.dto.harness,
			agentId: opts.agentId,
		});
		if (rec) {
			rec.dto.validation = record;
			this.emitAgent(rec);
		}
		// Shadow catch-log (plans/perspective-diversified-review/ concern 06): make the advisory panel's
		// output MEASURABLE — the dataset that answers "does a focused out-of-criteria lens catch what the
		// monolithic criteria judge missed?" before any pool of lenses is built. One line per verdict.
		if (record.lensAdvisory?.length) {
			for (const l of record.lensAdvisory) {
				const sev = l.disposition === "object" ? ` (${l.severity})` : "";
				const recheck = record.lensVerify ? `, re-check confirmed=${record.lensVerify.confirmed}` : "";
				this.log("info", `lens-review [${l.lens}] ${l.disposition}${sev}: ${l.claim || "—"} — unit ${rec?.dto.name ?? opts.agentId ?? "?"}, criteria verdict ${record.verdict}${recheck}`);
			}
		}
		if (veto && !opts.validatorOverride) {
			return { ok: false, committed: false, merged: false, message: opts.message, detail: veto };
		}
		// eap-borrows follow-up 7: a diff-computation FAILURE (git fault) is an ENVIRONMENTAL precondition,
		// not a branch defect — never a permanent park. `retryable: true` routes it through the exact same
		// bounded-escalation machinery every other retryable refusal already uses (landBlockedEscalateCap /
		// fileLandBlockedEscalation in the `land()` outcome-recording block below): it retries at the
		// orchestrator's ~30s cadence, never bumps the branch's fail streak, and escalates to a "Needs you"
		// attention item if the SAME episode (headSha+reasonClass) is still stuck after the cap — the same
		// safety valve that already prevents the dirty-main refusal from wedging forever. Note the
		// deliberate asymmetry with `veto` just above: a veto has `opts.validatorOverride` as a logged
		// human bypass, but `inconclusive` has none — this check runs unconditionally, so `opts.force`
		// (requireProof:false) does NOT skip it either. There is nothing for a human to override: the
		// diff itself couldn't be computed, so there's no verdict to force through. The only way out is
		// the retry lane above (or a human fixing the underlying git fault directly).
		if (inconclusive) {
			return { ok: false, committed: false, merged: false, message: opts.message, detail: inconclusive, retryable: true };
		}
		return undefined;
	}

	/**
	 * Seam over the land.ts primitive so the single-agent land path is unit-testable (inject a fake
	 * land). Also the universal mode-dispatching point (concern 06): PR mode routes through
	 * `landAgentPr` (push → ensure PR → scratch-merge gate → `gh pr merge` → assert → DoneProof), local
	 * mode is the unchanged passthrough to `landAgent`. `land()` and `landFeature()` both call this
	 * seam, so PR mode inherits proofGate/fail-cap/forced-land-audit/closeLandedIssue for free — and,
	 * as of Epic 3, so does the independent-validator veto, run once here for every land path.
	 */
	protected async landBranch(opts: LandOpts): Promise<LandResult> {
		const validatorBlocked = await this.runValidatorGate(opts);
		if (validatorBlocked) return validatorBlocked;
		const mode = await this.resolveLandModeFor(opts.repo);
		if (mode.mode === "pr") {
			if (!mode.defaultBranch) {
				// Forced PR mode (OMP_SQUAD_LAND_MODE=pr) with no resolvable default branch — refuse the
				// land LOUDLY rather than silently falling through to `landAgent` (a local merge). An
				// operator who explicitly forced PR mode never wants a "quiet" local merge as the fallback;
				// that is exactly the "wrong merge world" this env var exists to prevent.
				this.log("warn", `land refused for ${opts.repo}: ${mode.reason}`);
				return { ok: false, committed: false, merged: false, message: opts.message, detail: `forced-pr-mode-without-default-branch: ${mode.reason}` };
			}
			return landAgentPr({ ...opts, defaultBranch: mode.defaultBranch }, this.stateDir, this.automation.for("orphan-audit", opts.repo));
		}
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
			executionRole: opts.executionRole,
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
		// A repo-detected gate runs as ordered fail-fast stages (typecheck → test); a custom acceptance
		// command stays a single opaque stage (we can't safely split arbitrary shell).
		const stages = pf.acceptance ? undefined : await detectVerifyStages(pf.repo);
		const command = pf.acceptance ?? (stages?.length ? stages.map((s) => s.command).join(" && ") : undefined);
		if (!command) return { ok: false, results: [{ ok: false, detail: "no acceptance command — set the feature's acceptance or add a test script to the repo", artifacts: 0 }] };
		// Sweep every live member's uncommitted work BEFORE snapshotting tips and running the gate — the
		// feature path hits the same `runProof` dirty refusal as the single-agent path (see
		// `commitAgentWip`), and the orchestrator routes multi-agent features through here
		// (`buildOrchestrator`'s `verify` hook), not through `verifyAgent`. Missing this left the
		// interlock fully intact for every feature-mode unit. Found by cross-lineage review (grok-4.5).
		// Members that exist only as `pf.branches` rows (their agent was removed) have no status to
		// judge "busy" by and no live record — `commitAgentWip` no-ops on them, deliberately.
		for (const r of [...this.agents.values()]) if (r.dto.featureId === id) await this.commitAgentWip(r.dto.id);
		this.snapshotBranches(id);
		const members: LandMember[] = [...this.agents.values()].filter((r) => r.dto.featureId === id).map((r) => ({ agentId: r.dto.id, agentName: r.dto.name, branch: r.dto.branch, worktree: r.dto.worktree, repo: pf.repo }));
		for (const b of pf.branches ?? []) if (!members.some((m) => m.agentId === b.agentId)) members.push({ agentId: b.agentId, branch: b.branch, worktree: b.worktree, repo: pf.repo });
		// FAIL CLOSED on an empty member set: `[].every(...)` is `true`, so a feature whose agents were all
		// removed used to verify GREEN without a single gate ever running — then land nothing. A gate that
		// reports "verified" for work it never looked at is the exact failure class the regression-gate
		// fix (#123) closed on the other side. Found by cross-lineage review (gpt-5.6-sol).
		if (members.length === 0) {
			return { ok: false, command, results: [{ ok: false, detail: "no member worktrees to verify — the feature has no live agents or recorded branches", artifacts: 0 }] };
		}
		const results: { agentId?: string; branch?: string; ok: boolean; detail?: string; artifacts: number }[] = [];
		for (const m of members) {
			const proof = await runProof({ repo: pf.repo, worktree: m.worktree, command, stages });
			results.push({ agentId: m.agentId, branch: m.branch, ok: proof.ok, detail: proof.detail, artifacts: proof.artifacts.length });
		}
		this.emitFeaturesChanged();
		return { ok: results.every((r) => r.ok), command, results };
	}

	/**
	 * Cheap "has unlanded work" probe for the auto-land loop — uncommitted edits, or commits ahead
	 * of the repo's checked-out base. Gates the costly acceptance run so it never fires on an idle
	 * agent with nothing to merge.
	 *
	 * DoneProof is consulted FIRST, before any ahead-count arithmetic, mirroring observer.ts's
	 * `hasDoneProof` idiom: a squash/rebase (or out-of-band) merge makes rev-list arithmetic
	 * permanently nonzero even though the work is safely in origin/default, so a recorded proof for
	 * the branch means "no unlanded work" regardless of what the arithmetic says — but only while the
	 * proof still covers the branch's CURRENT tip (`proofCoversTip`): a follow-up commit pushed to the
	 * branch after the proof was taken must fall back to the arithmetic, not be swallowed forever.
	 * Uncommitted dirty edits are checked first regardless of proof — a proof only speaks to the
	 * committed branch tip it was recorded against, never to edits made since.
	 */
	protected async agentHasUnlandedWork(id: string): Promise<boolean> {
		const rec = this.agents.get(id);
		if (!rec?.dto.branch) return false;
		// Not "unlanded work" — an answer. Saying yes here is what invites the orchestrator to verify it,
		// sweep it, and try to land it. (grok-4.5)
		if (rec.options.executionRole === "observer" || rec.options.ask) return false;
		const st = await worktreeStatus(rec.dto.worktree).catch(() => ({ branch: undefined, dirtyFiles: [] as string[] }));
		if (st.dirtyFiles.length > 0) return true;
		const proof = getDoneProofByBranch(this.stateDir, rec.dto.branch);
		if (proof && (await proofCoversTip(proof, rec.dto.branch, rec.dto.repo))) return false;
		const ahead = await this.computeAheadOfBaseFor({ repo: rec.dto.repo, branch: rec.dto.branch, cwd: rec.dto.worktree });
		const scope = `${rec.dto.repo}::${rec.dto.branch}`;
		// -1 ⇒ the git read failed and we genuinely don't know — assume there IS unlanded work rather
		// than silently reading a transient git fault as "nothing to land". A false positive costs one
		// wasted acceptance-suite run; a false negative here is orchestrator.ts:220's `agentHasWork`
		// gate silently skipping the land for this unit, forever, with no escalation. See aheadOfBase's
		// doc comment in land-mode.ts. Bounded by `trackAheadUnknown` below: a PERSISTENT fault stops
		// re-paying for that wasted run every tick once a human has been notified, instead of thrashing
		// the acceptance suite forever (finding #1, cross-lineage review of af3d534).
		if (aheadUnknown(ahead)) return this.trackAheadUnknown(rec, scope);
		this.aheadUnknownStreak.delete(scope);
		this.aheadUnknownEscalated.delete(scope);
		return ahead > 0;
	}

	/**
	 * Bounded response to a persistent `aheadOfBase` git fault on `agentHasUnlandedWork`'s
	 * `${repo}::${branch}` scope (finding #1, cross-lineage review of af3d534). Below
	 * `aheadUnknownEscalateCap()` consecutive unknowns: preserve af3d534's original
	 * assume-work-exists polarity (a false positive costs one wasted acceptance-suite run — the
	 * existing, deliberate trade-off, unchanged). At the cap: file a ONE-TIME "Needs you" attention item
	 * naming the fault (dual-write, mirrors `fileLandBlockedEscalation`'s shape exactly) and return
	 * `false` so the orchestrator stops re-running the costly suite against a fault that hasn't changed
	 * since the last tick. This is NOT a return of the pre-fix silent skip: a human has already been
	 * told (the attention item + automation row are both live before this ever returns `false`), and
	 * `agentHasUnlandedWork`'s caller resets the streak (see above) the instant `aheadOfBase` next
	 * returns a real number for this scope — so the unit resumes automatically the moment git recovers,
	 * with no human action required for the transient case.
	 */
	private trackAheadUnknown(rec: AgentRecord, scope: string): boolean {
		const streak = (this.aheadUnknownStreak.get(scope) ?? 0) + 1;
		this.aheadUnknownStreak.set(scope, streak);
		const cap = aheadUnknownEscalateCap();
		if (cap > 0 && streak >= cap) {
			if (!this.aheadUnknownEscalated.has(scope)) {
				this.aheadUnknownEscalated.add(scope);
				this.fileAheadUnknownEscalation(rec, streak);
			}
			return false;
		}
		return true;
	}

	/**
	 * Dual-write "Needs you" escalation for a persistent `aheadOfBase` fault (finding #1, cross-lineage
	 * review of af3d534) — mirrors `fileLandBlockedEscalation`'s pattern exactly:
	 *   1. The attention lane on the live `AgentRecord` (live-pushed to any connected client).
	 *   2. The "land" automation channel, unconditionally, so /api/automation + the panel see it even if
	 *      `rec` is reaped before a client observes the attention event.
	 * Idempotent per streak via the caller's `aheadUnknownEscalated` set (this method itself doesn't
	 * dedupe). Best-effort; never throws.
	 */
	private fileAheadUnknownEscalation(rec: AgentRecord, streak: number): void {
		const summary = `aheadOfBase has returned "unknown" for ${rec.dto.branch ?? rec.dto.name} on ${streak} consecutive checks — needs a human to look`;
		const detail = `agentHasUnlandedWork(${rec.dto.id}) — repo ${rec.dto.repo}, branch ${rec.dto.branch ?? "?"}: the underlying git read (aheadOfBase) keeps failing, so the auto-land loop is holding this unit rather than re-running the acceptance suite against an unresolved fault. It resumes automatically the moment aheadOfBase next returns a real count.`;
		try {
			const event: AttentionEvent = { id: randomUUID(), summary, detail, source: "notify", createdAt: Date.now() };
			rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
			this.emitAgent(rec);
		} catch (err) {
			this.log("warn", `ahead-unknown attention-lane attach failed for ${rec.dto.name} (non-fatal): ${errText(err)}`);
		}
		try {
			this.log("warn", `${summary} — ${detail}`);
			this.automation.for("land", rec.dto.repo)({ durationMs: 0, level: "warn", detail: `${summary} — ${detail}` });
		} catch {
			/* observability must never break the land path */
		}
	}

	// ── Observer edges (OMPSQ-52) — read-only git probes + the main gate, injected into Observer. ──

	/** Commits on an agent's branch not in main (origin-aware in PR mode via `aheadOfBase`):
	 *  0 ⇒ landed; >0 ⇒ unlanded; -1 ⇒ no branch / unknown git read — test with `aheadUnknown`, never
	 *  a bare `< 0`/`=== -1`/`> 0` (see aheadOfBase's doc comment in land-mode.ts). Feeds
	 *  ObserverDeps.gitAheadOfMain — auditLandedSurvivors/auditStaleDone in observer.ts are the callers
	 *  and both branch on `aheadUnknown` explicitly. */
	protected async aheadOfMain(a: AgentDTO): Promise<number> {
		if (!a.branch) return -1;
		return this.computeAheadOfBaseFor({ repo: a.repo, branch: a.branch, cwd: a.worktree });
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

	/** Uncommitted files in an agent worktree — tracked edits plus untracked files. */
	private uncommittedInWorktree(a: AgentDTO): string[] {
		const r = hardenedGitSync(["-C", a.worktree, "status", "--porcelain"]);
		if (r.code !== 0) return [];
		return r.stdout
			.split("\n")
			.map((l) => l.slice(3).trim())
			.filter((f) => f.length > 0 && !f.startsWith(".omp/"));
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

	/**
	 * Route a retryable/environmental land refusal through the automation observability channel (the
	 * "land" loop, event-driven like "scope" above — no cadence/flag of its own): a warn-level event
	 * that persists, surfaces in /api/automation + the automation panel + factory status's landBlocked
	 * banner (research-sirvir/01-recording-unlock, part 2). The dominant cause is a dirty main checkout
	 * (land.ts's "uncommitted tracked changes" refusal) — tagged with the `dirty-main` skipReason so
	 * factory-status can surface it by name; any OTHER retryable cause (e.g. a PR-mode `gh pr merge`
	 * hiccup) still fires the event, just without that specific tag. Never blocks a land; best-effort,
	 * never throws.
	 *
	 * Cooldown-throttled per `${repo}::${reasonClass}` (review): a dirty main is ONE repo-level
	 * condition, so ten agents retrying every 30s must not write ten-agents-worth of rows to the
	 * append-only automation.jsonl. One warn per LAND_BLOCKED_WARN_COOLDOWN_MS per repo condition —
	 * deliberately BELOW factory-status's freshness window (see the constant) so a persisting refusal
	 * keeps producing fresh rollup rows and the banner never self-clears while landing is still blocked.
	 */
	private fileLandBlockedFinding(repo: string, branch: string | undefined, detail: string, reasonClass: string, now = Date.now()): void {
		try {
			const cooldownKey = `${repo}::${reasonClass}`;
			if (now - (this.landBlockedWarnAt.get(cooldownKey) ?? 0) < LAND_BLOCKED_WARN_COOLDOWN_MS) return;
			this.landBlockedWarnAt.set(cooldownKey, now);
			this.log("warn", `land blocked${branch ? ` (${branch})` : ""}: ${detail}`);
			this.automation.for("land", repo)({
				durationMs: 0,
				level: "warn",
				skipReason: reasonClass === "dirty-main" ? "dirty-main" : undefined,
				detail: branch ? `${branch}: ${detail}` : detail,
			});
		} catch {
			/* observability must never break the land path */
		}
	}

	/**
	 * Bounded escalation for a retryable land refusal (finding #2, cross-lineage review): once the SAME
	 * episode (`landBlockedEpisode`'s key — repo+branch+headSha+reasonClass) has retried past
	 * `landBlockedEscalateCap()` attempts, this fires the "Needs you" attention item on top of the
	 * routine `fileLandBlockedFinding` warn — dual-write, mirroring `fileUnverifiedProofFinding`'s
	 * pattern exactly:
	 *   1. The attention lane on the live `AgentRecord` (`rec` is always live here — this runs inside
	 *      `land()`, called with a roster-resolved `rec`), so it's live-pushed to any connected client.
	 *   2. The "land" automation channel, unconditionally, so it surfaces in /api/automation + the panel
	 *      even if `rec` is reaped before a client observes the attention event.
	 * Never blocks or retries anything itself — `land()`'s own retry loop is untouched; this only makes
	 * "this specific episode has been stuck a while" legible instead of an indefinitely-repeating log
	 * line nobody is watching. Idempotent per episode via the caller's `landBlockedEscalated` set (this
	 * method itself doesn't dedupe). Best-effort; never throws.
	 */
	private fileLandBlockedEscalation(rec: AgentRecord, repo: string, detail: string, reasonClass: string, attempts: number): void {
		const summary = `auto-land has been blocked on ${rec.dto.branch ?? rec.dto.name} for ${attempts} consecutive attempts (${reasonClass}) — needs a human to look`;
		try {
			const event: AttentionEvent = { id: randomUUID(), summary, detail, source: "notify", createdAt: Date.now() };
			rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
			this.emitAgent(rec);
		} catch (err) {
			this.log("warn", `land-blocked attention-lane attach failed for ${rec.dto.name} (non-fatal): ${errText(err)}`);
		}
		try {
			this.log("warn", `${summary} — ${detail}`);
			this.automation.for("land", repo)({ durationMs: 0, level: "warn", skipReason: reasonClass === "dirty-main" ? "dirty-main" : undefined, detail: `${summary} — ${detail}` });
		} catch {
			/* observability must never break the land path */
		}
	}

	/**
	 * Route a membrane-breaker trip — a hard fleet-wide auto-disable of `OMP_SQUAD_MEMBRANE_PROFILES`
	 * (eap-borrows concern 05) — to where a human actually looks. Also reused verbatim for the
	 * baseline-tracker's staleness event (concern 01 DESIGN decision 4 follow-up — see the `onStaleness`
	 * wire-up above): the channel doesn't care what tripped, only that a human sees it. Dual-write,
	 * mirroring how every other daemon-scoped escalation in this file records:
	 *   1. The "Needs you" attention lane: attach `event` to `rec.dto.attentionEvents` (the SAME
	 *      non-blocking channel `squad_attention`/`glance notify` use — squad-manager.ts's `notify`
	 *      command and `handleAttentionTool`) and `emitAgent(rec)` so it's live-pushed to any connected
	 *      client. `rec` is the flagged unit whose land triggered this cadence check.
	 *   2. The "land" automation channel (`fileLandBlockedFinding`'s pattern; concern 04's #12 fix uses
	 *      the equivalent "observer" channel for a gate-unrunnable finding) — surfaces in /api/automation
	 *      + the automation panel UNCONDITIONALLY, in its own try/catch independent of step 1.
	 * `rec` is OPTIONAL (blind review follow-up finding #4): the cadence check is fire-and-forget
	 * (`void membraneBreakerCadence(...).then(...)`), so by the time it resolves the triggering unit may
	 * already be reaped off `this.agents` — the caller passes `undefined` in that case rather than a
	 * dangling `AgentRecord` reference that no client's roster still contains (attaching to a detached
	 * DTO nobody's UI is watching would be indistinguishable from dropping the event). Step 1 is simply
	 * skipped when `rec` is absent; step 2 (the daemon-scoped automation channel) ALWAYS runs regardless.
	 *
	 * HONEST LABEL (2nd round follow-up, blind review): when `rec` is absent, step 2 is — as of today —
	 * the ONLY place this escalation reaches. It was believed to also surface via the cockpit's
	 * "Needs you" lane and/or the omp-graph "land" loop node; verified false on both counts:
	 *   - The Needs-you lane (`attentionItems` in webapp/src/lib/insights.ts) has no daemon/repo-scoped
	 *     source at all — its `actionItems` fold-in only ever pushes `source: "health"` rows, and the
	 *     server's `/api/action-items` only ever builds `land`/`error`/`pending` rows FROM a live agent
	 *     in the roster. An unattached finding has neither.
	 *   - factory-status.ts's `landBlocked` banner (the one existing repo-scoped warning slot) is
	 *     hard-coupled to the "land" channel's `skipReason` meaning "a land was refused" — tagging this
	 *     event that way would misrender as "Fleet cannot land: …" for a condition that has nothing to do
	 *     with landing. Rejected as dishonest.
	 *   - The omp-graph "land" loop node is unreachable in the live UI: FleetPulseCanvas only turns a
	 *     LOOP automation event into a clickable hanging note when it carries `filed`/`spawned` (see
	 *     `pulse-model.ts`), which no "land"-channel write (this one included) ever sets. The tag `loop:
	 *     "land"` exists only as event metadata, never as an inspectable/clickable UI element.
	 * So a rotting baseline or a membrane-breaker trip with no live triggering unit is, right now, only
	 * findable via `/api/automation`, `glance automation --loop land`, or grepping automation.jsonl — NOT
	 * "an escalation nobody sees is indistinguishable from no escalation" in the full sense the rest of
	 * this file achieves elsewhere. Rather than fake a UI render, the detail carries
	 * `UNATTACHED_ESCALATION_MARKER` so it's trivially greppable until a real repo-scoped attention
	 * surface exists (tracked as follow-up work, not invented here). Never a log line alone regardless —
	 * a fleet-wide safety-net trip that only a daemon operator tailing logs would ever see defeats the
	 * point of having a breaker. Best-effort; never throws.
	 */
	private fileMembraneBreakerFinding(rec: AgentRecord | undefined, repo: string, event: AttentionEvent): void {
		if (rec) {
			try {
				rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
				this.emitAgent(rec);
			} catch (err) {
				this.log("warn", `membrane-breaker attention-lane attach failed for ${rec.dto.name} (non-fatal): ${errText(err)}`);
			}
		}
		try {
			const text = `${event.summary}${event.detail ? ` — ${event.detail}` : ""}`;
			this.log("warn", text);
			// See the doc comment above: with no live `rec`, this write is the ONLY place the escalation
			// reaches today — mark it so it's still trivially findable without a UI.
			const detail = rec ? text : `${UNATTACHED_ESCALATION_MARKER} — ${text}`;
			this.automation.for("land", repo)({ durationMs: 0, level: "warn", detail });
		} catch {
			/* observability must never break the land path */
		}
	}

	/**
	 * Sweep a FINISHED agent's uncommitted work into a commit on its own branch.
	 *
	 * THE MISSING STEP (found by driving the factory to completion, 2026-07-09). No stage of the unit
	 * lifecycle ever commits: the bundled verify-loop workflow is `Implement → Verify → exit`, and
	 * agents reliably end a turn with uncommitted edits, reporting "Done". `runProof` (proof.ts) then
	 * refuses a dirty worktree outright, so `verifyAgentWork` returns false, the orchestrator escalates,
	 * and the unit dies at the escalate visit cap. That is the SINGLE terminal state of every
	 * autonomously-dispatched unit this daemon has ever run: 65 of 65 recorded `catastrophe` events are
	 * `node "escalate" exceeded its visit cap (2)`. No unit has ever landed.
	 *
	 * The system's model was never "agents commit" — it is "agents work, the daemon sweeps": `land()`
	 * already does exactly this sweep (`commitWip: !busy`) BEFORE its proof gate. Only the autonomous
	 * path lacked it, which is why a human clicking Land could land what the fleet structurally could
	 * not. This restores the symmetry at the one seam the orchestrator drives.
	 *
	 * Deliberately conservative — a no-op unless ALL hold: the agent exists, it is NOT busy (a live
	 * agent's half-written tree is not a unit of work), it has its own branch and worktree (an in-place
	 * agent has nothing to isolate), and the tree is actually dirty. `.omp/` is excluded on both the
	 * status probe and the add, exactly as `land()` does — it is the daemon's own evidence dir, and
	 * sweeping it commits screenshots the proof fingerprint deliberately ignores.
	 *
	 * Returns true only when a commit was created.
	 */
	async commitAgentWip(id: string, actor: Actor = AUTO_ACTOR): Promise<boolean> {
		// An observer/answer unit produces a REPORT. Sweeping its worktree into a commit is the first step
		// of a chain that ends in a merge, and this sweep is exactly what made the fleet able to land at
		// all. `is-landing-unit.ts` looks like it guards this; it does not — it is a metrics denominator
		// and no land path reads it. The refusal has to live at each door. (grok-4.5)
		const guard = this.agents.get(id);
		if (guard && (guard.options.executionRole === "observer" || guard.options.ask)) return false;
		const rec = this.agents.get(id);
		if (!rec) return false;
		const { repo, worktree, branch, status, name } = rec.dto;
		if (!branch) return false; // no branch of its own ⇒ nothing to commit onto
		if (status === "working" || status === "starting" || status === "input") return false; // mirrors land()'s `busy`
		// In-place guard, resolved through symlinks: `path.resolve` alone is textual, so a worktree path
		// that symlinks to the operator's checkout would slip past it and we would commit on the tree the
		// human is standing in. `realpath` both sides; fall back to the textual compare if either path is
		// unreadable (a missing worktree can't be swept anyway). Cross-lineage review (grok-4.5) raised it.
		const canon = async (p: string): Promise<string> => await fs.realpath(p).catch(() => path.resolve(p));
		if ((await canon(worktree)) === (await canon(repo))) return false; // in-place: nothing to isolate

		// "idle" is an observation, not quiescence: `agent_end` clears streaming but never kills the agent
		// host, so a background process it spawned can still be writing. Require a short dwell since the
		// last activity before we freeze the tree into a commit; the orchestrator re-ticks in 30s, so a
		// skipped sweep costs one tick, while a premature one commits a half-written file. This narrows
		// the window; it cannot close it (no lock stops the agent's own child processes) — the same
		// exposure `land()`'s WIP sweep has always carried. Raised by cross-lineage review (both lineages).
		const dwellMs = envInt("OMP_SQUAD_WIP_SWEEP_DWELL_MS", 3_000);
		if (rec.dto.lastActivity && Date.now() - rec.dto.lastActivity < dwellMs) return false;

		const pathspec = [".", ":(exclude).omp"];
		const st = await hardenedGit(["status", "--porcelain", "--", ...pathspec], { cwd: worktree });
		if (st.code !== 0 || st.stdout.trim().length === 0) return false; // clean (or unreadable) ⇒ nothing to sweep

		// Re-read status through the lifecycle one last time: an operator prompt or a resumed turn between
		// the checks above and the write below must abort the sweep, not race it.
		if (this.agents.get(id)?.dto.status !== status) return false;

		const add = await hardenedGit(["add", "-A", "--", ...pathspec], { cwd: worktree });
		if (add.code !== 0) {
			this.log("warn", `wip-sweep: git add failed for ${name}: ${add.stderr.trim()}`);
			return false;
		}
		// This subject is PERMANENT: it is the commit the fleet pushes and a reviewer reads on the PR.
		// Title it after the work, not after the plumbing — the daemon's internal reason belongs in the
		// body. (The first fleet-opened PR, #149, was titled "wip(…): sweep uncommitted work before
		// verify"; nobody wants a history of that.) Falls back to `land()`'s existing `squad(<name>)` shape.
		const issue = rec.dto.issue;
		const subject = issue?.name ? `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.name}` : `squad(${name}): agent changes`;
		const message = `${subject}\n\nCommitted by the glance daemon (uncommitted work swept before the verify gate).`;
		const commit = await hardenedGit(["commit", "-m", message], { cwd: worktree });
		if (commit.code !== 0) {
			this.log("warn", `wip-sweep: git commit failed for ${name}: ${commit.stderr.trim() || commit.stdout.trim()}`);
			return false;
		}
		this.log("info", `wip-sweep: committed ${name}'s uncommitted work on ${branch} before verify`);
		void this.recordAudit(actor, "commit-wip", id, "ok", subject);
		return true;
	}

	async verifyAgentWork(id: string, actor: Actor = AUTO_ACTOR): Promise<boolean> {
		const rec = this.agents.get(id);
		if (!rec) return false;
		this.syncAuthority(rec.dto);
		if (rec.dto.effectiveMode === "observe") throw new Error("verify blocked in observe mode");
		const stages = await detectVerifyStages(rec.dto.repo);
		const command = stages.length ? stages.map((s) => s.command).join(" && ") : undefined;
		if (!command) return false;
		const proof = await runProof({ repo: rec.dto.repo, worktree: rec.dto.worktree, command, stages });
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
	 * Promote a console chat unit into a working, landable unit IN PLACE (fleet-ide-escalation E02) —
	 * the reverse of intervene. Keeps the SAME worktree, live session, and transcript (zero context
	 * loss): the daemon-backed cockpit chat (E01) is already an `omp-operator` unit named "chat" at
	 * `assist` mode with its own worktree; the only thing holding it back is the CONSOLE_SYSTEM_PROMPT,
	 * a SOFT restriction ("do not create … unless the user explicitly asks"). Promotion has two halves:
	 *   1. State (durable, failure-atomic): strip ONLY the console segment from the composite
	 *      `appendSystemPrompt` — preserving profile memory / tool grants / membrane disciplines — set a
	 *      durable `promoted` marker, optionally set autonomy; assign synchronously, then persist once.
	 *      On a throwing persist (DB mode) the in-memory record is rolled back and nothing is
	 *      emitted/audited/steered. (File-mode persist is best-effort — swallows I/O errors — the same
	 *      as every other mutation on this manager; not made worse here.)
	 *   2. Behavioral (live, zero context loss): steer the explicit task into the SAME session — that IS
	 *      "the user explicitly asks", so the running agent (console prompt still baked into its child)
	 *      starts working without a respawn.
	 * Idempotent + retry-safe: a re-promote of an already-`promoted` unit re-delivers the task instead
	 * of falsely refusing (a first call that persisted but died before the steer is recoverable).
	 * `ok:true` means the state change is durable and the task was DISPATCHED — not that the agent has
	 * finished; behavioral confirmation is the unit's live transcript. Gating is NOT re-wired: a
	 * landable unit is already gated by the land PROOF gate (`detectVerify` at land time, same as any
	 * unit); attaching a `workflow` would be inert on an omp-operator's already-built driver.
	 */
	async promote(
		id: string,
		opts: { task?: string; mode?: AutonomyMode },
		actor: Actor = LOCAL_ACTOR,
	): Promise<{ ok: boolean; reason?: string; agent?: AgentDTO }> {
		const rec = this.agents.get(id);
		if (!rec) return { ok: false, reason: "no such agent" };
		// Observe forbids prompting (availableActions), so promoting a unit INTO observe and then
		// steering it would drive a unit its own authority says is read-only. Refuse it.
		if (opts.mode === "observe") return { ok: false, reason: "cannot promote to observe mode" };
		const o = rec.options;

		// Already promoted → idempotent re-steer (retry-safe): the state change is done; just apply any
		// mode change and (re)deliver the task into the same session.
		if (o.promoted) {
			// Promotion is the "keep it" signal for a `glance here` session (daily-onramp 02) — clearing
			// the marker on the idempotent path too means a re-promote after a crashed first call still
			// makes the registration durable.
			this.clearEphemeralMarker(rec.dto.repo);
			// Keep the wire mirror honest on the retry path too (a pre-06 daemon's persisted promote, or a
			// crashed first call, may have left the DTO unstamped even though the options flag is durable).
			rec.dto.promoted = true;
			if (opts.mode && opts.mode !== rec.dto.autonomyMode) {
				rec.dto.autonomyMode = opts.mode;
				o.autonomyMode = opts.mode;
				this.syncAuthority(rec.dto);
				this.emitAgent(rec);
				await this.persist();
			}
			this.steerPromoteTask(id, opts.task, actor);
			return { ok: true, agent: rec.dto };
		}

		// Fresh promote: must be a genuine console unit — identity is the console PROMPT (not merely
		// "has some appendSystemPrompt", which would also match a profile bundle / custom safety text).
		if (o.kind !== "omp-operator" || rec.dto.name !== "chat" || !isConsolePrompt(o.appendSystemPrompt)) {
			return { ok: false, reason: "not a promotable console chat unit" };
		}
		if (o.executionRole || o.workflow || o.ask) {
			return { ok: false, reason: "unit is not a plain console chat" };
		}

		// 1. State promotion — assign synchronously, persist once, FAILURE-ATOMIC: on a throwing persist
		//    roll the record back and surface the error (emit/audit/steer only AFTER durability).
		const prior = { append: o.appendSystemPrompt, mode: rec.dto.autonomyMode, oMode: o.autonomyMode };
		o.appendSystemPrompt = stripConsolePrompt(o.appendSystemPrompt); // strip ONLY the console rule
		o.promoted = true;
		rec.dto.promoted = true; // wire mirror — the webapp's promote affordance keys off this
		if (opts.mode && opts.mode !== rec.dto.autonomyMode) {
			rec.dto.autonomyMode = opts.mode;
			o.autonomyMode = opts.mode;
		}
		this.syncAuthority(rec.dto);
		try {
			await this.persist();
		} catch (err) {
			o.appendSystemPrompt = prior.append;
			o.promoted = undefined;
			rec.dto.promoted = undefined;
			rec.dto.autonomyMode = prior.mode;
			o.autonomyMode = prior.oMode;
			this.syncAuthority(rec.dto);
			return { ok: false, reason: `promote persist failed: ${errText(err)}` };
		}
		// Promote makes a `glance here` session's repo registration durable: with the ephemeral marker
		// gone, session-end cleanup no longer fires (daily-onramp 02). AFTER the persist so a rolled-back
		// promote leaves the marker (and the session's cleanup contract) intact.
		this.clearEphemeralMarker(rec.dto.repo);
		this.emitAgent(rec);
		void this.recordAudit(actor, "promote", id, "ok", `console→unit; mode ${prior.mode}→${rec.dto.autonomyMode}`);
		await this.store.appendAudit({ actor: actor.id, action: "promote", target: id, detail: { priorMode: prior.mode, mode: rec.dto.autonomyMode, task: opts.task ? truncate(opts.task, 120) : undefined } }).catch(() => {});

		// 2. Behavioral promotion — steer the explicit task into the same live session.
		this.steerPromoteTask(id, opts.task, actor);
		return { ok: true, agent: rec.dto };
	}

	/** Steer a promotion's explicit work instruction into the live session (fire-and-forget with a
	 *  catcher, exactly as every prompt route drives applyCommand — a bare await could surface a
	 *  spawn-failure rejection as an unhandled rejection; see the "prompt" case). The console prompt is
	 *  baked into the live child, but it's soft ("unless the user explicitly asks"), so an explicit task
	 *  lifts it in-session. A silent steer failure is recoverable — a re-promote re-delivers. */
	private steerPromoteTask(id: string, task: string | undefined, actor: Actor): void {
		if (task && typeof task === "string" && task.trim()) {
			void this.applyCommand({ type: "prompt", id, message: task.trim() }, actor).catch((err) =>
				this.log("warn", `promote steer failed for ${id}: ${errText(err)}`),
			);
		}
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
	protected runMainGate(repo: string): Promise<{ ok: boolean; firstFailure?: string; skipped?: boolean; unrunnable?: boolean }> {
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
				// Finding #2 (eap-borrows code review): a THROWN gate (e.g. the lock itself, or the
				// fingerprint sampler) is structurally unrunnable, not a confirmed regression — mirror
				// runMainGateUncached's own catch below so observer.ts's confirmedGate can classify it as
				// `gate-unrunnable` instead of filing a phantom `regression:` finding.
				return { ok: false, unrunnable: true, firstFailure: e instanceof Error ? e.message : String(e) };
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

	private async runMainGateUncached(repo: string): Promise<{ ok: boolean; firstFailure?: string; skipped?: boolean; unrunnable?: boolean }> {
		try {
			const command = await detectVerify(repo);
			// Finding #13 (eap-borrows wave 2): `ok: true` here used to be indistinguishable from "the gate
			// actually ran and passed" — a repo with no detectable verify command reads byte-identical to a
			// confirmed green suite to any caller that only checks `.ok`. Keep `ok: true` (a repo with
			// nothing to verify is not a regression — see the rationale above); ALSO stamp `skipped: true` so
			// a reader (or a future consumer) can tell "nothing was checked" from "checked and green" without
			// treating this as a claim about the repo's actual test status.
			if (!command) return { ok: true, skipped: true };
			// execGatedCommand: scrubbed env always; hermetic docker container by default when docker is usable (else a legible host fallback).
			const { code, stdout: out, stderr: err } = await execGatedCommand(command, repo);
			if (code === 0) return { ok: true };
			// First failing test name from bun's "(fail) <name>" lines; fall back to the tsc/first error line.
			const text = `${out}\n${err}`;
			const failLine = text.split("\n").find((l) => l.includes("(fail)"));
			const firstFailure = failLine ? failLine.replace(/.*\(fail\)\s*/, "").trim() : text.split("\n").find((l) => l.trim().length > 0)?.trim();
			return { ok: false, firstFailure: firstFailure?.slice(0, 200) };
		} catch (e) {
			// Finding #2: a thrown gate (Docker down, spawn failure) proves nothing about the repo's test
			// status — it's unrunnable, not a reproduced regression. Production's `runGate` dep
			// (`() => this.runMainGate(repo)`) never threw past this catch, so without this flag
			// observer.ts's `confirmedGate` catch (which DOES classify unrunnable) was permanently dead
			// for the real dependency and every outage filed a phantom `regression:` finding instead.
			return { ok: false, unrunnable: true, firstFailure: e instanceof Error ? e.message : String(e) };
		}
	}

	/**
	 * The Observer's dispatch seam (leaf 05): spawn an observing agent to reproduce a confirmed
	 * regression in its own worktree, instead of the Observer only filing an issue. Opt-in via
	 * OMP_SQUAD_OBSERVE_REPRODUCE (checked by the Observer itself before calling this); this method is
	 * just the mechanics — resolve the repo's gate command, spawn a `verifyMode:"observe"` agent, and
	 * report success/failure so the Observer can fall back to filing. Never throws.
	 */
	private async dispatchObserver(repo: string, f: Finding): Promise<boolean> {
		try {
			const verify = await detectVerify(repo);
			if (!verify) return false; // nothing to reproduce against
			const task = `Reproduce and report on: ${f.title}${f.detail ? `\n\n${f.detail}` : ""}`;
			await this.create({ repo, task, verify, verifyMode: "observe", executionRole: "observer", autoRoute: false, track: false, approvalMode: "yolo" });
			return true;
		} catch (e) {
			this.log("warn", `dispatchObserver failed for ${repo}: ${e instanceof Error ? e.message : String(e)}`);
			return false; // WIP cap / spawn failure — Observer falls back to filing
		}
	}

	private emitFeaturesChanged(): void {
		void this.persist();
		this.emit("event", { type: "features-changed" } satisfies SquadEvent);
	}

	/**
	 * Adopt an ad-hoc CLI session into a fleet unit (fleet-ide-escalation E03). A developer ran a raw
	 * harness (e.g. `claude`) in a terminal; B03 harness-hooks registered it as presence
	 * (`harness:sessionId`, source "other"). Adoption captures that session's uncommitted WORK — not its
	 * conversation (the daemon has no handle on the harness's own context) — into a FRESH worktree and
	 * wraps it in a gated unit, leaving the developer's original GIT checkout UNTOUCHED.
	 *
	 * Hardened against a cross-lineage gauntlet (codex + grok). Fail-closed throughout: the source dir
	 * is only ever READ (diff + ls-files + file copies OUT of it; `--no-textconv`/`--no-ext-diff` so no
	 * configured diff driver runs against the source; never a write/index mutation). Any capture/apply
	 * failure removes the half-made worktree; after `create()` the worktree belongs to the unit, so it
	 * is NOT removed on a create error (that would strand the roster record). Validity binds the cwd to
	 * the session's real repo (realpath + repoRoot) AND requires the session's exact live presence
	 * claimId — adopt can't be pointed at a sibling checkout or a spoofed label.
	 *
	 * Known limits (documented, not defects): submodule (gitlink) changes are NOT captured (a plain
	 * `git apply` skips them); the adopted worktree shares `node_modules` with the primary checkout per
	 * the standard worktree model (the git tree/index is what's untouched); if the harness fails to
	 * start, the unit still appears in the roster in `error` state with its captured worktree — restart
	 * it, the work is not lost. Operator-tier (same as /api/spawn); the presence gate is a validity
	 * check, not a privilege boundary (an operator can already create units in its projects).
	 */
	async adopt(
		args: { harness: string; sessionId: string; cwd: string },
		actor: Actor = LOCAL_ACTOR,
	): Promise<{ ok: boolean; reason?: string; agent?: AgentDTO }> {
		const MAX_PATCH_BYTES = 64 * 1024 * 1024; // 64 MiB — cap the in-memory/tmp patch (DoS)
		const MAX_UNTRACKED = 10_000; // cap the untracked file count (DoS)

		// 1. Validate. Resolve symlinks in the cwd FIRST (a lexical containment check alone lets
		//    `/r/../victim` or `/r/symlink-to-victim` escape), then gate exactly like the hooks.
		let realCwd: string;
		try {
			realCwd = await fs.realpath(args.cwd);
		} catch {
			return { ok: false, reason: "cwd does not exist" };
		}
		const decision = harnessEventDecision(
			{ harness: args.harness, event: "prompt", sessionId: args.sessionId, cwd: realCwd },
			this.projects().map((p) => p.repo),
		);
		if (decision.action !== "claim") {
			return { ok: false, reason: decision.action === "drop" ? decision.reason : "not an adoptable session" };
		}
		const repo = decision.repo;
		const label = decision.agent; // `harness:sessionId`
		// Bind the cwd to the session's ACTUAL git repo — the resolved cwd's git top-level must be the
		// registered project root, so a sibling checkout that merely lives under the same base is refused.
		const topLevel = await repoRoot(realCwd).catch(() => null);
		if (!topLevel || topLevel !== repo) {
			return { ok: false, reason: "cwd is not the registered project's git repository" };
		}
		// Require the session's EXACT live presence row — match the deterministic claimId (the presence
		// entry id), not just the display label, so `a:b` can't satisfy `a:b:c` and spoofed rows still
		// need the right harness+sessionId hash.
		const present = await who(repo);
		if (!present.some((e) => e.id === decision.claimId && e.source === "other")) {
			return { ok: false, reason: "no live ad-hoc session for that harness/sessionId in this project" };
		}

		// 2. Refuse a re-adopt of the same session@HEAD up front (fail-closed, clear message) rather
		//    than relying on addWorktree's branch/dir-exists error.
		const head = await hardenedGit(["rev-parse", "HEAD"], { cwd: repo });
		if (head.code !== 0) return { ok: false, reason: "repo has no HEAD commit (not a git checkout?)" };
		const headSha = head.stdout.trim();
		const branch = adoptBranchName(args.harness, args.sessionId, headSha);
		const branchExists = await hardenedGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo });
		if (branchExists.code === 0) {
			return { ok: false, reason: "this session's current state is already adopted" };
		}

		// 3. Capture the repo's working state READ-ONLY, against the SAME sha we'll cut from (coherent
		//    snapshot even if HEAD moves under us). `--no-textconv` + `--no-ext-diff` keep any configured
		//    diff driver from running against the source; `--binary` replays binary edits; `-z` is
		//    lossless for odd filenames.
		const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--binary", headSha];
		const tracked = await hardenedGit(diffArgs, { cwd: repo });
		if (tracked.code !== 0) return { ok: false, reason: `git diff failed: ${tracked.stderr.trim()}` };
		if (tracked.stdout.length > MAX_PATCH_BYTES) {
			return { ok: false, reason: "uncommitted diff is too large to adopt" };
		}
		const names = await hardenedGit(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", headSha], { cwd: repo });
		const changedCount = names.code === 0 ? parseNulList(names.stdout).length : 0;
		const others = await hardenedGit(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: repo });
		if (others.code !== 0) return { ok: false, reason: `git ls-files failed: ${others.stderr.trim()}` };
		const untracked = parseNulList(others.stdout);
		if (untracked.length > MAX_UNTRACKED) return { ok: false, reason: "too many untracked files to adopt" };
		// Fail closed (not silent drop) if any untracked path is anomalous — git never emits these.
		if (untracked.some((p) => !isSafeUntrackedPath(p))) {
			return { ok: false, reason: "unsafe path in the untracked set" };
		}

		// 4. Cut a FRESH worktree from the captured HEAD sha (never the developer's checkout).
		let worktree: string;
		try {
			const created = await addWorktree({ repo, branch, startPoint: headSha, base: this.worktreeBaseDir });
			worktree = created.worktree;
		} catch (err) {
			return { ok: false, reason: `could not create worktree: ${errText(err)}` };
		}
		const cleanup = async (): Promise<void> => {
			await removeWorktree(repo, worktree).catch(() => {});
			if (existsSync(worktree)) this.log("warn", `adopt: worktree not fully removed after failure: ${worktree}`);
		};

		// 5. Replay the captured state into the new worktree; FAIL CLOSED (remove the worktree, no unit).
		try {
			const patch = tracked.stdout;
			if (patch.trim().length > 0) {
				// A private, freshly-created temp dir (0700, unique name) — never a predictable path an
				// attacker could pre-plant as a symlink, and no concurrent-adopt filename race.
				const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glance-adopt-"));
				try {
					const patchFile = path.join(tmpDir, "capture.patch");
					await fs.writeFile(patchFile, patch);
					const applied = await hardenedGit(["apply", "--whitespace=nowarn", patchFile], { cwd: worktree });
					if (applied.code !== 0) throw new Error(`captured changes did not apply: ${applied.stderr.trim()}`);
				} finally {
					await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
				}
			}
			for (const rel of untracked) {
				// Skip symlinks: fs.cp preserves them, and an untracked `link -> /original/file` would let
				// the adopted unit write THROUGH to the developer's tree. Regular files/dirs only.
				const src = path.join(realCwd, rel);
				const st = await fs.lstat(src).catch(() => null);
				if (!st || st.isSymbolicLink()) continue;
				const dst = path.join(worktree, rel);
				await fs.mkdir(path.dirname(dst), { recursive: true });
				await fs.cp(src, dst, { recursive: true });
			}
		} catch (err) {
			await cleanup();
			return { ok: false, reason: `adopt failed (your checkout is untouched): ${errText(err)}` };
		}

		// 6. Wrap the prepared worktree in a gated unit. existingPath uses it verbatim (no second cut);
		//    a task + autoRoute wires the verify gate (if the repo has a detectable verify command). Once
		//    create() owns the worktree we do NOT remove it on error — the unit record may already exist
		//    (removing it would strand the record + driver); a truly orphaned worktree is reaped later.
		try {
			const dto = await this.create(
				{ repo, existingPath: worktree, task: adoptBrief(args.harness, changedCount, untracked.length), autoRoute: true },
				actor,
			);
			void this.recordAudit(actor, "adopt", dto.id, "ok", `${label} → ${dto.name} (${changedCount} changed, ${untracked.length} new)`);
			return { ok: true, agent: dto };
		} catch (err) {
			return { ok: false, reason: `unit creation failed (worktree ${worktree} left for the reaper): ${errText(err)}` };
		}
	}

	// ── Roster mutation ───────────────────────────────────────────────────────

	async create(opts: CreateAgentOptions, actor: Actor = LOCAL_ACTOR, source?: string): Promise<AgentDTO> {
		return this.createWithId(opts, undefined, actor, source);
	}

	/**
	 * Sole entry point for a caller-chosen deterministic agent id (spawnFleetBranch's branch ids; concern
	 * 04's fork ids). Rejects a duplicate id BEFORE any worktree/spawn side effect runs (checked here, not
	 * inside createWithId, so the check happens ahead of every side effect createWithId's body performs).
	 * ORDERING REQUIREMENT: a re-spawn of the exact same deterministic id (e.g. resume re-running a
	 * `not_attempted` branch whose old dead roster record is still around from a prior boot) is an
	 * expected reuse, not a collision — but this method would reject it. The caller (reconcileParallelResume)
	 * MUST stop()/delete() any stale roster entry for the id before resume calls spawnFleetBranch again, so
	 * the id is already free by the time createInternal runs.
	 */
	private async createInternal(opts: InternalCreateOptions, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		if (this.agents.has(opts.explicitId)) throw new Error(`agent id already in use: ${opts.explicitId}`);
		return this.createWithId(opts, opts.explicitId, actor);
	}

	private async createWithId(opts: CreateAgentOptions, explicitId: string | undefined, actor: Actor = LOCAL_ACTOR, source?: string): Promise<AgentDTO> {
		const profile = this.profileFor(opts.profileId, opts.repo);
		// A profile's capability tool-grants (AgentProfile.capabilities, populated by bindingToProfile) scope
		// what tools the spawned agent may use. They were parsed but NEVER applied — every agent got full tool
		// access regardless. We now (a) inject the allow-list into the agent's system prompt (the path that
		// actually reaches the omp child via --append-system-prompt) and (b) record it on the AgentRecord so
		// host tool calls outside the list are hard-denied at the onHostTool seam (see toolGrants below).
		// FLAG: hard enforcement of omp's *core* tools (read/edit/bash) requires an upstream
		// `omp --allowed-tools` flag the RpcAgent/agent-host cannot pass today; the prompt constraint + host
		// tool gate are the strongest enforcement reachable without that upstream change.
		// `membrane:*` efficiency-flag tokens (concern 05) ride the SAME capabilities[] array a profile
		// authors but must never enter toolGrants (DESIGN.md "Membrane delivery" — a membrane token would
		// either wrongly narrow the tool allow-list or be denied as an unrecognized tool at onHostTool
		// below). splitCapabilityTokens is the one place capabilities becomes toolGrants, so every
		// downstream consumer only ever sees real tool names; requestedEfficiencyFlags is hoisted (same
		// pattern as hasPrimer below) until the harness's contextInjection is known further down.
		// gateMembraneTokens applies double gate #2 (OMP_SQUAD_MEMBRANE_PROFILES=1 — gate #1 is the token
		// itself being present) BEFORE the flag reaches either the prompt join below or the delivery
		// confirmation further down, so "stamped only on confirmed delivery" stays true when gate #2 is
		// off: nothing is delivered, so nothing gets stamped as delivered either.
		const { toolGrants, requested: requestedRaw } = splitCapabilityTokens(profile?.capabilities);
		const requestedEfficiencyFlags = gateMembraneTokens(requestedRaw, profile?.id);
		if (profile) {
			opts = {
				...opts,
				profileId: profile.id,
				model: opts.model ?? profile.model,
				approvalMode: opts.approvalMode ?? profile.approvalMode,
				// Capability bundle: a profile can also select the harness/bin/thinking a unit runs on
				// (elevate-profile-bundle). Explicit opts always win over the profile's default.
				harness: opts.harness ?? profile.harness,
				bin: opts.bin ?? profile.bin,
				// mcp: a REPO-sourced profile's `mcp` was already stripped by parseProfiles (agent-profiles.ts)
				// before it ever reached `this.profiles()`/`profileFor` — `profile.mcp` here can only ever be an
				// env/operator server list. `opts.mcp` (direct, same trust tier as opts.bin) still wins.
				mcp: opts.mcp ?? profile.mcp,
				thinking: opts.thinking ?? profile.thinking,
				appendSystemPrompt: [profile.memory, toolGrantsPrompt(toolGrants), membraneDisciplinePrompt(requestedEfficiencyFlags), opts.appendSystemPrompt].filter((text): text is string => typeof text === "string" && text.length > 0).join("\n\n") || undefined,
			};
		}
		// Cold-start KB primer (OMPSQ #8): a fresh agent on a feature inherits the most relevant prior
		// decisions / hot files / peer context with ZERO turn cost, drawn from the context fabric.
		// buildContextPrimer fences its own output as untrusted (concern 02) — do NOT re-fence here.
		// Best-effort — never blocks a spawn.
		// hasPrimer is hoisted (not re-derived from opts.appendSystemPrompt later) so the harness
		// scorecard's "instructions" dimension (below, concern 03) can tell "a context primer landed"
		// apart from "the profile injected unrelated persona text" without re-parsing the joined string.
		//
		// R3 (founding brief: "units are context-poor"). This used to be gated on `opts.featureId`, and
		// NOTHING that dispatch spawns carries one: `dispatchSpawn` calls `create({repo, name, branch,
		// task, issue})` with no featureId, and neither does `glance add`. Only the feature-linked
		// `POST /api/features/:id/agents` path set it. So the cold-start primer never ran for a dispatched
		// or ad-hoc unit — and the `primer-empty` metric, which lives INSIDE that branch, has zero records
		// across this host's entire learning-metrics log. The instrument was inside the thing it measured.
		//
		// Now: any spawn with a repo and something to search on gets the primer. Still best-effort, still
		// fenced-untrusted by `buildContextPrimer`, still never blocks a spawn.
		// `OMP_SQUAD_CONTEXT_PRIMER=0` disables it.
		const primed = await this.primeContext(opts, actor);
		opts = primed.opts;
		const primerBuilt = primed.hasPrimer;
		// Authored-spec injection (concern 01): a dispatched unit works toward its actual contract
		// (acceptance criteria / verification / scope) instead of reconstructing intent from an 8-word
		// title. The body is human/skills-MCP-writable, so fence it as UNTRUSTED data — never let issue
		// text act as instructions to the yolo agent. Absent ⇒ title-only (no regression).
		const specBlock = authoredSpecBlock(opts.issue?.description);
		if (specBlock) {
			opts = {
				...opts,
				appendSystemPrompt: [opts.appendSystemPrompt, specBlock].filter((text): text is string => typeof text === "string" && text.length > 0).join("\n\n") || undefined,
			};
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
		const id = explicitId ?? newAgentId(name);
		// Cross-lineage review HIGH 2: an authorized creator deliberately reusing a tombstoned id is a
		// legitimate resurrection, so the tombstone must clear — otherwise a workflow resume re-spawning
		// a DETERMINISTIC branch id (deriveBranchAgentId is a pure function of runId/branchKey/nodeId)
		// after an operator rm'd the stuck branch would run once and then silently vanish at the next
		// restart (reconnectLive/adoptOrphanedAgents/loadPersisted all filter tombstoned ids). Fresh
		// random ids virtually never hit this; explicit/deterministic ids are the real audience.
		if (this.removedLedger.has(id)) {
			this.removedLedger.delete(id);
			this.log("info", `cleared removal tombstone for ${id} — explicitly re-created`);
		}
		const branch = opts.branch ?? `squad/${id}`;
		if (opts.task && opts.autoRoute !== false && !opts.workflow && !opts.verify && !opts.sandbox) {
			const decision = await routeIntake(opts.task, opts.repo, this.llmClassify);
			opts = {
				...opts,
				workflow: decision.workflow,
				verify: decision.verify,
				verifyMode: decision.mode,
				thinking: decision.thinking ?? opts.thinking,
				// Stamp the tester role for observability — the router only ever selects "tdd".
				executionRole: decision.mode === "tdd" ? "tester" : opts.executionRole,
			};
			this.log("info", `routed "${name}": ${decision.reason}`);
		}
		// Pre-execution cost projection (C-COST) — shadow-only: warns when this (model,tier) is projected
		// to run over budget, BEFORE the spawn spends anything. Fire-and-forget so it never delays a spawn;
		// no-op unless OMP_SQUAD_COST_GATE is on. Enforce (hard park) is deferred.
		void shadowCostCheck(this.stateDir, opts.model, tierOf(opts.thinking), (line) => this.log("warn", line));
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
		// Route model at dispatch (Epic 6 / model-routing-control-loop concern 06 — the control loop's
		// ACTION arm). `taskClass` mirrors the SAME formula the `routing` field below uses (`opts.verifyMode`
		// already carries `routeIntake`'s decision by this point), so the router keys on exactly the class
		// the row/roster will later be bucketed under.
		//
		// SAFE BY DEFAULT: gated on the existing `OMP_SQUAD_MODEL_OUTCOMES=1` flag (same gate
		// `smart-spawn.ts`'s interactive `shiftedModel` uses) — with the flag unset, this entire block is
		// skipped and dispatch is byte-for-byte unchanged. Never overrides an explicit `opts.model` (a
		// profile or operator's choice), mirroring `shiftedModel`'s rule #1.
		//
		// SHADOW-FIRST: even with the gate on, `OMP_SQUAD_MODEL_ROUTE_SHADOW` defaults ON (anything but the
		// literal "0") — the decision is logged (+ recorded as a `model-route-decision` learning metric) but
		// NOT applied, so an operator can compare shadow decisions against the task-class panel before
		// opting into `OMP_SQUAD_MODEL_ROUTE_SHADOW=0` (apply mode). Applying it also closes the C01 gap for
		// harnesses that never emit an effective model: a routed unit now carries an explicit `opts.model`.
		let routedModel: string | undefined;
		if (process.env.OMP_SQUAD_MODEL_OUTCOMES === "1" && opts.model === undefined) {
			try {
				const taskClass = { mode: opts.verifyMode ?? "none", tier: tierOf(thinking) };
				const rows = await readTaskOutcomes(this.stateDir);
				const matrix = buildTaskClassMatrix(rows, this.landingRosterRouting(), { start: Date.now() - 30 * DAY_MS, end: Date.now() });
				const decision = routeModelForTaskClass(taskClass, matrix);
				const shadow = process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW !== "0";
				this.learningMetrics.record("model-route-decision", decision.model ? 1 : 0, {
					mode: shadow ? "shadow" : "apply",
					taskClass: `${taskClass.mode}:${taskClass.tier}`,
				});
				this.log("info", `model-route${shadow ? " [shadow]" : ""}: ${decision.reason}`);
				if (!shadow && decision.model !== undefined) {
					opts = { ...opts, model: decision.model };
					// Mark the model as ROUTER-chosen (vs operator/profile-declared): `unitProviderKey`'s
					// invariant excludes routed models from the rate-limit provider key on both the gate and
					// the record side (see `declaredModelOf`), so a routed unit's cap can never land in a
					// bucket the dispatcher's pre-routing gate would not check.
					routedModel = decision.model;
				}
			} catch (err) {
				this.log("warn", `model-route decision failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const kind = opts.flue ? "flue-service" : opts.workflow || opts.verify ? "workflow" : "omp-operator";

		// Resolve the harness backing a plain-agent unit and gate on its capabilities BEFORE cutting a
		// worktree (fail fast, no leaked worktree). flue/workflow kinds use their own drivers, so the
		// harness concept doesn't apply to them.
		const harnessDesc = kind === "omp-operator" ? resolveHarness({ harness: opts.harness, runtime: opts.runtime }) : undefined;
		if (harnessDesc) {
			// Honest gating (concern 08): an unverified harness (not smoke-tested against a live binary) is
			// refused unless the operator explicitly opts in — so a harness that half-works can't be picked
			// by accident, the way this repo's `/make-it-work` history warns against.
			if (!harnessDesc.verified && !unverifiedHarnessesEnabled()) {
				throw new Error(`harness "${harnessDesc.name}" is unverified (not smoke-tested against a live binary)${harnessDesc.note ? ` — ${harnessDesc.note}` : ""}. Set OMP_SQUAD_UNVERIFIED_HARNESS=1 to use it.`);
			}
			// A no-approval harness (pi: host perms, no approval channel) cannot enforce anything stricter
			// than yolo — refuse rather than silently granting full autonomy under an "always-ask"/"write"
			// label (the "inverted safety" failure mode). Surfaced, never coerced.
			if (harnessDesc.capabilities.toolApproval === "none" && approvalMode !== "yolo") {
				throw new Error(`harness "${harnessDesc.name}" has no approval channel — only approvalMode "yolo" is supported (got "${approvalMode}")`);
			}
			// sandbox × non-omp is unbuildable today: SandboxAgentDriver is an omp-RPC client over
			// docker-exec stdio. Reject rather than silently produce a broken driver (Phase 3 makes
			// containment protocol-aware so any harness can be sandboxed).
			if (opts.sandbox && harnessDesc.protocol !== "omp-rpc") {
				throw new Error(`harness "${harnessDesc.name}" cannot run sandboxed yet — sandbox currently supports only omp-rpc harnesses`);
			}
			// Capability validation for a profile-selected axis the resolved harness can't honor: ACP
			// harnesses have no thinking-level channel (makeDriver never threads `thinking` through to
			// AcpAgentDriver), so a profile that sets `thinking` there would otherwise be silently dropped.
			// Reject loudly instead — the operator picked an incompatible profile/harness pair.
			if (profile?.thinking && !harnessDesc.capabilities.thinking) {
				throw new Error(`profile "${profile.id}" sets thinking:"${profile.thinking}" but harness "${harnessDesc.name}" has no thinking-level channel (capabilities.thinking=false) — drop the profile's thinking field or pick a different harness`);
			}
		}

		let cwd: string;
		let resolvedBranch: string | undefined;
		let repo: string;
		let createdWorktree = false;
		if (opts.existingPath) {
			cwd = opts.existingPath;
			repo = opts.repo;
			resolvedBranch = (await worktreeStatus(cwd).catch(() => ({ branch: undefined }))).branch;
		} else {
			// PR-mode agents fork from a freshly-fetched origin default branch, not the local checkout's
			// (possibly stale, though the mode probe already checked convergence) HEAD.
			const landMode = await resolveLandMode(opts.repo);
			let startPoint: string | undefined;
			if (landMode.mode === "pr" && landMode.defaultBranch) {
				await hardenedGit(["fetch", "origin", landMode.defaultBranch], { cwd: opts.repo }).catch(() => undefined);
				startPoint = `origin/${landMode.defaultBranch}`;
			}
			const wt = await resolveWorktree(opts.repo, branch, addWorktree, isGitRepo, this.worktreeBaseDir, startPoint);
			cwd = wt.cwd;
			repo = wt.repo;
			resolvedBranch = wt.inPlace ? undefined : wt.branch;
			createdWorktree = !wt.inPlace;
			if (wt.inPlace) {
				// Non-git target dir: no isolation, but "spawn anywhere" still works. A real git checkout
				// that fails worktree creation now throws instead (OMPSQ-40) — never run on the shared tree.
				this.log("warn", `${opts.repo} is not a git repo — running agent in place (no isolation)`);
			} else if (!opts.sandbox && kind !== "flue-service") {
				// Live incident: every dispatched unit's verify-loop gate (`bun run check && bun run test`)
				// died with `CATASTROPHE: node "escalate" exceeded its visit cap` because a bare `git worktree
				// add` has no node_modules — the gate could never pass. `addWorktree`'s own symlink shortcut
				// only fires when the PRIMARY checkout already has node_modules AND never reaches a nested,
				// non-workspace package (this repo's own webapp/). Provision for real, bounded + non-fatal —
				// a failure here logs loudly but the spawn proceeds; the agent (or an operator) can still
				// install its own deps rather than never getting a worktree at all.
				//
				// NOT awaited (cross-lineage review HIGH 1): Dispatcher.tick serially awaits each spawn, so
				// an awaited cold install here stalls the whole dispatch tick (worst case ~minutes per
				// issue). The invariant is only "the verify gate must not run before provisioning settles" —
				// makeDriver's workflow execCommand awaits this promise before the FIRST gate command, and
				// `this.provisioning` self-cleans on settle. provisionWorktreeDeps never rejects by design.
				//
				// Scope (cross-lineage review MEDIUM 5): host-side coding-agent kinds only. Sandbox spawns
				// are skipped — the container is its own platform, and host-built node_modules (native
				// modules, platform-specific bins) can be wrong inside the mount; land-pr's scratch gate
				// deliberately differs (it host-installs because its docker gate bind-mounts the SAME host
				// dir and gateExec is a host-arch container, per installScratchDeps' own doc). Flue-service
				// is skipped — its driver runs from p.flue.dir, not this repo worktree, and commission()'s
				// installWorker already provisions that dir.
				const deps = this.spawnDepsInstaller(cwd).finally(() => {
					if (this.provisioning.get(id) === deps) this.provisioning.delete(id);
				});
				this.provisioning.set(id, deps);
			}
		}

		// MCP injection (omp-rpc family): the worktree exists now, agent.start() hasn't run yet. ACP's
		// mcpServers are instead threaded through makeDriver's AcpAgentDriver construction below — this
		// is the omp/pi half only, gated to that protocol so a workflow/flue/sandbox/ACP unit never gets a
		// stray `.omp/mcp.json` it can't read. A write failure logs but never blocks the spawn.
		if (harnessDesc?.protocol === "omp-rpc" && opts.mcp?.length) {
			await writeMcpConfig(cwd, opts.mcp).catch((err) => this.log("warn", `mcp config write failed for "${name}": ${String(err)}`));
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
			executionRole: opts.executionRole,
			// Persisted, not just passed: `captureAnswer` reads `rec.options.ask` at `agent_end`, and a unit
			// restored after a daemon restart must still know it owes an answer. Without this the unit runs,
			// answers, and the answer is silently dropped on the floor. (R5)
			ask: opts.ask,
			runtime: opts.runtime,
			harness: harnessDesc?.name,
			bin: opts.bin,
			mcp: opts.mcp,
			flue: opts.flue,
			workflow: opts.workflow ? { path: opts.workflow } : opts.verify ? { verify: { command: opts.verify, mode: opts.verifyMode } } : undefined,
			// Carry the resumable checkpoint so an adopted/restored workflow continues its graph from the
			// last node boundary instead of re-running completed stages (and duplicating their commits).
			workflowState: opts.workflowState,
			sandbox: opts.sandbox,
			parentId: opts.parentId,
			...lineageFieldsFrom(opts),
			featureId: opts.featureId,
			owns: opts.owns,
			requires: opts.requires,
			produces,
			scopeSource: opts.scopeSource,
			// Joined task-outcome row (concern 03): the durable "what we picked" record. `opts.verifyMode`
			// already carries `decision.mode` by this point when routeIntake ran above (it overwrote
			// `opts.verifyMode` at the routing call site) — so this formula covers BOTH the routed and the
			// explicit-verify-mode paths without re-deriving the router's decision here.
			routing: { mode: opts.verifyMode ?? "none", tier: tierOf(thinking), thinking, routedAt: Date.now(), routedModel },
			// Completion-push arm (voice-loop): a voice-sourced spawn (`/api/spawn` with `source:"voice"`)
			// owes the operator exactly one "finished" push once this dispatch's TERMINAL signal lands (see
			// onAgentEvent's "agent_end"/"workflow_done" handling — a workflow spawn arms here but only
			// fires once the whole graph, not an intermediate node, is done). Persisted so the latch
			// survives a daemon restart mid-dispatch. `opts.voicePushArmed` (not just `source`) also arms:
			// the orphan-adopt boot path (adoptOrphanedAgents) mints a fresh id via THIS same createWithId
			// rather than reusing the persisted record verbatim, so it carries the latch forward through
			// `opts` — without this an armed agent that restart-adopts under a new id silently loses the
			// one push it owed.
			voicePushArmed: source === "voice" || opts.voicePushArmed === true ? true : undefined,
		};

		// Delivery confirmation (concern 02 / DESIGN.md "Membrane measurement"): a requested efficiency
		// flag is only real when this unit's resolved harness actually carries `appendSystemPrompt` to the
		// child (contextInjection "native"). An ACP unit (contextInjection "none") requested one but never
		// got it — log it once for visibility (no consumer reads this yet; the flag itself is what a
		// future breaker/comparison keys on) rather than silently stamping a placebo.
		const confirmedEfficiencyFlags = confirmDeliveredFlags(requestedEfficiencyFlags, harnessDesc?.capabilities.contextInjection);
		if (requestedEfficiencyFlags?.length && !confirmedEfficiencyFlags) {
			this.log("info", `efficiency flags requested but not delivered on "${name}" (harness "${harnessDesc?.name ?? "unknown"}" contextInjection=${harnessDesc?.capabilities.contextInjection ?? "unknown"}): ${requestedEfficiencyFlags.join(", ")}`);
		}

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
			harness: harnessDesc?.name,
			harnessCaps: harnessDesc ? { toolApproval: harnessDesc.capabilities.toolApproval, resumable: harnessDesc.capabilities.resumable, hostTools: harnessDesc.capabilities.hostTools, contextInjection: harnessDesc.capabilities.contextInjection } : undefined,
			// NAMES ONLY (types.ts#AgentDTO.mcpServerNames) — never command/env/url/headers.
			mcpServerNames: opts.mcp?.length ? opts.mcp.map((s) => s.name) : undefined,
			executionRole: opts.executionRole,
			parentId: opts.parentId,
			...lineageFieldsFrom(opts),
			featureId: opts.featureId,
			owns: opts.owns,
			requires: opts.requires,
			produces,
			scopeSource: opts.scopeSource,
			workflow: persisted.workflow,
			workflowState: persisted.workflowState,
			forkAvailable: this.deriveForkAvailable(persisted.workflowState),
			adopted: opts.adopted,
		};
		// Pre-dispatch harness scorecard (concern 03, advisory shadow — plans/research-learn-harness-
		// engineering/03-harness-scorecard-shadow.md): a single post-worktree-cut score across the five
		// subsystems, so a context-poor unit is visible in the DTO from its very first emit instead of
		// after a wasted run. ADVISORY ONLY: computed and stamped here, never fed back into any decision
		// above (the throws/conflicts/WIP-cap checks all already ran) — this can only describe a spawn
		// that is already happening, never gate one.
		//
		// "instructions": for an issue-dispatched unit, a bare auto-generated "IDENTIFIER: name" title is
		// NOT real instructions — only the authored spec body (concern 01's specBlock) or a cold-start
		// primer counts. For an ad-hoc (non-issue) dispatch, the whole task string IS the instructions
		// (there's no separate title/body split), so a non-empty task suffices.
		// "tools": a profile capability grant OR an explicit requires/produces scope contract; neither ⇒
		// full unscoped access.
		// "environment": a resolved branch means a real, isolated worktree was cut (wt.inPlace and a
		// non-git existingPath both leave `resolvedBranch` undefined).
		// "state": a continuity anchor a restart/crash can reattach to — feature membership, a tracked
		// work item, or a resumable workflow checkpoint.
		// "feedback": a real completion loop (verify command or workflow graph), not a bare prompt.
		// A primer that was BUILT is not a primer that ARRIVED. An ACP unit has no system-prompt channel
		// (default `contextInjection: "none"`), so it runs unscoped no matter what we assembled above.
		//
		// Evaluated HERE, not at primeContext: `routeIntake` (above) can turn an ACP unit into a WORKFLOW
		// unit, whose inner omp child does have a native channel. Asking before the route gave the wrong
		// answer for exactly the units dispatch produces — an auto-routed ACP unit would be logged as
		// undelivered while its primer sailed through to the inner agent. (grok-4.5)
		const contextDelivers = contextReachesAgent(opts);
		const primerDelivered = primerBuilt && contextDelivers;
		if (primerBuilt && !primerDelivered) {
			// Measured from OUTSIDE the branch it measures — the mistake `primer-empty` made.
			this.learningMetrics.record("primer-undelivered", 1, { flag: "context-primer", variant: resolveHarnessName(opts) });
			this.log("warn", `${opts.name ?? "unit"}: context primer built but harness "${resolveHarnessName(opts)}" has no system-prompt channel — running unscoped (set OMP_SQUAD_ACP_CONTEXT=prompt to inject it)`);
		}
		if (harnessScorecardEnabled()) {
			dto.harnessScorecard = scoreHarness({
				// The authored spec rides the SAME `appendSystemPrompt` channel as the primer, so an ACP unit
				// receives neither — scoring it as instructed because a spec was composed is the same lie
				// the primer told. And a delivered primer IS instructions for an ad-hoc unit: `glance add
				// <name>` carries no task string, so the primer is its only orientation. (grok-4.5,
				// gpt-5.6-sol)
				hasInstructions: opts.issue ? (Boolean(specBlock) && contextDelivers) || primerDelivered : Boolean(opts.task?.trim()) || primerDelivered,
				toolsScoped: Boolean(toolGrants?.length || opts.requires?.length || produces?.length),
				isolatedEnvironment: Boolean(resolvedBranch),
				continuityAnchor: Boolean(opts.featureId || opts.issue || opts.workflowState),
				hasFeedbackGate: Boolean(opts.verify || opts.workflow),
			});
		}
		this.seedAuthority(dto, requestedMode);

		const agent = this.makeDriver(persisted, opts.cold);
		const rec: AgentRecord = { dto, agent, options: persisted, harness: harnessDesc, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map(), toolGrants, efficiencyFlags: confirmedEfficiencyFlags };
		// create() is shared by fresh spawns (no prior subagents) and the adoptOrphanedAgents/loadPersisted
		// restore paths (opts.subagents carries the persisted history) — reseed the tracker so a restored
		// workflow/agent's subagent tree starts warm instead of empty, same rationale as attachExisting.
		if (opts.subagents?.length) {
			rec.subs.applySnapshot(opts.subagents);
			// Restore-only closure (review finding, concern 02 follow-up): unlike attachExisting (a WARM
			// reconnect to a still-live host, where a "running" child may genuinely still be in flight),
			// this create() path builds a brand-new driver instance for a record that may never run again
			// as-is (e.g. `opts.adopted` — re-adopted from a surviving worktree, landed directly without a
			// re-run). A subagent left "running" in the persisted snapshot would otherwise claim that
			// forever. Stamp it aborted now, before the first frame, so no persisted node can outlive the
			// run that actually owned it.
			rec.subs.closeNonTerminal();
			if (rec.subs.isDirty()) {
				dto.subagents = mergeSubagents(opts.subagents, rec.subs.snapshot());
				persisted.subagents = dto.subagents;
				rec.subs.clearDirty();
			}
		}
		this.agents.set(id, rec);
		this.wire(rec);
		// Synthetic same-state "spawn" entry (#lifecycle-truth finding 4 / DESIGN's timeline-continuity
		// requirement) — records regardless of pending because "spawn" is an event-class reason, not
		// "turn-progress" (the only same-state reason transition() silently no-ops on). Marks the start of
		// every agent's timeline so `GET /api/agents/:id/transitions` never opens on an unexplained first
		// entry.
		this.transition(rec, dto.status, "spawn");
		this.emitAgent(rec);

		// Cold resume of a parallel fork node: any live roster branch agent left over from before the
		// restart (reattached separately by reconnectLive, or a stale record surviving in `this.agents`)
		// must be stopped BEFORE the driver's engine.run() re-enters runParallel, or the deterministic
		// branch id it re-spawns under would collide with createInternal's duplicate-id guard.
		if (opts.cold && kind === "workflow" && persisted.workflowState) await this.reconcileParallelResume(persisted);

		let started = false;
		try {
			await agent.start();
			started = true;
			this.transition(rec, "idle", "connect-ok");
			if (agent.setSessionName) await agent.setSessionName(`squad:${name}`).catch(() => {});
			this.emitAgent(rec);
			if (opts.task) {
				this.append(rec, "user", opts.task);
				rec.streaming = true;
				this.transition(rec, "working", "task-start");
				this.emitAgent(rec);
				await agent.prompt(opts.task).catch((err) => this.fail(rec, err));
			}
		} catch (err) {
			// start() (or its handshake) threw. `started` can only be false here — nothing after it is set
			// throws uncaught (setSessionName/prompt are both `.catch`-guarded above) — but keep the guard as
			// a floor for the worktree teardown, which is unique to this path: the worktree was created before
			// start() failed and nothing else reaps it (the gate's own failed-start test once orphaned 500+
			// "squad-leaky" worktrees). settleSpawnFailure then stops the (possibly half-spawned) driver so no
			// detached host / ACP child / sandbox container leaks (OMPSQ-163, OMPSQ-146) and marks error — the
			// SAME shared stop-before-fail path the prompt/set-model/restart sites use.
			if (!started && createdWorktree) {
				// Reaping the worktree here prevents a leak (a failed-start test once orphaned 500+ of them),
				// but it also destroys the evidence: the operator later finds an errored unit whose worktree
				// "never existed". Record whether it was there when the spawn failed, before removing it.
				this.log("warn", `${name}: spawn failed with the worktree ${existsSync(cwd) ? "PRESENT" : "ALREADY GONE"} at ${cwd} — removing it`);
				await removeWorktree(repo, cwd).catch(() => {});
			}
			await this.settleSpawnFailure(rec, err);
		}

		await this.persist();
		const failed = rec.dto.status === "error";
		void this.recordAudit(actor, "create", rec.dto.id, failed ? "error" : "ok", failed ? rec.dto.error : truncate(opts.task ?? rec.dto.name, 80), source);
		return rec.dto;
	}

	/** Injectable seam over provisionWorktreeDeps (tests stub slow/failing installs without touching a
	 *  real `bun install`). Kicked — not awaited — by createWithId; see `this.provisioning`. */
	private spawnDepsInstaller(cwd: string): Promise<void> {
		return provisionWorktreeDeps(cwd, (msg) => this.log("warn", `spawn provisioning: ${msg}`));
	}

	/** The harness descriptor backing a plain-agent record — undefined for workflow/flue kinds, which use
	 *  their own drivers. Same resolution choke point makeDriver uses, so reattach/reconnect records get the
	 *  same capability gating as freshly-created ones. */
	private harnessFor(p: PersistedAgent): HarnessDescriptor | undefined {
		if ((p.kind ?? "omp-operator") !== "omp-operator") return undefined;
		// Tolerant on the restore/gating paths: an unknown persisted harness name (removed/renamed across a
		// daemon up/downgrade) must not throw out of a bulk adopt sweep. create() still resolves explicitly
		// (fail-loud) for a fresh spawn; here we degrade to "unknown ⇒ undefined" (treated as omp-default).
		try {
			return resolveHarness(p);
		} catch {
			return undefined;
		}
	}

	/** Whether a persisted agent's harness survives a daemon restart. ACP harnesses are direct child spawns
	 *  with no detached host over a socket, so on restart they're already dead — they can't be reattached
	 *  (reconnectLive's hostAlive probe fails) NOR soundly cold-adopted (a fresh ACP session loses the prior
	 *  one, and session/load is capability-gated). So they're excluded from the adopt path rather than
	 *  orphan-respawned. omp/pi (detached host) and workflow/flue (own resume) all return true. */
	private harnessResumable(p: PersistedAgent): boolean {
		return this.harnessFor(p)?.capabilities.resumable ?? true;
	}

	private makeDriver(p: PersistedAgent, cold = false): AgentDriver {
		if (p.kind === "flue-service" && p.flue) {
			return new FlueServiceDriver({ dir: p.flue.dir, workflow: p.flue.workflow, target: p.flue.target });
		}
		if (p.kind === "workflow" && p.workflow) {
			const workflow = p.workflow.verify ? buildVerifyLoop(p.workflow.verify) : undefined;
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
			// Defensive floor, not the primary guard: resumable()/reconnectLive/adoption already exclude
			// terminal-marked runs from ever reaching here with intent to resume. But a legacy full
			// re-spawn path (`loadPersisted`, the `--restore` CLI flow) passes `workflowState` through
			// unconditionally regardless of `terminal` — so a terminal run never gets a resumable
			// resumeState here either, even if some future caller forgets the exclusion upstream.
			const resumeState = p.workflowState?.terminal ? undefined : p.workflowState;
			// Reflexion (concern 04): only meaningful for a SYNTHESIZED verify loop (buildVerifyLoop's
			// "fixup" node id is the one it targets); wiring it is cheap (no LLM call unless the flag is
			// on AND the run actually reaches its 2nd+ fixup), so it's always passed for a verify-mode run.
			const reflection = workflow ? { stateDir: this.stateDir, repo: p.repo, agentId: p.id } : undefined;
			// Command nodes (the `verify` gate) run agent-authored scripts. Route them through the shared
			// gated-exec path so they get the SAME scrubbed env + docker sandbox as every other gate
			// (proof/land/main gate). Without this the executor's defaultExecCommand runs them with the full
			// daemon env (Plane/LLM keys, dashboard bearer) and no sandbox: the one gate that skipped the
			// hardening every other gate enforces. Mount p.repo so the worktree's shared git object store
			// stays reachable inside the sandbox.
			// Await any in-flight spawn provisioning FIRST (cross-lineage review HIGH 1): createWithId kicks
			// the install without awaiting so the dispatch tick stays fast; the gate is the point the
			// invariant actually binds ("never run the verify gate against an unprovisioned tree"). A
			// missing/settled entry awaits nothing; provisionWorktreeDeps never rejects by design.
			const execCommand = async (script: string, cwd: string) => {
				await this.provisioning.get(p.id);
				return execGatedCommand(script, cwd, { mounts: [p.repo] });
			};
			return new WorkflowDriver({ id: p.id, appendSystemPrompt: p.appendSystemPrompt, workflow, workflowPath: p.workflow.path ? resolveWorkflowPath(p.workflow.path) : undefined, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, bin: this.bin, fleet, resumeState, decoratePrompt, execCommand, cold, reflection });
		}
		// Plain-agent path: resolve the harness (explicit `harness`, else the legacy `runtime` alias,
		// else GLANCE_HARNESS/"omp"). This is the single migration choke point — a persisted `runtime:"acp"`
		// record restores an ACP driver here instead of silently respawning as omp on a daemon upgrade.
		const harness = resolveHarness(p);
		const bin = resolveBin(harness, p.bin);
		if (p.sandbox) {
			// sandbox × non-omp is a matrix, not a list: SandboxAgentDriver is an omp-RPC client over
			// `docker exec` stdio and can only speak to omp. create() rejects sandbox+non-omp; this is the
			// belt-and-suspenders floor (Phase 3 makes containment protocol-aware).
			return new SandboxAgentDriver({ id: p.id, image: p.sandbox.image, workdir: p.sandbox.workdir, mount: p.sandbox.mountWorktree === false ? undefined : p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, appendSystemPrompt: p.appendSystemPrompt, runArgs: p.sandbox.runArgs });
		}
		if (harness.protocol === "acp") {
			// The model's argv POSITION is per-harness (grok's --model belongs to `grok agent`, not to its
			// `stdio` subcommand) — so compose through the registry, never by appending here.
			const command = resolveAcpCommand(harness, p.model);
			// ACP has no system-prompt slot, so omp-squad context (fabric primer + tool-grant scoping) is
			// injected only when the operator opts in (OMP_SQUAD_ACP_CONTEXT=prompt); default "none" runs the
			// unit UNSCOPED (honest — surfaced via the capability). approvalMode is mapped best-effort to an
			// ACP session mode inside the driver.
			// Single-sourced with the scorecard's honesty predicate so the two can never drift: whatever
			// `contextReachesAgent` promised at create() is exactly what the driver does here.
			const contextInjection = contextReachesAgent(p) ? "prompt" : "none";
			const acp = new AcpAgentDriver({ id: p.id, cwd: p.worktree, model: p.model, command, approvalMode: p.approvalMode, appendSystemPrompt: p.appendSystemPrompt, contextInjection, mcpServers: p.mcp, harness: harness.name });
			acp.on("acpcapabilities", (caps: unknown) => this.log("info", `acp ${harness.name} ${p.id} advertised capabilities: ${JSON.stringify(caps)}`));
			return acp;
		}
		// omp-rpc protocol family (omp, pi, …): same detached agent-host transport, harness name threaded
		// so the host builds the right approval-flag dialect + extension set for this binary.
		return new RpcAgent({ id: p.id, cwd: p.worktree, model: p.model, approvalMode: p.approvalMode, thinking: p.thinking, appendSystemPrompt: p.appendSystemPrompt, bin, harness: harness.name });
	}

	/**
	 * Deterministic branch agent ids for `p`'s current fork node whose recorded disposition is NOT
	 * resolved (`not_attempted`, or absent entirely — the engine emits a fork's entry checkpoint with no
	 * `branchOutcomes` before any branch completes, so a crash in that window must treat every key as
	 * effectively not-attempted). These are exactly the ids a resumed `runParallel` WILL re-spawn — a
	 * `succeeded`/`failed` key is never touched by resume (the join folds its recorded outcome straight
	 * in), so it's excluded here. Returns an empty set if `p` isn't a workflow parked at a parallel node,
	 * or its graph can't be parsed (best-effort — never blocks resume).
	 */
	private async unresolvedBranchIds(p: PersistedAgent): Promise<Set<string>> {
		const ws = p.workflowState;
		const graphPath = p.workflow?.path;
		if (!ws || !graphPath) return new Set();
		let wf: Workflow;
		try {
			wf = parseWorkflow(await fs.readFile(resolveWorkflowPath(graphPath), "utf8"));
		} catch {
			return new Set(); // best-effort — an unreadable/malformed graph leaves reconciliation a no-op
		}
		const fork = wf.nodes.get(ws.currentNode);
		if (!fork || fork.kind !== "parallel") return new Set();
		const runId = ws.runId ?? p.id;
		// Same formula runParallel uses for the fan-out it's about to re-enter (engine.ts).
		const visitIndex = ws.visits[fork.id] ?? 0;
		const branchIds = wf.edges.filter((e) => e.from === fork.id).map((e) => e.to);
		const dispositions = ws.branchOutcomes ?? {};
		const ids = new Set<string>();
		for (let i = 0; i < branchIds.length; i++) {
			const key = `${fork.id}#${visitIndex}:${i}`;
			const disposition = dispositions[key]?.disposition;
			if (disposition === "succeeded" || disposition === "failed") continue;
			ids.add(deriveBranchAgentId(runId, key, branchIds[i]!));
		}
		return ids;
	}

	/**
	 * Cold resume of a parallel fork node: stop every live roster agent whose deterministic branch id is
	 * one `unresolvedBranchIds` says the resumed `runParallel` will re-spawn — cleaning up a stale record
	 * from before the restart (or a first_success crash-window loser `reconnectLive` already reattached —
	 * it has no parentId filter) so the re-spawn's deterministic id is free.
	 *
	 * Review finding 1: this used to ALSO stop+delete every already-`succeeded`/`failed` branch agent —
	 * contradicting `spawnFleetBranch`'s own contract ("the agent stays in the roster") and destroying the
	 * winner's transcript/receipts/worktree visibility on every single resume of a fan-out node, even a
	 * routine graceful restart. A resolved branch is never re-run by the resumed join (it folds the
	 * recorded disposition straight in), so there is nothing to reconcile for it — leave it untouched.
	 *
	 * Stopped ids are remembered in `reconciledStops` so the re-spawn that follows knows to append a
	 * "resuming after a restart" note to the branch's re-prompt. Teardown otherwise mirrors remove()'s:
	 * emit `{type:"removed"}` and persist so clients/the on-disk snapshot converge immediately instead of
	 * carrying a ghost roster entry until some unrelated later persist.
	 */
	private async reconcileParallelResume(p: PersistedAgent): Promise<void> {
		const ids = await this.unresolvedBranchIds(p);
		if (!ids.size) return;
		let stoppedAny = false;
		for (const id of ids) {
			const rec = this.agents.get(id);
			if (!rec) continue;
			await rec.agent.stop().catch(() => {});
			this.agents.delete(id);
			this.reconciledStops.add(id);
			this.emit("event", { type: "removed", id } satisfies SquadEvent);
			stoppedAny = true;
		}
		if (stoppedAny) await this.persist();
	}

	/** Spawn a real roster agent for a workflow's parallel branch, run the task, resolve with its result. The agent stays in the roster. */
	private async spawnFleetBranch(repo: string, parentId: string, spec: BranchSpec): Promise<NodeResult> {
		// Hard ceiling even bypass-cap fan-out respects: a workflow may spawn its declared branches,
		// but never past an absolute live-agent ceiling — runaway/looping fan-out otherwise melts the
		// host (observed: 88 omp procs at load 160). ponytail: counts roster agents, not OS PIDs (each
		// agent is several processes), so keep the ceiling conservative. Upgrade path: count host PIDs.
		const live = liveAgents(this.list());
		if (live >= hardAgentCeiling()) {
			// A transient resource condition, not a genuine execution — notAttempted so resume re-spawns it.
			return { outcome: "failed", notAttempted: true, text: `agent ceiling reached (${live}/${hardAgentCeiling()}) — branch "${spec.name}" not spawned` };
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
			return { outcome: "failed", notAttempted: true, text: `${reason} — branch "${spec.name}" not spawned` };
		}
		// Deterministic id: hash8(runId+":"+branchKey) + a slug of the branch node's own id (spec.name),
		// so re-running the exact same fan-out slot (a resume, or a re-spawn of a not_attempted key) reuses
		// the same agent id and worktree. Absent runId/branchKey (no fleet-driven caller, e.g. a bare test
		// harness) falls back to a fresh id — sequential-branch execution never needs determinism.
		const id = spec.runId && spec.branchKey ? deriveBranchAgentId(spec.runId, spec.branchKey, spec.name) : undefined;
		// Self-heal (review finding 3): a stale roster record can still be sitting under this exact
		// deterministic id — reconcileParallelResume no-op'd on an unreadable/malformed graph, or an
		// in-flight pre-restart spawn inserted the id into the roster AFTER reconcile's scan already ran.
		// Without this, createInternal's duplicate-id guard below throws, runOne's catch aborts the
		// controller, and the ENTIRE fan-out's siblings are torn down over one stale slot. `id` is a pure
		// hash of (runId, branchKey, nodeId), so by construction a record already under it can only ever be
		// a prior attempt at this exact same branch — never a genuinely foreign collision — so it's always
		// safe to tear down and reuse. createInternal's own guard still stands for any id NOT derived here
		// (e.g. fork()'s ids), so a real foreign collision is still rejected.
		if (id && this.agents.has(id)) {
			const stale = this.agents.get(id)!;
			await stale.agent.stop().catch(() => {});
			this.agents.delete(id);
			this.reconciledStops.add(id);
			this.emit("event", { type: "removed", id } satisfies SquadEvent);
		}
		// reconcileParallelResume (or the self-heal above) just stopped a live agent under this exact id
		// ahead of this re-spawn: prior partial work may already sit in the reused worktree — say so in the
		// re-prompt.
		const task = id && this.reconciledStops.delete(id) ? `${spec.task}\n\n(Resuming after a restart — prior partial work may already exist in this worktree; continue from where it left off.)` : spec.task;
		const dto = await this.createInternal({ repo, name: spec.name, model: spec.model, approvalMode: spec.approvalMode, parentId, autoRoute: false, bypassCap: true, explicitId: id ?? newAgentId(spec.name), parentNodeId: spec.parentNodeId, branchIndex: spec.branchIndex }, LOCAL_ACTOR);
		const rec = this.agents.get(dto.id);
		if (!rec) return { outcome: "failed", notAttempted: true, text: "branch agent not created" };
		// Persisted (not sent as create()'s own auto-prompt — runAgentTask below owns the actual send and
		// completion tracking) so the branch's task survives on the roster record for display/audit.
		rec.options.task = task;
		return this.runAgentTask(rec, task, spec.signal);
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
		// exit/abort never genuinely completed a turn (process crash / teardown, not an executed result) —
		// notAttempted so a resumed fan-out re-spawns this branch instead of recording a permanent "failed".
		// The 30-min timeout below is the deliberate exception: it DID execute and burn its whole budget, so
		// it records as a real "failed" (auto-respawning it on every resume would loop; fork is the retry path).
		// Review finding 8: an UNEXPECTED exit stays not_attempted (re-spawnable) — but a DELIBERATE operator
		// kill (applyCommand's "kill" case sets `rec.killedByOperator` before calling `stop()`, which raises
		// this same "exit") must record a permanent "failed" so a resume never silently re-spawns a branch the
		// operator just killed. Consumed (cleared) here so a stale flag can never leak into a later run under
		// the same record.
		const onExit = () => {
			const killed = rec.killedByOperator === true;
			rec.killedByOperator = false;
			finish("failed", !killed);
		};
		const onAbort = () => {
			void rec.agent.stop().catch(() => {});
			this.transition(rec, "stopped", "abort");
			this.emitAgent(rec);
			finish("failed", true);
		};
		const timer = setTimeout(() => finish("failed"), 30 * 60_000);
		const finish = (outcome: "succeeded" | "failed", notAttempted?: boolean): void => {
			clearTimeout(timer);
			rec.agent.off("event", onEvent);
			rec.agent.off("exit", onExit);
			signal?.removeEventListener("abort", onAbort);
			resolve({ outcome, text: buf.trim(), notAttempted });
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
		this.transition(rec, "working", "branch-start");
		this.emitAgent(rec);
		void rec.agent.prompt(task).catch(() => finish("failed", true));
		return promise;
	}

	/**
	 * Author → validate → onboard a Flue worker (an agent that fills a job).
	 * On a failed gate nothing is onboarded — the candidate is rejected.
	 */
	async commission(spec: CommissionSpec, opts: CommissionOptions = {}, actor: Actor = LOCAL_ACTOR, source?: string): Promise<CommissionResult> {
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
			void this.recordAudit(actor, "commission", spec.name, "error", report ? "gate failed" : "no candidate", source);
			return { ok: false, report: report ?? { ok: false, checks: [] }, dir };
		}
		void this.recordAudit(actor, "commission", spec.name, "ok", truncate(spec.purpose, 80), source);
		return { ok: true, report, member: executor.member, dir };
	}

	private async installWorker(dir: string): Promise<void> {
		// dir is tenant repo content — its root package.json can run a postinstall under `bun install`
		// (bun blocks dependency lifecycle scripts but always runs the project's own), so scrub the
		// daemon's secrets from this spawn like every other tenant-agent site (spawn-env.ts). No harness
		// auth injection needed: `bun install` never makes a model call.
		const proc = Bun.spawn(["bun", "install"], { cwd: dir, env: scrubbedSpawnEnv(process.env), stdout: "pipe", stderr: "pipe" });
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
		const rec: AgentRecord = { dto, agent: this.makeDriver(persisted), options: persisted, harness: this.harnessFor(persisted), transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
		this.agents.set(id, rec);
		this.wire(rec);
		try {
			await rec.agent.start();
		} catch (err) {
			// Reachable from applyCommand's "commission" case (via CommissionExecutor's uncaught "onboard"
			// runAction), which the WS/HTTP command routes fire off with `void applyCommand(...).catch(...)`.
			// Deliberately NOT settleSpawnFailure here: that leaves a sticky "error" roster entry, which is
			// right for the prompt/set-model/restart paths (those are real, operator-owned agents the user
			// acts on) but WRONG for a never-onboarded flue worker — rethrowing propagates up through the
			// commission workflow so commission() rejects (never returns a member), meaning an error record
			// left here would be an owner-less roster ghost (the inconsistency the review flagged). Stop the
			// possibly-half-spawned host so nothing leaks, then REMOVE the record entirely (mirrors
			// reconcileParallelResume's teardown: delete + emit removed + persist) before rethrowing so the
			// commission workflow still learns the onboard step failed.
			await rec.agent.stop().catch(() => {});
			this.agents.delete(id);
			this.emit("event", { type: "removed", id } satisfies SquadEvent);
			await this.persist();
			throw err;
		}
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
		const rec: AgentRecord = { dto, agent: this.makeDriver(p), options: p, harness: this.harnessFor(p), transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
		this.agents.set(p.id, rec);
		this.wire(rec);
		await rec.agent.start();
		this.emitAgent(rec);
	}

	private async ensureConnected(rec: AgentRecord): Promise<void> {
		if (rec.agent.isAlive && rec.agent.isReady) return;
		rec.dto.error = undefined;
		this.transition(rec, "starting", "connect-begin"); // explicit-class: legal from stopped/error
		this.emitAgent(rec);
		await rec.agent.start();
		if (rec.agent.setSessionName) await rec.agent.setSessionName(`squad:${rec.dto.name}`).catch(() => {});
		this.transition(rec, "idle", "connect-ok");
		this.emitAgent(rec);
	}

	/**
	 * The ONE settle path for a `start()`/`ensureConnected` rejection on an in-roster agent — STOP the
	 * (possibly half-spawned) driver, THEN mark the record's error state, always in that order.
	 *
	 * A failed spawn is not inert: `RpcAgent.start()` can spawn a detached agent-host and connect its
	 * socket, then reject because the omp child died before ready (or the whole respawn budget expired) —
	 * leaving a live orphan host + socket behind. ACP/sandbox drivers likewise fork a child/container
	 * before a handshake can fail, and nothing else reaps them (OMPSQ-163, OMPSQ-146). Every failing
	 * start()/reconnect used to hand-roll `await agent.stop().catch(()=>{})` + `fail()` (or, in three of
	 * four sites, forget the stop entirely — the zombie-host class this repo fought all week). Funnelling
	 * them through here keeps stop-before-fail from ever drifting apart again. createWithId layers
	 * worktree teardown on top of this; the commission/onboard path removes the record entirely instead
	 * (a never-onboarded worker shouldn't linger as a roster ghost) — see each call site.
	 */
	private async settleSpawnFailure(rec: AgentRecord, err: unknown): Promise<void> {
		await rec.agent.stop().catch(() => {});
		this.fail(rec, err);
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
		// `source` (voice/composer provenance) rides along when the command carried one — observability
		// only, never consulted above at the RBAC gate.
		if (need !== "viewer") {
			const source = commandSource(cmd);
			await this.store
				.appendAudit({ actor: actor.id, action: cmd.type, target: commandTarget(cmd), ...(source !== undefined ? { source } : {}) })
				.catch((err) => this.log("warn", `audit write failed for \"${cmd.type}\": ${err instanceof Error ? err.message : String(err)}`));
		}
		if (cmd.type === "create") {
			await this.create(cmd.options, actor, commandSource(cmd));
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
			await this.commission(cmd.spec, {}, actor, commandSource(cmd));
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
		// rm-doesn't-stick fix: handled BEFORE the `rec` gate below, deliberately. Every other command
		// in the switch requires the target to be resident (`if (!rec) return`) — but that is exactly
		// the race that broke `rm`: in DB-root mode an org's manager can be evicted/lazily-recreated
		// between requests, so a `rm` for a real (persisted, just not-yet-reattached) id would silently
		// no-op here, leaving the persisted row untouched for the next start() to reattach verbatim.
		// `remove()` durably tombstones the id whether or not it's currently resident.
		if (cmd.type === "remove") {
			const found = await this.remove(cmd.id, cmd.deleteWorktree ?? false);
			void this.recordAudit(actor, "remove", cmd.id, "ok", found ? (cmd.deleteWorktree ? "deleted worktree" : undefined) : "not resident on this instance — tombstoned anyway");
			return;
		}

		const rec = this.agents.get(cmd.id);
		if (!rec) return;

		switch (cmd.type) {
			case "prompt": {
				// A terminal-marked workflow is now reachable via `this.agents.get(id)` after a restart
				// (reattachTerminal) — without this guard, `ensureConnected` would start its never-run
				// driver (resumeState-stripped, so no execRun yet) and THIS prompt would land as the
				// driver's "first prompt", re-entering the graph from scratch via `execRun` exactly like
				// `restart()`'s own guard above prevents. Fork (concern 04) is the only forward path.
				if (rec.options.kind === "workflow" && rec.options.workflowState?.terminal) {
					this.log("warn", `refused prompt to terminal-marked workflow ${rec.dto.name}: ${rec.options.workflowState.terminal.reason} — fork instead`);
					this.append(rec, "system", `prompt refused — this run is terminal (${rec.options.workflowState.terminal.reason}). Fork from a checkpoint to try again.`);
					break;
				}
				// A harness that can't start (bad bin, cold-start death that exhausts the respawn budget, …)
				// throws out of ensureConnected. This call sat BARE here — unlike promptConnected just below,
				// which every caller wraps in `.catch((err) => this.fail(rec, err))` — so the rejection had no
				// catcher anywhere in this function and propagated straight out of applyCommand. Every
				// applyCommand caller (the WS command handler, the HTTP command route) fires it with
				// `void manager.applyCommand(...).catch(...)`: a rejection surfacing THERE is an unhandled
				// promise rejection, which took the whole daemon down (reproduced: a console-chat prompt to an
				// agent whose harness fails to (re)start). settleSpawnFailure stops the half-spawned host
				// (RpcAgent.start() can connect a detached host then reject before ready — a live orphan) and
				// marks error, the same legible surface every other spawn/prompt failure uses. Never let the
				// message become the agent's "first prompt" once it (maybe) reconnects later.
				try {
					await this.ensureConnected(rec);
				} catch (err) {
					await this.settleSpawnFailure(rec, err);
					break;
				}
				this.log("info", `${actor.id} → ${rec.dto.name}: ${truncate(cmd.message, 80)}`);
				// A new instruction makes every decision the auto-loop already took about this unit stale.
				// Its in-memory `staged`/`landed`/`halted` sets are keyed by ids that a steered agent's edits
				// never change, so without this the work a steer produces is skipped forever — verified never,
				// landed never. (The durable, HEAD-keyed records go stale on their own.) See
				// `Orchestrator.invalidate`. Found by cross-lineage review (gpt-5.6-sol).
				this.orchestrator?.invalidate(rec.dto.id, rec.dto.featureId);
				// `text` is the durable audit/debug record — the full context-augmented message the
				// agent actually received. `displayText` (when the client sent one) is the user's bare
				// typed text; the UI renders that and falls back to `text` for older clients.
				this.append(rec, "user", cmd.message, { clientTurnId: cmd.clientTurnId, displayText: cmd.displayText });
				// Completion-push arm (voice-loop): a voice-sourced prompt owes the operator exactly one
				// "finished" push once this dispatch settles — armed here (persisted, restart-safe),
				// disarmed by the push actually sending or by a voice-sourced interrupt (see the "interrupt"
				// case below and push.ts's `voiceDonePayload`). Re-arming an already-armed agent (a second
				// voice prompt before the first one's push fired) is a harmless no-op write.
				if (commandSource(cmd) === "voice" && rec.options.voicePushArmed !== true) {
					rec.options.voicePushArmed = true;
					void this.persist();
				}
				rec.streaming = true;
				this.transition(rec, "working", "task-start");
				this.emitAgent(rec);
				await this.promptConnected(rec, cmd.message).catch((err) => this.fail(rec, err));
				void this.recordAudit(actor, "prompt", cmd.id, "ok", truncate(cmd.message, 80), commandSource(cmd));
				break;
			}
			case "set-model": {
				const model = cmd.model.trim();
				if (!model || !rec.agent.setModel) break;
				// TWO distinct failure classes, deliberately NOT one try: ensureConnected transitioned the DTO
				// to "starting" already, so a SPAWN failure here strands the agent in "starting" forever AND
				// leaks the half-spawned host — settle it to error (stop + fail), the model note riding along.
				// A setModel() failure AFTER a successful connect is different: the agent is live and healthy,
				// just couldn't switch models — never stop/error a good agent over that; keep the old model and
				// surface a note, as before.
				try {
					await this.ensureConnected(rec);
				} catch (err) {
					const detail = errText(err);
					this.append(rec, "system", `model change failed: ${detail}`);
					await this.settleSpawnFailure(rec, err);
					void this.recordAudit(actor, "set-model", cmd.id, "error", detail);
					break;
				}
				try {
					await rec.agent.setModel(model);
					rec.dto.model = model;
					this.append(rec, "system", `model set to ${model}`);
					this.emitAgent(rec);
					void this.recordAudit(actor, "set-model", cmd.id, "ok", model);
				} catch (err) {
					const detail = errText(err);
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
				// Completion-push disarm (voice-loop): the operator cancelled the work themselves — a
				// "finished" push would be a lie. Deliberately source-blind: a TYPED stop of voice-dispatched
				// work is still the operator killing it (the cancel's own agent_end would otherwise read as a
				// terminal idle and fire the push). Clears both the persisted latch and its DTO projection so
				// no stale `true` can ride a later unrelated idle transition.
				if (rec.options.voicePushArmed === true) {
					rec.options.voicePushArmed = false;
					rec.dto.voicePushArmed = false;
					void this.persist();
				}
				void this.recordAudit(actor, "interrupt", cmd.id, "ok", undefined, commandSource(cmd));
				break;
			case "kill":
				// Review finding 8: mark BEFORE stop() — a branch agent's `onExit` listener (runAgentTask) fires
				// synchronously off the driver's "exit" event raised inside stop(), so the flag must already be
				// set by the time it checks. Distinguishes a deliberate operator kill (permanent "failed"
				// disposition, never re-spawned by a resume) from an unexpected exit/crash ("not_attempted",
				// re-spawnable) — harmless no-op for a non-branch agent, which never reads this flag.
				rec.killedByOperator = true;
				await rec.agent.stop();
				this.transition(rec, "stopped", "kill");
				this.emitAgent(rec);
				void this.recordAudit(actor, "kill", cmd.id);
				break;
			case "restart":
				await this.restart(rec);
				void this.recordAudit(actor, "restart", cmd.id);
				break;
			case "fork":
				await this.fork(cmd.id, { seq: cmd.seq }, actor);
				break;
			case "notify": {
				// Operator/scriptable ingress (`glance notify`, cmux-research concern 03): non-blocking,
				// never a PendingRequest — mirrors squad_attention/the harness "notify" wiring below.
				const event: AttentionEvent = { id: randomUUID(), summary: cmd.summary, detail: cmd.detail, source: "notify", createdAt: Date.now() };
				rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
				this.append(rec, "system", `🔔 attention (${actor.id}): ${truncate(cmd.summary, 200)}`);
				void this.recordAudit(actor, "notify", cmd.id, "ok", truncate(cmd.summary, 120));
				this.emitAgent(rec);
				break;
			}
			default:
				// An old daemon receiving a command type it predates (e.g. concern 04's "fork") must error
				// loudly instead of silently no-oping — the switch falling through with no default let a
				// version-skewed daemon look like it accepted a command it never acted on.
				throw new Error(`unknown command type: ${(cmd as { type?: string }).type}`);
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
		// streaming=true BEFORE setPending (behavior-identical reorder from the prior mutate-then-derive
		// ordering): setPending's own derive() then sees streaming already true, so answering while no
		// other pending remains records exactly one input→working entry, not a phantom pair.
		rec.streaming = true;
		this.setPending(rec, rec.dto.pending.filter((p) => p.id !== req.id), "pending-answer");
		this.append(rec, "system", `${actor.id} answered "${req.title}": ${truncate(value, 60)}`, { pending: { requestId: req.id, action: "answered" }, status: "ok" });
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
		// A UI frame replayed during settle must not trigger an auto-answer against a request the
		// operator already answered pre-crash — the replay's live correlation id makes it indistinguishable
		// from a fresh request otherwise.
		if (this.settling.has(rec.dto.id)) return;
		if (req.gateClass) {
			this.log("info", `autosupervise: SKIP gate "${req.title}" on ${rec.dto.name} (never auto-answered)`);
			return;
		}
		const value = chooseFallback(req);
		if (!value) return; // nothing safe + deterministic to answer (e.g. a host-tool call) → leave for a human
		if (this.isRiskyRequest(req)) {
			this.log("info", `autosupervise: SKIP risky "${req.title}" on ${rec.dto.name} (left for human)`);
			return;
		}
		const budget = envInt("OMP_SQUAD_AUTOSUPERVISE_BUDGET", 5);
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
		// A terminal-marked workflow agent refuses to restart: restart() always rebuilds a fresh inner
		// thread and re-enters the graph, which would silently re-trip the exact escalate condition this
		// marker exists to stop. Fork (concern 04) is the only forward path once a run is terminal.
		if (rec.options.kind === "workflow" && rec.options.workflowState?.terminal) {
			this.log("warn", `refused restart of terminal-marked workflow ${rec.dto.name}: ${rec.options.workflowState.terminal.reason} — fork instead`);
			this.append(rec, "system", `restart refused — this run is terminal (${rec.options.workflowState.terminal.reason}). Fork from a checkpoint to try again.`);
			return;
		}
		await rec.agent.stop();
		// restart() always rebuilds a fresh inner thread — cold:true for a workflow agent so the resumed
		// run keeps the poison cap active (warm/non-cold would silently bypass RESUME_ATTEMPT_CAP: the
		// engine only checks it when resume.cold is set).
		const cold = rec.options.kind === "workflow";
		// Review finding 2: an explicit operator restart is a DELIBERATE fresh attempt, not a symptom of the
		// crash-loop the poison cap exists to catch — reset the checkpoint's own resumeAttempts counter here,
		// before building the driver, so three manual restart nudges of an otherwise-healthy in-flight node
		// don't cumulatively trip RESUME_ATTEMPT_CAP(3) and permanently terminal-mark it. `cold` above stays
		// true (the engine must still CHECK the cap on this resume); only the counter it checks resets.
		// Daemon-crash resume paths (adoptOrphanedAgents' cold:true adopt) are untouched — repeated crash-loop
		// resumes of the same genuinely-poisoned node must keep accumulating toward the cap.
		if (cold && rec.options.workflowState) {
			rec.options.workflowState.resumeAttempts = 0;
			rec.dto.workflowState = rec.options.workflowState;
		}
		const fresh = this.makeDriver(rec.options, cold);
		rec.agent = fresh;
		rec.streaming = false;
		// A fresh driver is a fresh process/session — any turn completion recorded against the OLD one must
		// not immunize a crash of the NEW one against the exit classifier above (a restarted agent that dies
		// before completing a turn on this attempt is a genuine crash, not teardown of an already-finished run).
		rec.completedTurn = false;
		// callerOwnsStatus: clear pending without letting setPending derive+record its own transition —
		// otherwise a working agent with an already-empty queue would get a spurious working->idle
		// "pending-cancel" ledger entry immediately ahead of the real "restart" one below.
		this.setPending(rec, [], "pending-cancel", undefined, { callerOwnsStatus: true });
		this.transition(rec, "starting", "restart");
		rec.dto.error = undefined;
		// Close out any subagent left non-terminal by the run that's about to be torn down (killed mid-flight
		// or never got its terminal frame before the daemon died) and flush the merge BEFORE clearing, so the
		// persisted history can never claim "running" under a stopped/restarted agent.
		rec.subs.closeNonTerminal();
		if (rec.subs.isDirty()) {
			rec.dto.subagents = mergeSubagents(rec.options.subagents, rec.subs.snapshot());
			rec.options.subagents = rec.dto.subagents;
			rec.subs.clearDirty();
			void this.persist();
		}
		rec.subs.clear();
		this.wire(rec);
		// Surface the prior session's digest, fenced as untrusted data, so the operator immediately
		// sees where they left off. Surfacing only — never auto-prompt the live agent (no silent spend).
		// ponytail: no dedicated TUI/web treatment yet (YAGNI) — getDigest() + this entry suffice.
		const digest = await readDigest(this.stateDir, rec.dto.id);
		if (digest) this.append(rec, "system", "📒 Resume digest — prior session memory:\n" + fenceUntrusted("resume digest", digest));
		this.emitAgent(rec);
		// Same cold-resume-of-a-parallel-node protocol as the adoption path (createWithId): stop any live
		// branch agent left over from before the restart so the re-entered runParallel's deterministic ids
		// are free.
		if (cold && rec.options.workflowState) await this.reconcileParallelResume(rec.options);
		try {
			await fresh.start();
			this.transition(rec, "idle", "connect-ok");
		} catch (err) {
			// `fresh` is a brand-new driver that may have spawned a detached host then rejected before ready
			// — bare fail() left that orphan alive. settleSpawnFailure stops it before marking error.
			await this.settleSpawnFailure(rec, err);
		}
		this.emitAgent(rec);
	}

	/**
	 * fork(id, {seq?}): mint a brand-new run from a terminal (escalate-exhausted) workflow's checkpoint
	 * history — same code tip (`git rev-parse HEAD` in the original worktree, never `dto.branch`, which
	 * is undefined for in-place/ad-hoc agents), fix-up-tier retry budgets reset, fresh runId/agent id.
	 * The forward path once a run is terminal-marked (see `handleWorkflowTerminal`): `prompt`/`restart`
	 * both refuse a terminal run and point here instead. Offer-only (never auto-fired), refused while the
	 * original is `working`, and limited to one live fork per source runId (DESIGN.md: one issue, one
	 * active claimant).
	 */
	async fork(id: string, opts: { seq?: number } = {}, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		const rec = this.agents.get(id);
		if (!rec) throw new Error("agent not found");
		if (rec.dto.status === "working") throw new Error("cannot fork a running agent — stop or wait for it to finish");
		if (!rec.dto.forkAvailable) throw new Error("this agent has no fork point available");

		const runId = rec.options.workflowState!.runId!;
		// One live fork per source runId: a fork that already died AND was itself superseded by a further
		// fork no longer occupies the slot (its lineage moved on to that further fork — fork it instead).
		// Anything else — still running, idle, or terminal-but-not-yet-re-forked — is the active claimant
		// and blocks a second fork of the SAME source run.
		const liveFork = [...this.agents.values()].find(
			(r) =>
				r.options.workflowState?.forkedFrom?.runId === runId &&
				r.dto.status !== "stopped" &&
				!(r.dto.status === "error" && r.options.workflowState?.terminal?.supersededBy),
		);
		if (liveFork) throw new Error("a fork of this run already exists");

		// Claim the slot SYNCHRONOUSLY, before the first `await` below — closes the TOCTOU window between
		// the guards above and createInternal's own `this.agents.set` (readCheckpoints, a graph re-parse,
		// `git rev-parse`/`git branch`, createInternal's fabric-primer snapshot, resolveLandMode, a possible
		// network `git fetch origin`, and `git worktree add` all sit in that window). Without this, two
		// concurrent fork() calls for the same source runId (double-click, webapp+TUI, a federated peer)
		// both pass `liveFork` and both mint a live fork of the same source (review finding 1).
		if (this.forkInFlight.has(runId)) throw new Error("a fork of this run already exists");
		this.forkInFlight.add(runId);
		try {
			const entries = await readCheckpoints(this.stateDir, runId);
			const chosen = opts.seq !== undefined ? entries.find((e) => e.seq === opts.seq) : entries[entries.length - 1];
			if (!chosen) throw new Error("no checkpoint found");

			// Re-parse the workflow graph the same way makeDriver resolves it — an authored file OR a
			// synthesized verify loop (the `rec.options.workflow!.path` non-null assumption doesn't hold for
			// `verify:`-only runs, which have no file to re-parse/branch from but ARE terminal-markable). This
			// also supplies the goalGate/retryTarget/overflow chain the visit reset below walks.
			const wf: Workflow | undefined = rec.options.workflow?.verify
				? buildVerifyLoop(rec.options.workflow.verify)
				: rec.options.workflow?.path
					? parseWorkflow(await fs.readFile(resolveWorkflowPath(rec.options.workflow.path), "utf8"))
					: undefined;
			if (!wf) throw new Error("cannot fork — no workflow graph to validate the checkpoint against");
			if (!wf.nodes.has(chosen.currentNode)) {
				throw new Error(`checkpoint node "${chosen.currentNode}" no longer exists in the workflow graph (it may have been edited) — pick a different step`);
			}

			if (!existsSync(rec.dto.worktree)) throw new Error("original worktree is gone — cannot fork");
			const shaResult = await hardenedGit(["rev-parse", "HEAD"], { cwd: rec.dto.worktree });
			const sha = shaResult.stdout.trim();
			if (shaResult.code !== 0 || !sha) throw new Error("could not resolve HEAD in the original worktree");

			// The decision that makes fork actually work for the escalate-exhaustion case: reset visits for
			// EVERY fix-up tier (each goalGate's retryTarget plus its overflow closure, across all goalGate
			// nodes in the graph) while carrying every other visit count forward (DESIGN.md Key Decisions).
			const tiers = new Set<string>();
			for (const node of wf.nodes.values()) {
				if (!node.goalGate) continue;
				for (let t: string | undefined = node.retryTarget; t; t = wf.nodes.get(t)?.overflow) tiers.add(t);
			}
			const visits = { ...chosen.visits };
			for (const tier of tiers) visits[tier] = 0;

			// Name stabilization: strip any existing "-fork"/"-fork-N" suffix before appending one, so forking
			// a fork never compounds into "x-fork-fork".
			const baseName = rec.dto.name.replace(/-fork(-\d+)?$/, "");
			const newName = `${baseName}-fork`;
			const newId = newAgentId(newName);

			// Branch off the repo root (matching addWorktree's own repoRoot resolution), not the worktree;
			// createInternal below reuses UNMODIFIED addWorktree's existing-branch checkout path.
			const branchResult = await hardenedGit(["branch", `squad/${newId}`, sha], { cwd: rec.dto.repo });
			if (branchResult.code !== 0) throw new Error(`could not create fork branch: ${branchResult.stderr.trim() || branchResult.stdout.trim()}`);

			const forkedState: WorkflowRunState = {
				goal: chosen.goal,
				currentNode: chosen.currentNode,
				visits,
				vars: chosen.vars,
				outcome: chosen.outcome,
				preferredLabel: chosen.preferredLabel,
				index: chosen.index,
				resumeAttempts: 0,
				rollup: [],
				forkedFrom: { runId, seq: chosen.seq },
				// terminal / cold / sessionId / proof / branchOutcomes / headSha (log-only) deliberately absent:
				// a fork is a fresh run, not a continuation of the dead run's own lifecycle state.
			};

			let newDto: AgentDTO;
			try {
				newDto = await this.createInternal(
					{
						repo: rec.dto.repo,
						name: newName,
						branch: `squad/${newId}`,
						model: rec.dto.model,
						approvalMode: rec.options.approvalMode,
						workflow: rec.options.workflow?.path,
						verify: rec.options.workflow?.verify?.command,
						verifyMode: rec.options.workflow?.verify?.mode,
						executionRole: rec.options.executionRole,
						workflowState: forkedState,
						// Fork inherits the issue (DESIGN.md RT1#13: one issue, one active claimant) — the original
						// is marked supersededBy below and excluded from adoption/dispatch, so this is never a
						// double-claim.
						featureId: rec.options.featureId,
						issue: rec.options.issue,
						bypassCap: true,
						cold: true,
						explicitId: newId,
					},
					actor,
				);
			} catch (err) {
				// createInternal threw after the branch was already cut (e.g. resolveWorktree's `git worktree
				// add` failing) — nothing else reaps `squad/<newId>`, so a retry (which mints a fresh id) would
				// otherwise leak one permanent branch per failed attempt (review finding 2, best-effort cleanup).
				await hardenedGit(["branch", "-D", `squad/${newId}`], { cwd: rec.dto.repo }).catch(() => {});
				throw err;
			}
			// Review finding 6: createWithId swallows agent.start() rejections via this.fail() and resolves
			// an error-status DTO instead of throwing (the try/catch above only ever throws for createInternal's
			// OWN duplicate-id guard, not for a failure inside createWithId's body). Proceeding past this point
			// would mark the source superseded by a fork that never actually started — stranding BOTH runs: the
			// source pointing at a dead fork it can never retry past (the one-live-fork guard blocks a second
			// attempt), and the fork itself with no forward path. Roll back instead: tear down the dead fork's
			// roster record + branch (createWithId's own catch already stopped its agent and removed its
			// worktree if one was created), leave the source's terminal marker/forkAvailable untouched, and
			// surface the failure so the operator can retry.
			if (newDto.status === "error") {
				const reason = newDto.error ?? "fork agent failed to start";
				await this.remove(newDto.id, true).catch(() => {});
				await hardenedGit(["branch", "-D", `squad/${newId}`], { cwd: rec.dto.repo }).catch(() => {});
				throw new Error(`fork failed to start: ${reason}`);
			}
			// Persisted for display/audit only (mirrors spawnFleetBranch's own `rec.options.task = task`
			// idiom) — deliberately NOT passed as createInternal's `task` option: createWithId auto-prompts on
			// `opts.task` regardless of `workflowState`, but `workflowState` here already re-primes the goal
			// the instant the driver's `start()` returns (WorkflowDriver.start's `resumeState` branch fires
			// `execRun` before `start()` resolves) — an extra `agent.prompt()` right after would race that
			// already-in-flight run's own inner agent.
			const newRec = this.agents.get(newDto.id);
			if (newRec) {
				newRec.options.task = rec.options.task;
				// Review finding 10: createWithId's own "spawn" transition has no way to know this new id came
				// FROM `id` — stitch the lineage here (same idiom as closeOrphanedPending's "adopted" marker) so
				// followLineage's crash-spanning timeline stitch also covers fork→source, not just adopt→prior.
				this.transition(newRec, newRec.dto.status, "fork", { priorId: id });
			}

			// Mark the original superseded: excluded from adoption/dispatch permanently (one issue, one active
			// claimant), forkAvailable cleared so the offer never re-fires for a run that's already been forked.
			rec.options.workflowState!.terminal!.supersededBy = newId;
			rec.dto.forkAvailable = false;
			rec.dto.workflowState = rec.options.workflowState;
			this.emitAgent(rec);
			await this.persist();

			void this.recordAudit(actor, "fork", id, "ok", `→ ${newId} @ seq ${chosen.seq}`);
			return newDto;
		} finally {
			// Released unconditionally (success or throw): on success the slot is now durably held by
			// createInternal's own roster entry (the `liveFork` guard above sees it on the next call), on
			// throw nothing was ever claimed so the next attempt must be free to proceed.
			this.forkInFlight.delete(runId);
		}
	}

	/** Read-only checkpoint history for a workflow run (the fork-step picker) — keeps stateDir private
	 *  (mirrors `receipts()`) and NEVER returns `vars` (the design's explicit "never vars" rule: a
	 *  checkpoint's vars can carry truncated tool output, not a redaction a client should get to bypass). */
	async checkpoints(id: string): Promise<CheckpointLogEntry[]> {
		const rec = this.agents.get(id);
		const runId = rec?.options.workflowState?.runId;
		if (!runId) return [];
		const entries = await readCheckpoints(this.stateDir, runId);
		return entries.map((e) => ({ seq: e.seq, at: e.at, currentNode: e.currentNode, outcome: e.outcome }));
	}

	/**
	 * Resolve a caller-supplied removal identifier to the record's canonical `id` — the
	 * tombstone-by-name incident's fix (see removed-ledger.ts's doc). `glance rm <x>` (and any other
	 * name-based caller) may pass either the true id or the agent's bare display NAME; every
	 * resurrection guard (reconnectLive/adoptOrphanedAgents/loadPersisted) filters tombstones by the
	 * record's real id, so tombstoning an unresolved name protects nothing.
	 *
	 * Order: (1) exact id match against the LIVE roster — the fast, unambiguous path every existing
	 * caller already uses; (2) a unique-by-name match against the LIVE roster; (3) the same two
	 * checks against the PERSISTED snapshot, for the eviction-race window where the target isn't
	 * resident in THIS instance at all (a DB-root org manager just recreated). A name that matches
	 * more than one record (live or persisted) is deliberately left unresolved — guessing which one
	 * the operator meant risks tombstoning the wrong record's id instead.
	 */
	private async resolveRemovalId(identifier: string): Promise<string | undefined> {
		if (this.agents.has(identifier)) return identifier;
		const liveByName = [...this.agents.values()].filter((r) => r.dto.name === identifier);
		if (liveByName.length === 1) return liveByName[0].dto.id;
		if (liveByName.length > 1) {
			this.log("warn", `rm "${identifier}" matched ${liveByName.length} live agents by name — refusing to guess, tombstoning the raw string instead`);
			return undefined;
		}
		try {
			if (!(await this.store.hasState())) return undefined;
			const persisted = (await this.store.load()).agents;
			if (persisted.some((p) => p.id === identifier)) return identifier;
			const persistedByName = persisted.filter((p) => p.name === identifier);
			if (persistedByName.length === 1) return persistedByName[0].id;
			if (persistedByName.length > 1) {
				this.log("warn", `rm "${identifier}" matched ${persistedByName.length} persisted agents by name — refusing to guess, tombstoning the raw string instead`);
			}
		} catch {
			/* best-effort resolution; fall through to the raw-string fallback below */
		}
		return undefined;
	}

	/** Returns true when the resolved id was actually resident and removed, false when it wasn't
	 *  found in THIS manager instance's live roster. Either way the record's canonical id is durably
	 *  tombstoned first (see removed-ledger.ts) — an explicit `rm` must stick even when it races a
	 *  DB-root org's evict/lazily-recreate cycle and lands on an instance where the target hasn't
	 *  been reattached yet; without the tombstone, the persisted row survives untouched and the NEXT
	 *  `start()` (the very next eviction cycle) reattaches it verbatim via reconnectLive's
	 *  terminal-workflow path.
	 *
	 *  `identifier` may be the true id OR the agent's display name (tombstone-by-name incident):
	 *  `resolveRemovalId` resolves it to the canonical id FIRST, and that resolved id — never the raw
	 *  identifier — is what gets tombstoned and what every resurrection guard checks. When resolution
	 *  genuinely fails (no live or persisted match by id or name), the raw identifier is tombstoned as
	 *  a last-resort fallback so an operator's `rm` for a truly-unknown string still leaves a record,
	 *  and the name is recorded alongside the resolved id as defense-in-depth (`add`'s second param). */
	private async remove(identifier: string, deleteWorktree: boolean): Promise<boolean> {
		const resolved = await this.resolveRemovalId(identifier);
		const id = resolved ?? identifier;
		this.removedLedger.add(id, identifier);
		const rec = this.agents.get(id);
		if (!rec) return false;
		const liveChildren = [...this.agents.values()].filter((r) => r.dto.parentId === id && r.dto.id !== id);
		if (liveChildren.length) {
			this.log("warn", `removing agent "${rec.dto.name}" with ${liveChildren.length} live child(ren) — they become orphaned roots in the topology view`);
		}
		await rec.agent.stop();
		await this.releaseAgentLeases(rec);
		if (deleteWorktree && !rec.options.repo.startsWith("(")) {
			await removeWorktree(rec.options.repo, rec.options.worktree).catch(() => {});
		}
		if (deleteWorktree && rec.options.kind === "workflow" && rec.options.workflowState?.runId) {
			await deleteCheckpointLog(this.stateDir, rec.options.workflowState.runId).catch(() => {});
		}
		this.agents.delete(id);
		// Daemon-side session end for a `glance here` registration (daily-onramp 02): when the LAST agent
		// on an ephemerally-registered repo is removed, restore the pre-session registry state — the REPL's
		// own exit hook is not the only path a casual session ends through.
		const repoKey = normalizeRepoPath(rec.options.repo);
		if (this.ephemeralProjects.has(repoKey) && ![...this.agents.values()].some((r) => normalizeRepoPath(r.options.repo) === repoKey)) {
			this.releaseEphemeralProject(repoKey);
		}
		if (this.scoutCursor.delete(id)) writeScoutCursors(this.stateDir, this.scoutCursor);
		this.emit("event", { type: "removed", id } satisfies SquadEvent);
		await this.persist();
		return true;
	}

	/** Release every file lease the removed agent's own omp process was holding (leases.ts). Only
	 *  RpcAgent-backed drivers (the omp harness, the only one lease-hook.ts is wired into) expose a
	 *  `pid` — a lease's `session` is minted by that hook as `omp:<pid>` of its OWN process, which is
	 *  this same pid as seen from the daemon side (agent-host.ts's `proc.pid`, mirrored onto RpcAgent
	 *  via the `{"__sq":"meta",pid}` frame). Other drivers (ACP/sandbox/flue/workflow) never claim
	 *  leases, so a missing pid here is a legitimate no-op, not a gap. Called BEFORE the worktree/agent
	 *  bookkeeping in `remove()` above so a lease never outlives the agent record that held it — this
	 *  was previously the entire gap: `remove()` tombstoned the id and stopped the process but left any
	 *  lease it held to expire on its own heartbeat TTL (or not, if something kept the file fresh), so a
	 *  Federation page reader saw a removed agent still "holding" a file for as long as that TTL window. */
	private async releaseAgentLeases(rec: AgentRecord): Promise<void> {
		const pid = rec.agent.pid;
		if (pid === undefined) return;
		if (rec.options.repo.startsWith("(")) return; // synthetic/no-repo agents never claim leases
		await releaseSession(`omp:${pid}`, rec.options.repo).catch((err) => {
			this.log("warn", `lease release failed for ${rec.dto.id}: ${errText(err)}`);
		});
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
		// Concern 2's replay-completion marker (agent-host.ts writes it last, right after the ring, so a
		// client always processes it after every frame that preceded it regardless of how many socket
		// reads the replay spanned). No-op for a freshly-created (non-reattached) agent — nothing is ever
		// armed in replayCompleteWaiters for it.
		a.on("replayComplete", () => {
			const finish = this.replayCompleteWaiters.get(rec.dto.id);
			if (finish) {
				this.replayCompleteWaiters.delete(rec.dto.id);
				finish();
			}
		});
		a.on("checkpoint", async (state: WorkflowRunState) => {
			rec.options.workflowState = state;
			rec.dto.workflowState = state;
			this.emitAgent(rec);
			void this.persist();
			// Append-only history for the fork-step picker (concern 04). Excludes the engine's transient
			// per-branch fan-out emissions (see EngineCheckpoint.transient) — those are live-progress
			// snapshots of the SAME fan-out node's entry position, not a new resumable boundary. Wrapped
			// defensively: this listener runs on every stage boundary (a hot path), and a checkpoint-log
			// failure must never break the live-progress emission above.
			if (state.transient || !state.runId) return;
			const runId = state.runId;
			const append = (async () => {
				try {
					const headSha = await this.captureHeadSha(rec.dto.worktree);
					await appendCheckpoint(this.stateDir, runId, { ...state, headSha });
				} catch (err) {
					this.log("warn", `checkpoint-log append failed for ${rec.dto.id}: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
			rec.checkpointAppending = append;
			await append;
		});
		a.on("exit", ({ code }: { code: number }) => {
			// Guard preserved verbatim — an exit reported for an already-stopped agent (e.g. our own
			// kill/restart already flipped it) stays inert exactly as today.
			if (rec.dto.status !== "stopped") {
				// Live incident: a one-shot ACP agent (plan-reviser) completed its turn (agent_end fired,
				// WORKING→IDLE), then ~8s later its process exited 143 (SIGTERM) as normal one-shot teardown.
				// The old rule (`code===0 ? stopped : error`) treated ANY non-zero code as a crash, so a
				// perfectly successful run got flagged error + surfaced as "needs you"/Restart. The honest
				// rule: an exit is a crash only if the agent had NOT already finished its work at the moment
				// it died. "Finished its work" = it has completed at least one turn (`completedTurn`, set by
				// the agent_end handler above) AND it is currently at rest — not mid-stream, nothing pending
				// — right now. Under that rule ANY exit code (including signal-kill codes: 143 SIGTERM, 130
				// SIGINT, 137 SIGKILL) after a completed, at-rest turn is clean teardown. A crash before any
				// completed turn, or a death mid-stream / with an unanswered pending request, still stays
				// error exactly as before — this never masks a genuine crash.
				const cleanTeardown = code === 0 || (rec.completedTurn === true && !rec.streaming && rec.dto.pending.length === 0);
				this.transition(
					rec,
					cleanTeardown ? "stopped" : "error",
					cleanTeardown ? "exit-clean" : "exit-error",
					cleanTeardown ? undefined : { error: `agent exited (code ${code})` },
				);
				this.emitAgent(rec);
			}
			void this.finalizeRun(rec);
		});
	}

	/** Protected so a test can push a real frame through the real handler, rather than reimplementing it. */
	protected onAgentEvent(rec: AgentRecord, frame: { type?: string; [k: string]: unknown }): void {
		if (frame.type?.startsWith("subagent_")) {
			rec.subs.ingest(frame as { type: string; payload?: unknown });
			rec.run?.onSubagentFrame(frame as { type: string; payload?: unknown });
			// Merge-by-id flush (never an overwrite): persisted history ∪ the tracker's truncated/redacted
			// projection, live wins per id. Gated on isDirty() so a burst of heartbeats/no-op re-ingests
			// doesn't trigger a persist() on every frame — only a real node creation/transition does.
			if (rec.subs.isDirty()) {
				rec.dto.subagents = mergeSubagents(rec.options.subagents, rec.subs.snapshot());
				rec.options.subagents = rec.dto.subagents;
				rec.subs.clearDirty();
				void this.persist(); // chain-deduped by concern 01 — safe to call on every dirty transition
				// Topology review finding 8: the flush above persisted but never broadcast — the webapp's SSE
				// copy of dto.subagents staleness-lagged until an unrelated emit happened to fire. Gated the
				// same as the persist() call (isDirty(), a real node creation/transition), never on a heartbeat.
				this.emitAgent(rec);
			}
			return;
		}
		if (frame.type === "workflow_journal") {
			const event = frame.event as WorkflowJournalEvent;
			// Only the static topology snapshot gets its own persistence branch here — the graph is a
			// structural field the generic tail below never derives. All other WorkflowJournalEvent types
			// (workflow.node.*, verification.*, human_gate.*, etc.) are deliberately unconsumed by any case
			// here: general journal persistence is the separate hooks-convergence initiative.
			//
			// Topology review finding 4: this used to `return` right after the graph branch, skipping the
			// generic tail (receipt rollup, sticky traceId, derive/transition, `lastActivity` bump,
			// emitAgent) that every OTHER frame type falls through to below. A long `command` node that only
			// ever emits journal frames then went stale on `lastActivity` forever, wrongly tripping the TUI's
			// stall detector (tui.ts, >120s) on an actually-healthy run. Falling through instead (workflow_journal
			// matches no case in the switch below, same as any other frame type the switch doesn't special-case)
			// restores that tail for every journal frame, not just workflow.graph.
			if (event.type === "workflow.graph" && event.graph) {
				rec.dto.workflowGraph = event.graph;
				rec.options.workflowGraph = event.graph;
				void this.persist();
			}
			// No `return` here (finding 4 fix) — falls through: "workflow_journal" matches no case in the
			// switch below (a harmless no-op there, same as any other frame type it doesn't special-case),
			// then reaches the generic tail.
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
						// Receipt attribution gap (orchestration receipts audit 2026-07-07): the harness backing
						// this run, resolved at spawn (`rec.harness`, set once by create()'s `resolveHarness` call)
						// — NOT `receipts.ts`'s own `?? "omp"` default, which silently mislabels a non-omp unit.
						// `actualUnitHarness` covers workflow/flue-kind records (`harnessFor` returns undefined
						// for them by convention) with the runtime they ACTUALLY execute on — workflow inners are
						// always omp-dialect RpcAgents, flue is its own runtime — never the `GLANCE_HARNESS` env
						// default, which those kinds don't consult (cross-lineage review, PR #112 finding 2).
						harness: rec.harness?.name ?? actualUnitHarness(rec.options),
						// Confirmed-delivered efficiency flags (concern 02), fixed at spawn — see
						// AgentRecord.efficiencyFlags / receipts.ts#confirmDeliveredFlags.
						efficiencyFlags: rec.efficiencyFlags,
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
					| {
							role?: string;
							usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } };
							model?: string;
					  }
					| undefined;
				if (msg?.role === "assistant") {
					if (msg.usage) rec.run?.onAssistantUsage(msg.usage);
					// Late-bind the effective model off the wire — a dispatched fleet unit sets no
					// explicit rec.dto.model, so without this every fleet run collapses to "unknown"
					// in attribution even though the RPC frame already carries the resolved model.
					if (msg.model) rec.run?.noteModel(msg.model);
				}
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
				// R5: an answer unit's entire deliverable is its final message. Captured AFTER
				// `finishAssistantStream` has flushed the buffer into the transcript, so the text we persist is
				// exactly the text the operator sees.
				void this.captureAnswer(rec);
				rec.completedTurn = true; // a fully completed turn — see the field comment; feeds the exit classifier
				this.expireReplayedPending(rec); // a completed live turn proves any still-open replayed pending is stale
				void this.finalizeRun(rec);
				// Completion-push exposure (voice-loop): a non-workflow agent's `agent_end` IS its terminal
				// signal — every turn ends the one voice-armed dispatch it was armed for. A workflow-kind
				// agent's `agent_end` is terminal ONLY when `workflow_done` just fired for this exact frame
				// pair (`workflowJustFinished`, set in that case below) — an intermediate per-run `agent_end`
				// (a human-gate/checkpoint boundary mid-graph) must never expose the latch, or a multi-node
				// workflow would push — and self-disarm — on the first mid-graph idle, long before the graph
				// is actually done. `dto.voicePushArmed` is deliberately re-derived on EVERY agent_end (not
				// just when armed) so a stale `true` from a prior cycle can never leak onto an unrelated idle.
				{
					const isTerminal = rec.options.kind !== "workflow" || rec.workflowJustFinished === true;
					rec.workflowJustFinished = false; // consume — never leak into the next agent_end
					rec.dto.voicePushArmed = isTerminal && rec.options.voicePushArmed === true;
				}
				break;
			}
			case "workflow_done":
				// Completion-push exposure (voice-loop): workflow-driver.ts's execRun cleanup always emits
				// this frame immediately followed by `agent_end` — set here, consumed there (see the
				// `agent_end` case above and `workflowJustFinished`'s field comment).
				rec.workflowJustFinished = true;
				// Baseline (concern 01): first-try-green / fixups-to-green / escalation, unconditional —
				// the measurement the rest of the learning loop is A/B'd against. Never gates anything.
				this.recordWorkflowOutcomeMetrics(rec, frame.outcome as string | undefined);
				// Workflow auto-land must satisfy the same fresh-proof invariant surfaced by Land all.
				// The final land still goes through land(), so merge verification/rollback and issue-close stay one seam.
				void this.autoLandWorkflow(rec, frame.outcome as string | undefined, frame.proof as { state?: string } | undefined);
				// The run is finished — no further checkpoints will ever append for this runId. Evict the
				// in-memory chain entry now rather than letting it sit in `chains` for the rest of the
				// daemon's life (unbounded growth otherwise, since only `remove(..., true)` ever cleared it).
				if (rec.options.workflowState?.runId) evictCheckpointChain(rec.options.workflowState.runId);
				break;
			case "workflow_terminal": {
				const { reason, checkpoint } = frame as { reason: string; checkpoint: EngineCheckpoint };
				void this.handleWorkflowTerminal(rec, reason, checkpoint);
				break;
			}
			case "auto_retry_start": {
				// A usage-limit retry means the model subscription is rate-limited (5h/weekly cap). Note it so the
				// dispatcher pauses; log once per episode (only on the not-paused → paused transition) to avoid spam
				// when several agents trip the same cap. delayMs is omp's parsed retry hint (when the cap frees up).
				//
				// Degradation ladder (concern 06): resolve the provider through the SHARED `unitProviderKey`
				// helper — the same function the dispatcher's `providerFor` gate evaluates, so the bucket a cap
				// lands in is by construction a bucket the gate checks (cross-lineage review, PR #112 finding 1).
				// Inputs are the record's DECLARED configuration: kind (workflow/flue kinds key on their actual
				// inner runtime, not the env default — finding 2), harness-at-spawn, and `declaredModelOf`
				// (which excludes a router-applied model per the helper's invariant). NEVER `rec.dto.model` —
				// the poll loop's `applyState` backfills that asynchronously off the wire and it is often still
				// unset in this ≤2.5s pre-poll window (the raced backfill the concern doc warns against).
				// Threading a real (possibly "unknown") provider into `note()` only sharpens which bucket a cap
				// lands in — `paused()`'s no-arg legacy OR and `RateLimitGate`'s "unknown" → dominant-provider
				// fold are both unchanged, so this is zero regression until a second verified lane exists.
				const provider = unitProviderKey({ kind: rec.options.kind, harness: rec.options.harness, runtime: rec.options.runtime, declaredModel: declaredModelOf(rec.options) });
				const wasPaused = this.rateLimit.paused(provider);
				if (this.rateLimit.note(frame.errorMessage, frame.delayMs, provider) && !wasPaused) {
					const mins = Math.ceil((this.rateLimit.untilFor(provider) - Date.now()) / 60_000);
					this.log("warn", `model subscription rate-limited (${rec.dto.name}, provider ${provider}) — pausing auto-dispatch ~${mins}m: ${this.rateLimit.reasonFor(provider)}`);
				}
				break;
			}
		}
		rec.dto.receipt = rec.run?.rollup();
		rec.dto.traceId = rec.run?.traceId || rec.dto.traceId; // sticky across a run boundary until the NEXT run's start() reassigns it — never blanked to undefined mid-flight
		rec.options.traceId = rec.dto.traceId; // topology review finding 7: mirror onto PersistedAgent so a restart never drops the trace link
		this.transition(rec, this.derive(rec), "turn-progress"); // hottest site — the derived same-state early-return matters most here
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
	}

	/**
	 * The engine escalated a terminal failure (concern 01's `terminalFail`, fired at all four dead-end
	 * returns). Persist a `workflowState.terminal` marker — the load-bearing lifecycle bit that excludes
	 * this run from `resumable`/`reconnectLive`/`makeDriver`'s resumeState — and escalate through the
	 * EXISTING catastrophe channel (sticky "error" + attention queue + push) rather than a second ad-hoc
	 * status write.
	 */
	private async handleWorkflowTerminal(rec: AgentRecord, reason: string, checkpoint: EngineCheckpoint): Promise<void> {
		const runId = rec.options.workflowState?.runId ?? rec.dto.id;
		// The checkpoint listener's own append for the entry checkpoint that preceded this terminal
		// failure may still be in flight (both events fire from the same driver call in quick
		// succession) — await it so forkPoint.seq references the checkpoint just durably appended
		// instead of racing it.
		await (rec.checkpointAppending ?? Promise.resolve());
		// getLastSeq() is "how many entries have been durably appended" — the one this terminal failure
		// died at is the LAST of those. Floored at 0 for the pathological case of a terminal failure with
		// zero prior checkpoint appends (e.g. a `maxVisits: 0` node tripping the cap on its very first,
		// never-checkpointed visit) — forkPoint.seq then points at an empty log; unreachable in any graph
		// with a sane visit cap, so left as a documented edge rather than added machinery.
		const seq = Math.max((await getLastSeq(this.stateDir, runId)) - 1, 0);
		const terminal = { reason, at: Date.now(), forkPoint: { runId, seq } };
		const base: WorkflowRunState = rec.options.workflowState ?? { ...checkpoint, rollup: [], runId };
		const state: WorkflowRunState = { ...base, terminal };
		rec.options.workflowState = state;
		rec.dto.workflowState = state;
		rec.dto.forkAvailable = this.deriveForkAvailable(state);
		this.markCatastrophe(rec.dto.id, reason);
		void this.persist();
		// The run is dead — no further checkpoints will ever append for this runId (a fork, if any, mints
		// its own new runId). Evict the in-memory chain entry now; `readCheckpoints`/fork (concern 04) read
		// the file directly and never touch this map, so eviction here is always safe.
		evictCheckpointChain(runId);
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
	 *
	 * Additionally gated on a recorded DoneProof (concern 01's ledger): a merge report with no matching
	 * proof is NOT closed — it is skipped and surfaced via recordAudit instead of silently trusting the
	 * caller's "it merged" claim. Until landFeature (concern 06) reroutes through the same proof-writing
	 * seam as land(), its per-member calls here will find no proof and log-suppress; that is expected and
	 * non-regressive (the branch still really merged via landAgent) and closes itself once concern 06 lands.
	 */
	async closeLandedIssue(issue: IssueRef | undefined, ctx?: { branch?: string; repo?: string }): Promise<void> {
		if (!this.closeOnDone || !issue || this.closedIssues.has(issue.id)) return;
		const identifier = issue.identifier ?? issue.id;
		const proof = issue.identifier ? getDoneProofByIssue(this.stateDir, issue.identifier) : ctx?.branch ? getDoneProofByBranch(this.stateDir, ctx.branch) : undefined;
		if (!proof) {
			this.log("warn", `NOT closing ${identifier} (branch landed) — no DoneProof on record; skipping close, surfacing for review`);
			void this.recordAudit(LOCAL_ACTOR, "close.suppressed-unproven", identifier, "error", `land reported merged but no DoneProof exists for ${ctx?.branch ?? "(no branch)"}`);
			return;
		}
		// Tri-state close authorization (finding #11, eap-borrows wave 2): a recorded DoneProof used to
		// authorize a close regardless of ITS OWN `verified` grade — an out-of-band GitHub-UI merge
		// (`reconcileOnePr`, never re-verified by the daemon's own gate) records `verified:"unverified"`,
		// and that closed the tracking issue exactly like a real green land. `"green"` closes normally;
		// `"red-baseline"` closes too (refusing here would zombify every brownfield issue forever — the
		// land itself already accepted the red-baseline allowance) but the audit trail is annotated so
		// it's distinguishable from a clean pass; `"unverified"` means THIS daemon never actually
		// confirmed the merge — escalate instead of silently trusting the tracker to say "Done".
		if (proof.verified === "unverified") {
			if (!this.unverifiedProofEscalated.has(issue.id)) {
				this.unverifiedProofEscalated.add(issue.id);
				this.fileUnverifiedProofFinding(issue, identifier, ctx);
			}
			return;
		}
		if (proof.verified === "red-baseline") {
			void this.recordAudit(LOCAL_ACTOR, "close.red-baseline", identifier, "ok", `branch landed onto a red baseline (no NEW failures introduced) — closing with annotation, not a clean pass: ${proof.detail}`);
		}
		this.log("info", `closing ${identifier} (branch landed, proof ${proof.verified})`);
		if (await closePlaneIssue(issue)) this.closedIssues.add(issue.id);
		else this.log("warn", `could not close ${identifier} (branch landed)`);
	}

	/**
	 * Escalate an "unverified" DoneProof instead of silently closing its tracking issue (finding #11) —
	 * dual-write, mirroring `fileMembraneBreakerFinding`'s pattern:
	 *   1. The "Needs you" attention lane on the live `AgentRecord`, when one still exists on the roster
	 *      (an out-of-band merge confirmed well after the fact often has none by now — a no-op then, not
	 *      a bug: the automation channel below still surfaces it either way).
	 *   2. The "land" automation channel, unconditionally, so it surfaces in /api/automation + the panel
	 *      regardless of roster state.
	 * Never blocks anything — the merge already happened; this only makes "nobody actually re-verified
	 * this" legible instead of the tracker silently reading Done. Best-effort; never throws.
	 */
	private fileUnverifiedProofFinding(issue: IssueRef, identifier: string, ctx?: { branch?: string; repo?: string }): void {
		const summary = `Plane issue ${identifier} landed via an UNVERIFIED merge (out-of-band GitHub-UI merge, never re-run through the daemon's own gate) — NOT auto-closed; needs a human to confirm and close manually`;
		const detail = ctx?.branch ? `branch ${ctx.branch}` : undefined;
		const rec = ctx?.branch ? this.agentByBranch(ctx.branch) : undefined;
		if (rec) {
			try {
				const event: AttentionEvent = { id: randomUUID(), summary, detail, source: "notify", createdAt: Date.now() };
				rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
				this.emitAgent(rec);
			} catch (err) {
				this.log("warn", `unverified-proof attention-lane attach failed for ${identifier} (non-fatal): ${errText(err)}`);
			}
		}
		try {
			this.log("warn", `${summary}${detail ? ` — ${detail}` : ""}`);
			this.automation.for("land", ctx?.repo ?? "unknown")({ durationMs: 0, level: "warn", detail: `${summary}${detail ? ` — ${detail}` : ""}` });
		} catch {
			/* observability must never break the close path */
		}
	}

	// ── PR-reconciler backstop (concern 07) ─────────────────────────────────────────────────────────
	// `landAgentPr` (concern 06) is synchronous end-to-end, so this loop is a BACKSTOP for the one case
	// it cannot see — a human merging/closing a PR directly in GitHub's UI — plus the crash-ordering
	// windows the synchronous path can leave stranded (push↔create, merge↔proof, proof↔Plane-close).
	// Driven entirely off the durable PendingPr ledger (written at push+create time by land-pr.ts) ∪ the
	// live roster; NEVER off `planeRepos()` directly, so a test (or a repo later dropped from Plane
	// config) doesn't need real Plane config for the loop to still reconcile what it already knows about.

	/** One reconciler pass. Its own activity gate ("is there anything to do") is computed fresh every
	 *  tick from the ledger + roster — an idle daemon with no PR-mode activity makes zero `gh`/`git`
	 *  calls, never gated behind a toggleable env flag (OMP_SQUAD_OBSERVE is for the operator-toggleable
	 *  self-audit; Done-truth for merged PRs must not silently stop when that's off). */
	protected async prReconcileTick(): Promise<void> {
		const allEntries = listPendingPrs(this.stateDir);
		// Only entries reconcileOnePr can actually act on: "open" (out-of-band merge/close check), or
		// "merged" with a proof already written but the Plane close unconfirmed (crash-ordering retry —
		// mirrors reconcileOnePr's own `entry.proofAt && !entry.issueClosedAt` gate exactly). A "merged"
		// entry with NO proof yet is not a live case reconcileOnePr handles (defensive dead arm only
		// reachable via a partial-write crash inside updatePendingPr) — excluding it here stops it from
		// burning a `gh pr view` call every tick forever with no way to progress.
		const unconfirmed = allEntries.filter((e) => e.state === "open" || (e.state === "merged" && !!e.proofAt && !e.issueClosedAt));
		const existingBranches = new Set(allEntries.map((e) => e.branch));
		// Push-retry candidates: a landReady agent, in a repo resolved to PR mode, with no ledger entry
		// at all yet — covers both a crash between push and `gh pr create`, and a floated push (concern
		// 06's `floatPrOnLandReady`) that silently failed.
		const pushCandidates = [...this.agents.values()].filter((r) => r.dto.landReady && r.dto.branch && r.dto.worktree !== r.dto.repo && !existingBranches.has(r.dto.branch));
		// ff-heal repo set: repos named by a push-retry candidate, or by an entry NOT YET fully confirmed
		// (open, unconfirmed-merged, or CLOSED-unmerged — a closed-without-merging PR still deliberately
		// keeps its repo "in ledger scope" per the design, since that entry is never retired). A FULLY
		// CONFIRMED merged entry (see `isFullyConfirmedPendingPr`) no longer counts — this is the fix for
		// "every repo that ever landed a PR gets an ff-heal `git fetch` every tick, indefinitely": once an
		// entry is retired below, its repo drops out of scope too.
		const activeEntries = allEntries.filter((e) => !isFullyConfirmedPendingPr(e));
		const healRepos = new Set<string>();
		for (const rec of pushCandidates) healRepos.add(rec.dto.repo);
		for (const e of activeEntries) {
			const p = this.repoPathForIdentity(e.repo);
			if (p) healRepos.add(p);
		}
		// Retirement: entries ALREADY fully confirmed as of the START of this tick (from a prior tick, or
		// left over from before this fix shipped) are swept at the end. An entry that becomes fully
		// confirmed DURING this same tick's reconcile pass (proof + close both landing together) is left
		// alone this tick — its fields stay visible for this tick's callers — and retires on the next tick
		// once a fresh read of the ledger shows it confirmed. Counted into the activity gate so a ledger
		// holding only stale confirmed entries still gets swept even when there is nothing else to do.
		const retirable = allEntries.filter(isFullyConfirmedPendingPr);
		if (unconfirmed.length === 0 && pushCandidates.length === 0 && healRepos.size === 0 && retirable.length === 0) return; // nothing to do — zero gh/git calls this tick
		for (const entry of unconfirmed) await this.reconcileOnePr(entry).catch((e) => this.log("warn", `pr-reconcile: ${entry.branch} failed: ${e instanceof Error ? e.message : String(e)}`));
		for (const rec of pushCandidates) await this.retryPushFloat(rec).catch((e) => this.log("warn", `pr-reconcile: push retry threw for ${rec.dto.branch}: ${e instanceof Error ? e.message : String(e)}`));
		for (const repo of healRepos) await this.ffHealOne(repo).catch((e) => this.log("warn", `pr-reconcile: ff-heal failed for ${repo}: ${e instanceof Error ? e.message : String(e)}`));
		for (const e of retirable) deletePendingPr(this.stateDir, e.branch);
	}

	/** Map a PendingPr entry's `repoIdentity()` key back to a local filesystem repo path — checked
	 *  against live agents first (cheap, always available), then the configured Plane repo list (covers
	 *  an entry whose agent has since been removed from the roster). Undefined ⇒ orphaned entry (its
	 *  repo isn't known to this manager at all); the caller skips it for this tick and retries later. */
	private repoPathForIdentity(identity: string): string | undefined {
		for (const rec of this.agents.values()) if (repoIdentity(rec.dto.repo) === identity) return rec.dto.repo;
		return planeRepos().find((r) => repoIdentity(r) === identity);
	}

	private agentByBranch(branch: string): AgentRecord | undefined {
		for (const rec of this.agents.values()) if (rec.dto.branch === branch) return rec;
		return undefined;
	}

	/**
	 * Resolve a stable `agentId` for `branch` when the live `AgentRecord` may already be gone from the
	 * roster — the reconciler's out-of-band backstop (`reconcileOnePr`) runs well after the fact, often
	 * on a daemon restart, by which point `this.agents` may no longer hold the record `agentByBranch`
	 * would find. Falls back to scanning durable receipts (`RunReceipt.branch`/`agentId` are both stable
	 * and survive roster eviction) for the most recent match. Undefined ⇒ genuinely unresolvable; the
	 * caller must log-and-skip rather than fabricate an id (a made-up id would corrupt task-outcomes'
	 * agentId-keyed idempotency).
	 */
	private async resolveAgentIdForBranch(branch: string): Promise<string | undefined> {
		const live = this.agentByBranch(branch);
		if (live) return live.dto.id;
		// Pick the genuinely most-recent match by run time, NOT iteration order: receipts are stored
		// one file per agentId and `readAllReceipts` concatenates them in `readdir()` (filesystem/hash)
		// order, which is not chronological. A reused branch (revert→reland, or an ad-hoc `add` reusing
		// `squad/<name>`) has multiple matching receipts across different agents; keying the reconciled
		// outcome to whichever `readdir` happened to return last would misattribute it to a stale agent.
		const receipts = await readAllReceipts(this.stateDir);
		let found: RunReceipt | undefined;
		for (const r of receipts) {
			if (r.branch !== branch) continue;
			if (!found || (r.endedAt ?? r.startedAt) > (found.endedAt ?? found.startedAt)) found = r;
		}
		return found?.agentId;
	}

	/**
	 * Attempt (or confirm) the Plane close for `entry`'s tracked issue. Returns true when there is
	 * nothing left to confirm: the entry never had a tracked issue, autoclose is off (so there is
	 * nothing to retry — a disabled close is done, not failed), it was already closed (idempotent via
	 * `closedIssues`), or this call just closed it successfully. False ⇒ retry on a later tick.
	 *
	 * Prefers the live agent's full `dto.issue` (carries `projectId`, which Plane's close call needs to
	 * route the request) when the agent is still on the roster. `PendingPr` also carries `issueProjectId`
	 * (persisted at `ensurePr` time, mirroring the same field on `dto.issue`), so the synthetic `IssueRef`
	 * built for a removed agent still routes a real Plane close instead of silently staying unconfirmed
	 * forever — the durable ledger exists precisely to cover this orphaned-agent case.
	 */
	private async attemptCloseFor(entry: PendingPr, repo: string): Promise<boolean> {
		if (!entry.issueId) return true; // no Plane issue was ever tracked for this land — nothing to confirm
		if (!this.closeOnDone) {
			// OMP_SQUAD_AUTOCLOSE=0: `closeLandedIssue` will refuse to close on every tick forever, which
			// used to read as an unconfirmed close the reconciler kept retrying (a no-op churn: the SAME
			// gh/Plane state re-checked every tick with no path to ever progress). "Disabled" is not
			// "failed" — there is nothing to retry, so this entry is done, just never actually closed.
			this.log("info", `pr-reconcile: not closing ${entry.issueIdentifier ?? entry.issueId} for ${entry.branch} — autoclose is off (OMP_SQUAD_AUTOCLOSE=0); treating the close as done (skipped)`);
			return true;
		}
		const rec = this.agentByBranch(entry.branch);
		const issue: IssueRef = rec?.dto.issue ?? { id: entry.issueId, identifier: entry.issueIdentifier, name: entry.issueIdentifier ?? entry.issueId, projectId: entry.issueProjectId };
		if (!this.closedIssues.has(issue.id)) await this.closeLandedIssue(issue, { branch: entry.branch, repo });
		// Escalated-unverified (finding #11, eap-borrows wave 2) is TERMINAL for the reconciler, same
		// shape as the "autoclose off" arm above: closeLandedIssue will refuse an unverified DoneProof
		// on every future tick too — the close is deliberately handed to a human via the attention-lane/
		// automation escalation it just fired, so retrying is a no-op churn with no path to ever progress
		// (the exact unbounded-retry pathology that jammed the factory once). "Resolved by escalation"
		// counts as nothing-left-to-confirm; the Plane issue itself stays OPEN for the human.
		return this.closedIssues.has(issue.id) || this.unverifiedProofEscalated.has(issue.id);
	}

	/**
	 * Per-entry reconciliation. Two independent cases, checked in order:
	 *
	 *   1. Crash-ordering retry — a DoneProof already exists (`proofAt` set) but the Plane close never
	 *      confirmed (`issueClosedAt` unset). No `gh` call needed at all: just retry the close. Idempotent
	 *      via the LEDGER field (`issueClosedAt`), not proof-existence — a second tick after it's set
	 *      never re-enters this branch (the caller's `unconfirmed` filter excludes it).
	 *   2. Out-of-band GitHub-UI action — `entry.state` is still "open" locally (the daemon never saw a
	 *      merge or close happen). `gh pr view` is the only way to learn what a human did outside the
	 *      daemon entirely: MERGED ⇒ run the SAME per-method reachability assertion `landAgentPr` uses,
	 *      then write DoneProof + close, explicitly marked as NOT re-verified by the daemon's own gate
	 *      (the scratch-merge gate never ran for a merge that happened outside it). CLOSED-unmerged ⇒ the
	 *      design's explicit ruling: mark the ledger entry closed, but leave the branch and `landReady`
	 *      alone — a human decided, and a later re-Land creates a fresh PR.
	 */
	protected async reconcileOnePr(entry: PendingPr): Promise<void> {
		const repo = this.repoPathForIdentity(entry.repo);
		if (!repo) {
			this.log("warn", `pr-reconcile: no repo known for ${entry.repo} (branch ${entry.branch}) — skipping this tick`);
			return;
		}

		if (entry.proofAt && !entry.issueClosedAt) {
			const closed = await this.attemptCloseFor(entry, repo);
			if (closed) updatePendingPr(this.stateDir, entry.branch, { issueClosedAt: Date.now() });
			return;
		}

		const slug = repoIdentity(repo).split("/").slice(-2).join("/");
		const view = await ghJson<{ state: string; headRefOid?: string; mergeCommit?: { oid: string } }>(
			["pr", "view", String(entry.prNumber), "--repo", slug, "--json", "state,headRefOid,mergeCommit"],
			repo,
		);
		if (!view) {
			this.log("warn", `pr-reconcile: gh pr view #${entry.prNumber} failed for ${entry.branch} — retrying next tick`);
			return;
		}

		if (view.state === "MERGED" && entry.state !== "merged") {
			const mode = await this.resolveLandModeFor(repo);
			if (!mode.defaultBranch) {
				this.log("warn", `pr-reconcile: ${repo} has no resolved default branch — cannot verify the out-of-band merge of ${entry.branch}`);
				return;
			}
			const defaultBranch = mode.defaultBranch;
			await hardenedGit(["fetch", "origin", defaultBranch], { cwd: repo }).catch(() => undefined);
			const branchTip = (await hardenedGit(["rev-parse", entry.branch], { cwd: repo })).stdout.trim();
			if (!branchTip) {
				this.log("warn", `pr-reconcile: could not resolve local tip of ${entry.branch} — deferring to next tick`);
				return;
			}
			// Method-AGNOSTIC assertion: an out-of-band GitHub-UI merge can use ANY method — not
			// necessarily the one THIS repo's OMP_SQUAD_PR_MERGE_METHOD is configured to. Asserting only
			// against the configured method meant a UI Squash on a "merge"-configured repo (GitHub's own
			// common default button) failed the ancestry check FOREVER: the DoneProof was never written,
			// the Plane issue never closed, and this tick warned every 2 minutes indefinitely. Try the
			// ancestry check (the "merge" case) first, then the gh-view-based check (the squash/rebase
			// case, method-string-agnostic between the two) — accept whichever holds, and record which
			// one did so DoneProof.method reflects reality instead of the daemon's own configured guess.
			let method: MergeMethod = "merge";
			let assertion = await assertMerged({ repo, defaultBranch, branchTipSha: branchTip, prNumber: entry.prNumber }, method);
			if (!assertion.ok) {
				const configured = mergeMethod();
				const viaViewMethod: MergeMethod = configured === "merge" ? "squash" : configured;
				const viaView = await assertMerged({ repo, defaultBranch, branchTipSha: branchTip, prNumber: entry.prNumber }, viaViewMethod);
				if (viaView.ok) {
					assertion = viaView;
					method = viaViewMethod;
				}
			}
			if (!assertion.ok) {
				this.log("warn", `pr-reconcile: merge reachability assertion failed for ${entry.branch} (PR #${entry.prNumber}) via both the merge-ancestry and gh-view checks: ${assertion.detail}`);
				return;
			}
			recordDoneProof(this.stateDir, {
				branch: entry.branch,
				repo: entry.repo,
				issueId: entry.issueId,
				issueIdentifier: entry.issueIdentifier,
				mode: "pr",
				method,
				commit: assertion.commit ?? branchTip,
				mergeCommit: assertion.mergeCommit,
				baseRef: `origin/${defaultBranch}`,
				verified: "unverified",
				detail: `merged out-of-band via GitHub UI (confirmed via ${method === "merge" ? "merge-ancestry" : "gh-view headRefOid/mergeCommit"} check); gate not re-verified by the daemon`,
				provenAt: Date.now(),
				prNumber: entry.prNumber,
				prUrl: entry.prUrl,
			});
			const rec = this.agentByBranch(entry.branch);
			if (rec) rec.dto.landReady = false; // successful land ⇒ clear the confirm-mode staged flag, same as land()
			recordLandOutcome(this.stateDir, entry.branch, true, "merged out-of-band");
			// Joined task-outcome row (concern 03): this path is branch-keyed and the AgentRecord may
			// already be evicted from the live roster by the time an out-of-band merge is caught —
			// resolve the SAME agentId land() would have written via the roster-then-receipts fallback, so
			// the idempotent upsert-on-read collapses to one row instead of a duplicate. Unresolvable ⇒
			// log-and-skip (never fabricate an agentId — see resolveAgentIdForBranch's doc).
			const outcomeAgentId = rec?.dto.id ?? (await this.resolveAgentIdForBranch(entry.branch));
			if (outcomeAgentId) {
				try {
					await recordTaskOutcome(this.stateDir, {
						agentId: outcomeAgentId,
						branch: entry.branch,
						routing: rec?.options.routing ?? { mode: "none", tier: tierOf(rec?.options.thinking) },
						model: rec?.dto.model,
						costUsd: rec?.dto.receipt?.costUsd,
						confidence: rec?.dto.confidence,
						validation: rec?.dto.validation?.verdict,
						outcome: "landed",
						source: "reconciled",
						ts: Date.now(),
					} satisfies TaskOutcomeRow);
				} catch (err) {
					this.log("warn", `task-outcome record failed for ${entry.branch} (reconciled, non-fatal): ${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				this.log("warn", `task-outcome: could not resolve agentId for out-of-band merge of ${entry.branch} — skipping row (roster gone, no matching receipt)`);
			}
			const closed = await this.attemptCloseFor(entry, repo);
			if (rec) this.emitAgent(rec);
			updatePendingPr(this.stateDir, entry.branch, { state: "merged", mergedAt: Date.now(), proofAt: Date.now(), ...(closed ? { issueClosedAt: Date.now() } : {}) });
			return;
		}

		if (view.state === "CLOSED" && entry.state !== "closed") {
			updatePendingPr(this.stateDir, entry.branch, { state: "closed" });
			this.log("warn", `pr-reconcile: PR #${entry.prNumber} for ${entry.branch} closed without merging — branch and landReady left intact; a re-Land will open a fresh PR`);
		}
	}

	/**
	 * Push-retry: covers a crash between push and `gh pr create`, and a floated push (concern 06's
	 * `floatPrOnLandReady`) that failed silently. Deliberately a near-duplicate of that method's body
	 * rather than a shared extraction — mirrors land-pr.ts's own stated convention of duplicating small
	 * helpers rather than cross-importing another module's private seam.
	 */
	private async retryPushFloat(rec: AgentRecord): Promise<void> {
		const dto = rec.dto;
		if (!dto.branch) return;
		const mode = await this.resolveLandModeFor(dto.repo);
		if (mode.mode !== "pr" || !mode.defaultBranch) return;
		const ensure = await ensurePr({
			repo: dto.repo,
			branch: dto.branch,
			defaultBranch: mode.defaultBranch,
			title: `squad(${dto.name}): land ${dto.branch}`,
			issueId: dto.issue?.id,
			issueIdentifier: dto.issue?.identifier,
			issueProjectId: dto.issue?.projectId,
			agentId: dto.id,
			stateDir: this.stateDir,
		});
		if (ensure.ok && ensure.prNumber !== undefined && ensure.prUrl !== undefined) {
			rec.dto.prUrl = ensure.prUrl;
			rec.dto.prNumber = ensure.prNumber;
			rec.dto.prState = ensure.prState ?? "draft";
			this.emitAgent(rec);
		} else {
			this.log("warn", `pr-reconcile: push retry failed for ${dto.name} (${dto.branch}): ${ensure.detail ?? "unknown"}`);
		}
	}

	/**
	 * Best-effort fast-forward heal for a repo resolved to PR mode: when the local checkout is
	 * STRICTLY behind `origin/<default>` (an ancestor of it, not equal) and currently checked out on
	 * that default branch, fast-forward it. `--ff-only` can never overwrite or lose local work by
	 * construction — a strictly-behind fast-forward has nothing to lose. Runs inside the SAME
	 * `withRepoLandLock` a live land uses, so it never races an in-flight merge/scratch-gate.
	 *
	 * The `current !== defaultBranch` guard below is LOAD-BEARING, and is the only thing enforcing it.
	 * It used to be belt-and-braces: `resolveLandMode`'s probe 4 refused pr mode outright on a
	 * non-default checkout, so this function could never see one. That interlock was removed (it made
	 * the fleet unable to land whenever an operator was working in the repo — see land-mode.ts probe 4),
	 * so pr mode is now perfectly valid while HEAD sits on a feature branch. Deleting this check as
	 * "redundant" would let `merge --ff-only origin/<default>` run against whatever branch the operator
	 * is standing on and silently advance it. This is the only write PR mode ever makes to the shared
	 * checkout; keep it pinned to the default branch.
	 */
	private async ffHealOne(repo: string): Promise<void> {
		const mode = await this.resolveLandModeFor(repo);
		if (mode.mode !== "pr" || !mode.defaultBranch) return;
		const defaultBranch = mode.defaultBranch;
		const current = (await hardenedGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })).stdout.trim();
		if (current !== defaultBranch) return; // LOAD-BEARING (see doc comment): never ff a feature checkout
		await hardenedGit(["fetch", "origin", defaultBranch], { cwd: repo }).catch(() => undefined);
		const localSha = (await hardenedGit(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
		const remoteSha = (await hardenedGit(["rev-parse", `origin/${defaultBranch}`], { cwd: repo })).stdout.trim();
		if (!localSha || !remoteSha || localSha === remoteSha) return; // already converged
		const behind = await isAncestor(localSha, `origin/${defaultBranch}`, repo); // ancestor + not-equal ⇒ strictly behind, never ahead/diverged
		if (!behind) return;
		await withRepoLandLock(repo, async () => {
			// TOCTOU: the branch check above ran before the fetch and before this lock. `withRepoLandLock`
			// serializes the DAEMON's lands, not the operator's `git checkout` — so between the check and
			// here the human can have switched onto a feature branch whose tip happens to be an ancestor of
			// origin/<default>, and `merge --ff-only` would silently advance THEIR branch. Re-read HEAD
			// inside the lock and bail if anything moved. The window is not closable (git has no such lock),
			// but this narrows it from "one fetch round-trip" to a couple of milliseconds.
			const stillOnDefault = (await hardenedGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })).stdout.trim();
			if (stillOnDefault !== defaultBranch) return; // operator switched branches mid-heal — never touch it
			const stillAt = (await hardenedGit(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
			if (stillAt !== localSha) return; // checkout moved under us — re-probe next tick rather than guess
			const merge = await hardenedGit(["merge", "--ff-only", `origin/${defaultBranch}`], { cwd: repo });
			if (merge.code === 0) this.log("info", `pr-reconcile: ff-healed ${repo} to ${remoteSha}`);
			else this.log("warn", `pr-reconcile: ff-heal merge --ff-only failed for ${repo}: ${merge.stderr.trim()}`);
		});
	}

	/**
	 * Reward-boost tag (agentic-learning-loop concern 03) for this run's digest — boost-only, read-only
	 * on the deterministic proof (never a gate, never rewritten here). `null` (not `undefined`) as soon
	 * as the flag is off or no proof exists, so `buildDigest` omits the tag entirely: absence is
	 * "unknown", never "bad". `firstTryGreen` reads the SAME `visits.fixup` count concern 01's baseline
	 * metric derives from, so both stay in agreement about what "first try" means.
	 */
	private async digestReward(rec: AgentRecord): Promise<DigestReward | null> {
		if (!isOn(learningFlags(rec.dto.id).rewardBoost)) return null;
		const proof = await proofFor(rec.dto.repo, rec.dto.worktree).catch(() => undefined);
		if (!proof) return null; // no proof ran ⇒ unknown, not a tag
		const head = await headCommit(rec.dto.worktree).catch(() => "");
		const fresh = isFresh(proof, head);
		const fixupVisits = rec.options.workflowState?.visits?.fixup ?? 0;
		return { ok: proof.ok, fresh, firstTryGreen: proof.ok && fresh && fixupVisits === 0 };
	}

	/**
	 * Persist one JSONL receipt line for a completed/terminated run, then clear
	 * the accumulator so the next turn starts fresh. Idempotent per run via the
	 * accumulator's `finalized` flag (agent_end + exit can both fire).
	 */
	/**
	 * The unit's real blast radius: every file it has touched since forking from its base, committed or
	 * not. Feeds the receipt, and through it `scoreConfidence`'s `filesTouched` term and the
	 * task-outcomes ledger.
	 *
	 * A bare `git status` probe (what this used to be) counts only UNCOMMITTED paths, so a unit that
	 * committed its own work reported ZERO files touched — and `confidence.ts` reads `<= 3` as a
	 * small-change BONUS, `> 12` as a penalty, with confidence gating auto-land. Live ledger on this
	 * host: 16 of 18 rows carried `filesTouched: 0`, one of them for a change that really touched 16
	 * files. `commitAgentWip` (the daemon's own pre-verify sweep) makes committed work the normal case,
	 * so this had to become base-relative or the signal would have gone permanently to zero.
	 *
	 * Base: `origin/<default>` in PR mode (where the unit forked from), else the shared checkout's HEAD —
	 * the same base `land()` merges into. An in-place agent (no branch of its own) has no fork point;
	 * its working tree IS the change.
	 */
	private async runFilesTouched(rec: AgentRecord): Promise<string[]> {
		const { repo, worktree, branch } = rec.dto;
		if (!branch || path.resolve(worktree) === path.resolve(repo)) return changedFiles(worktree);
		try {
			const mode = await this.resolveLandModeFor(repo);
			let baseRef: string | undefined;
			if (mode.mode === "pr" && mode.defaultBranch) baseRef = `origin/${mode.defaultBranch}`;
			else {
				const head = await hardenedGit(["rev-parse", "HEAD"], { cwd: repo });
				baseRef = head.code === 0 ? head.stdout.trim() : undefined;
			}
			if (!baseRef) return changedFiles(worktree);
			return await filesTouchedSinceBase(worktree, baseRef);
		} catch {
			return changedFiles(worktree); // never let a receipt fail over a metric
		}
	}

	/**
	 * Ask a question. The deliverable is an ANSWER, not a branch (R5, the founding brief's "half of
	 * engineering is read/judge/decide work, and glance has no primitive for it").
	 *
	 * `executionRole: "observer"` is the whole safety story and it already existed: `is-landing-unit.ts`
	 * refuses to land an observer, so this unit can never commit, never open a PR, never touch main. It
	 * still gets a real worktree — an answer that had to read the repo through a keyhole would be worse
	 * than no answer — and that worktree is simply discarded.
	 *
	 * `track: false`: an answer is not work to be dispatched, verified, or landed. `autoRoute: false`: the
	 * router turns tasks into build workflows, which is exactly what this is not.
	 */
	async ask(opts: { repo: string; question: string; model?: string; harness?: string; name?: string }, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		const question = opts.question.trim();
		if (!question) throw new Error("ask: a question is required");
		const dto = await this.create(
			{
				repo: opts.repo,
				name: opts.name ?? `ask-${Date.now().toString(36)}`,
				task: answerBrief(question),
				ask: question,
				executionRole: "observer",
				autoRoute: false,
				track: false,
				approvalMode: "yolo",
				model: opts.model,
				harness: opts.harness,
			},
			actor,
		);
		await saveAnswer(this.stateDir, { id: dto.id, question, repo: opts.repo, markdown: "", askedAt: Date.now(), model: dto.model, harness: dto.harness });
		return dto;
	}

	/** Answers already given, newest first. */
	answers(repo?: string): Promise<Answer[]> {
		return listAnswers(this.stateDir, { repo });
	}

	answer(id: string): Promise<Answer | undefined> {
		return readAnswer(this.stateDir, id);
	}

	/**
	 * Persist an answer unit's final message. Best-effort and idempotent: a unit may end several turns
	 * (a steer, a follow-up question), and the LAST one is the answer — re-answering overwrites, because
	 * an operator who asks again wants the new answer, not two.
	 *
	 * Never throws into the frame loop. An answer that fails to save is logged loudly rather than taking
	 * the ingest path down with it, but it is also NOT reported as saved.
	 */
	protected async captureAnswer(rec: AgentRecord): Promise<void> {
		const question = rec.options.ask;
		if (!question) return;
		try {
			const final = [...rec.transcript].reverse().find((t) => t.kind === "assistant" && t.text.trim().length > 0);
			if (!final) {
				this.log("warn", `${rec.dto.name}: answer unit ended with no final message — nothing to save`);
				return;
			}
			const existing = await readAnswer(this.stateDir, rec.dto.id);
			const askedAt = existing?.askedAt ?? Date.now();
			const answeredAt = Date.now();
			const ok = await saveAnswer(this.stateDir, {
				id: rec.dto.id,
				question,
				repo: rec.dto.repo,
				markdown: final.text.trim(),
				askedAt,
				answeredAt,
				durationMs: answeredAt - askedAt,
				model: rec.dto.model,
				harness: rec.dto.harness,
			});
			if (!ok) this.log("warn", `${rec.dto.name}: answer could not be persisted (disk write failed)`);
			else this.log("info", `${rec.dto.name}: answer saved (${final.text.trim().length} chars) — glance answers ${rec.dto.id}`);
		} catch (err) {
			this.log("warn", `${rec.dto.name}: capturing the answer failed: ${errText(err)}`);
		}
	}

	/**
	 * Attach the cold-start context primer to a spawn's system prompt — the fabric's most relevant prior
	 * decisions, hot files and peer context, at zero turn cost.
	 *
	 * R3 (founding brief: "units are context-poor"). This used to be gated on `opts.featureId`, and
	 * NOTHING dispatch spawns carries one: `dispatchSpawn` calls `create({repo, name, branch, task,
	 * issue})` with no featureId, and neither does `glance add`. Only the feature-linked
	 * `POST /api/features/:id/agents` path set it. So the primer never ran for a dispatched or ad-hoc unit
	 * — and the `primer-empty` metric, which lives INSIDE that branch, has ZERO records across this host's
	 * entire learning-metrics log. The instrument was inside the thing it was meant to measure.
	 *
	 * Now: any spawn with a repo and something to search on gets it. Best-effort — a failure logs and the
	 * spawn proceeds unprimed, never blocked. `buildContextPrimer` fences its own output as untrusted, so
	 * this must not re-fence. `OMP_SQUAD_CONTEXT_PRIMER=0` disables it.
	 */
	/** Injection seam for the primer circuit breaker's clock. */
	protected now(): number {
		return Date.now();
	}

	protected async primeContext(opts: CreateAgentOptions, actor: Actor): Promise<{ opts: CreateAgentOptions; hasPrimer: boolean }> {
		const query = [opts.task, opts.name, opts.issue?.name].filter((t): t is string => typeof t === "string" && t.trim().length > 0).join(" ");
		if (!contextPrimerEnabled() || !opts.repo || !query) return { opts, hasPrimer: false };
		// Timing out the RACE does not cancel the READ — `fabric()` keeps enumerating receipts and waiting
		// on Plane. The dispatcher spawns serially, so a slow fabric makes every unit in the tick start its
		// own full scan while the last one is still running, and the daemon amplifies its way into the
		// stall it was supposed to bound. After a timeout, stop asking for a while. (grok-4.5)
		if (this.now() < (this.primerBreakerUntil.get(opts.repo) ?? 0)) return { opts, hasPrimer: false };
		try {
			// BOUNDED. `fabric()` enumerates every receipt file, reads every digest, and calls Plane's issue
			// list — whose fetch carries no timeout. The dispatcher awaits each spawn serially, so one
			// stalled fetch or a repo with thousands of historical receipts delays every later issue in the
			// tick. "Best-effort, never blocks a spawn" was only half true: it never FAILED a spawn, but it
			// could hang one. Found by cross-lineage review (gpt-5.6-sol).
			const budgetMs = envInt("OMP_SQUAD_PRIMER_TIMEOUT_MS", 5_000);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const snapshot = await Promise.race([
				// `Promise.race` subscribes to BOTH, so a fabric() that rejects after the timeout wins is
				// still handled — no unhandled rejection can take the daemon down.
				this.fabric(actor, { repos: [opts.repo], includeLeases: true }),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`context primer timed out after ${budgetMs}ms`)), budgetMs);
					timer.unref?.();
				}),
			]).finally(() => clearTimeout(timer));
			const primer = buildContextPrimer(snapshot, query);
			this.learningMetrics.record("primer-empty", primer ? 0 : 1, { flag: "context-primer", variant: opts.featureId ? "feature" : "dispatch" });
			if (!primer) return { opts, hasPrimer: false };
			return {
				opts: { ...opts, appendSystemPrompt: [opts.appendSystemPrompt, primer].filter((text): text is string => typeof text === "string" && text.length > 0).join("\n\n") || undefined },
				hasPrimer: true,
			};
		} catch (err) {
			const timedOut = errText(err).includes("timed out");
			if (timedOut) {
				const backoff = envInt("OMP_SQUAD_PRIMER_BACKOFF_MS", 60_000);
				this.primerBreakerUntil.set(opts.repo, this.now() + backoff);
				this.log("warn", `context primer timed out for ${opts.repo} — priming paused there for ${backoff}ms (the fabric read is still running behind us)`);
			} else this.log("warn", `context primer failed: ${errText(err)}`);
			return { opts, hasPrimer: false };
		}
	}

	private async finalizeRun(rec: AgentRecord): Promise<void> {
		const run = rec.run;
		if (!run || run.finalized) return;
		run.finalized = true;
		// Receipt attribution gap (orchestration receipts audit 2026-07-07): `applyState`'s poll loop
		// backfills `rec.dto.model` (provider/id form) off the LIVE RPC session's own reported model —
		// a DIFFERENT, independent signal from the `message_end` wire frame `noteModel` late-binds from
		// inside `ingest()`. A run whose model was never explicit at start() and never emitted a
		// message-level model (or emitted one before the poll's first backfill landed) would otherwise
		// finalize with an empty `seed.model` despite the DTO already knowing the real model. `noteModel`
		// is itself first-model-wins (never overwrites an explicit start()-time model), so this is a
		// pure gap-fill, not a behavior change for a run that already resolved its model earlier.
		if (rec.dto.model) run.noteModel(rec.dto.model);
		run.finish(rec.dto.status, await this.runFilesTouched(rec));
		const receipt = run.snapshot({ sampleRatio: traceSampleRatio(), maxSpans: traceMaxSpans() });
		// Epic 3 (leaf 04): copy the land gate's ValidationRecord onto the durable receipt so it
		// survives the run — the input Epic 5's confidence scorer reads via buildDigest.
		if (rec.dto.validation) receipt.validation = rec.dto.validation;
		// Epic 5 (HITL safeguards, DESIGN.md D1): pure, deterministic run-end self-confidence from
		// signals already on the record — the proof state and the blast-radius proxy (files touched).
		// `validator` folds in Epic 3's independent-validator verdict when one ran: "pass" (all declared
		// criteria satisfied) or "veto" (fail-closed, at least one unsatisfied) map to pass/fail;
		// "abstain" (judge unreachable, fail-open) and "skipped" (no declared criteria) map to
		// `undefined` — absence never penalizes.
		const validator: "pass" | "fail" | undefined =
			rec.dto.validation?.verdict === "pass" ? "pass" : rec.dto.validation?.verdict === "veto" ? "fail" : undefined;
		const conf = scoreConfidence({ verificationState: rec.dto.verificationState ?? "unknown", filesTouched: receipt.filesTouched.length, validator, sameLineage: rec.dto.validation?.sameLineage, lensAdvisory: lensAdvisoryBucket(rec.dto.validation) });
		receipt.confidence = conf;
		await appendReceipt(this.stateDir, receipt); // full receipt on disk (both modes)
		if (receipt.spans?.length) this.traceExporter?.enqueue(receipt.spans, { service: "omp-squad", repo: receipt.repo, operator: this.operator.id, org: this.operator.orgId });
		// Queryable per-org cost/token ledger (DB mode); FileStore is a no-op since the receipt is on disk.
		await this.store.appendUsage(receipt).catch((err) => this.log("warn", `usage write failed for ${rec.dto.name}: ${err instanceof Error ? err.message : String(err)}`));
		// Best-effort cold-start digest: a failure here must never break run completion.
		try {
			const reward = await this.digestReward(rec);
			const md = buildDigest({ transcript: rec.transcript, receipts: await readReceipts(this.stateDir, rec.dto.id), reward });
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
		rec.dto.confidence = conf;
		// A NEW run's outcome supersedes any PRIOR run's auto-report — prune the stale `auto-*` notes so a
		// now-lifted low-confidence flag stops nagging in "Needs you" (review MINOR). Only auto-emitted
		// reports (id `auto-*`) are pruned; agent-raised `squad_report` notes (uuid ids) persist until the
		// human dismisses them by viewing. If this run is ALSO low-confidence, a fresh auto-report is added
		// just below; if it recovered (≥ floor), the channel simply clears.
		if (rec.dto.reports?.length) {
			const kept = rec.dto.reports.filter((r) => !r.id.startsWith("auto-"));
			rec.dto.reports = kept.length ? kept : undefined;
		}
		// Epic 5 (HITL safeguards, DESIGN.md D2): low-confidence auto-escalation — the join of leaves
		// 02 (score)+03 (cap)+05 (report channel). A run finishing below the floor gets a NON-blocking
		// report appended so it surfaces as a "Needs you" row instead of silently sitting land-ready;
		// the leaf-03 cap (recomputed below by emitAgent's syncAuthority call) has already dropped it
		// to assist/propose-only. De-duped by runId so a re-finalize (finalized guard above makes this
		// defensive, not load-bearing) never doubles the report.
		if (conf < confidenceFloor()) {
			const reportId = `auto-${receipt.runId}`;
			if (!(rec.dto.reports ?? []).some((r) => r.id === reportId)) {
				const touched = receipt.filesTouched;
				const proposal = touched.length ? `${touched.length} file${touched.length === 1 ? "" : "s"} touched: ${touched.slice(0, 10).join(", ")}${touched.length > 10 ? `, +${touched.length - 10} more` : ""}` : "no files touched";
				const report: AgentReport = {
					id: reportId,
					summary: `Low confidence (${conf.toFixed(2)}) — verify before landing`,
					proposal,
					confidence: conf,
					createdAt: Date.now(),
				};
				rec.dto.reports = [...(rec.dto.reports ?? []), report];
			}
		}
		rec.dto.traceId = run.traceId || rec.dto.traceId; // same sticky rule as the turn-progress site above
		rec.options.traceId = rec.dto.traceId; // topology review finding 7: mirror onto PersistedAgent so a restart never drops the trace link
		// Run-end closure: stamp any subagent left non-terminal (started but never got a terminal frame
		// before this run ended) aborted, and flush the merge — so no persisted node can claim "running"
		// forever under a run that has already finished.
		rec.subs.closeNonTerminal();
		if (rec.subs.isDirty()) {
			rec.dto.subagents = mergeSubagents(rec.options.subagents, rec.subs.snapshot());
			rec.options.subagents = rec.dto.subagents;
			rec.subs.clearDirty();
			void this.persist();
		}
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

	/**
	 * Sentinel v0 (plans/sentinel-drift-probe) eligibility gate: a unit is monitor-eligible only when
	 * it has DECLARED acceptance criteria — resolves the feature-store criteria (`rec.dto.featureId` →
	 * the persisted feature's `acceptanceCriteria`) — and isn't env-denied (`sentinelDenied`). This is
	 * NOT the same resolution `runValidatorGate` uses at land time: an ad-hoc land-time
	 * `opts.criteria` override (bypassing the feature store) is not monitored in v0. Ineligible ⇒
	 * `undefined`, which the Scout wiring below turns into an omitted `criteria` field, making the
	 * drift path a no-op for this unit (a criteria-less unit's judge would "skip" anyway — DESIGN.md's
	 * Unit gate decision). Re-resolved live (not cached) so a feature's criteria edited mid-run, or a
	 * denylist changed, takes effect on the very next scan/hypothesis.
	 */
	private monitorCriteriaFor(rec: AgentRecord): FeatureCriterion[] | undefined {
		if (sentinelDenied(rec.dto.id, rec.dto.name)) return undefined;
		const pf = rec.dto.featureId ? this.featureStore.get(rec.dto.featureId) : undefined;
		const criteria = pf?.acceptanceCriteria ?? [];
		return criteria.length > 0 ? criteria : undefined;
	}

	/**
	 * Sentinel v0's manager-owned, action-free sink (plans/sentinel-drift-probe, concern 02) — the
	 * ONLY place a drift hypothesis is judged. Scout relays a raw `Hypothesis` here (fire-and-relay, no
	 * await on its side); this sink resolves the LIVE agent record, re-checks eligibility (a unit can
	 * turn ineligible between the hypothesis and the confirm), and builds `ConfirmDeps` from it: the
	 * same criteria resolution, the FULL mid-run change set (`gitDiffSinceBase` — committed commits AND
	 * uncommitted edits since the branch forked; a long-running agent commits incrementally, so
	 * `gitDiffAgainstHead`'s uncommitted-only diff would read "" and the judge would abstain on every
	 * committed unit of work), and the runId-turnover guard (DESIGN.md's "Sweep-vs-finalizeRun race" —
	 * a sweep can outlast `finalizeRun` tearing the run down; a hypothesis with no `runId` can never be
	 * safely attributed to a live run, so it is never confirmed either). `confirmDrift` appends the
	 * judge-confirmed (or abstained/skipped) verdict to the durable off-Plane audit log — v0 never
	 * surfaces, steers, or feeds `confidence.ts`. Wrapped so a failure here can never crash a scan
	 * (Scout already doesn't await this).
	 */
	private onDriftHypothesis(h: Hypothesis): void {
		void (async () => {
			try {
				const rec = h.agent ? this.agents.get(h.agent) : undefined;
				if (!rec) return;
				const criteria = this.monitorCriteriaFor(rec);
				if (!criteria) return; // turned ineligible since the hypothesis was raised — nothing to confirm
				await confirmDrift({
					hypothesis: h,
					criteria,
					diff: () => gitDiffSinceBase(rec.dto.worktree),
					// h.runId != null is load-bearing: without it, `undefined === undefined` would pass whenever
					// BOTH the hypothesis lacks a runId AND the run already tore down (rec.run undefined) —
					// confirming/recording a hypothesis that can never be safely attributed to a live run.
					stillLive: () => h.runId != null && rec.run?.snapshot().runId === h.runId,
					stateDir: this.stateDir,
					log: (m) => this.log("info", `sentinel[${rec.dto.repo}]: ${m}`),
				});
			} catch (e) {
				this.log("warn", `sentinel: onHypothesis sink failed (contained): ${e instanceof Error ? e.message : String(e)}`);
			}
		})();
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

	/** Every persisted receipt on disk (the append-only ledger), regardless of whether its agent is
	 *  still in the live roster. The receipt-backed dashboard panels (usage/heat/activity) read this so
	 *  reaped agents and post-restart history stay visible — a per-live-agent read hides all of it. */
	async allReceipts(): Promise<RunReceipt[]> {
		return readAllReceipts(this.stateDir);
	}

	/**
	 * Interactive-spawn cost/outcome scoreboard (research-sirvir/03, the dead-wire fix): closes over
	 * the manager's own PRIVATE `this.stateDir` — mirrors `allReceipts()` above and the
	 * `shadowCostCheck(this.stateDir, …)` call pattern — so a DB-mode org-scoped manager (a private
	 * `stateDir = root/orgs/orgId`, see `manager-registry.ts`) reads its OWN tenant's ledger, never the
	 * global `resolveStateDir()` root, which would read the wrong (empty, for every tenant) ledger
	 * while recording happens under the org dir. `readModelOutcomes`/`buildScoreboard` already apply
	 * research-sirvir/02's `modelFamily` normalization, so a `smart-spawn.ts` candidate lookup
	 * (`"opus"`/`DEFAULT_MODEL_FAMILY`) hits regardless of the raw id shape a receipt or ledger row
	 * carries.
	 *
	 * TTL + single-flight cached (cross-lineage review of PR #114): `readAllReceipts` is an
	 * O(lifetime-receipts) directory walk + parse (hundreds of files on a mature install), and with
	 * `OMP_SQUAD_MODEL_OUTCOMES=1` EVERY interactive `POST /api/spawn` hits this — so the built board
	 * is cached per manager instance for `SPAWN_SCOREBOARD_TTL_MS`, and concurrent requests during a
	 * rebuild share ONE in-flight promise instead of racing N full scans. v1 is TTL-only (no
	 * invalidation hooks): the upgrade path, if minutes-stale ever matters, is to invalidate from
	 * `recordModelOutcome`/`appendReceipt` — but outcome data only changes on lands, so staleness
	 * bounded by the TTL is immaterial for a routing tie-breaker. A rebuild FAILURE is not cached
	 * (the in-flight slot clears on rejection), so one bad scan can't poison the TTL window.
	 */
	async spawnScoreboard(): Promise<Scoreboard> {
		const now = Date.now();
		if (this.scoreboardCache && now - this.scoreboardCache.at < SPAWN_SCOREBOARD_TTL_MS) return this.scoreboardCache.board;
		if (!this.scoreboardInflight) {
			this.scoreboardInflight = (async () => {
				try {
					const board = buildScoreboard(await readAllReceipts(this.stateDir), readModelOutcomes(this.stateDir));
					this.scoreboardCache = { at: Date.now(), board };
					return board;
				} finally {
					this.scoreboardInflight = undefined; // success or failure: next TTL-expired call starts a fresh scan
				}
			})();
		}
		return this.scoreboardInflight;
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
	async recordAudit(actor: Actor | string, action: string, target: string | null, outcome: "ok" | "error" = "ok", detail?: string, source?: string): Promise<void> {
		const entry = makeAuditEntry({ actor, action, target, outcome, detail, source });
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
	 * Compliance findings (Epic 3, leaf 05) over the audit log + the two land ledgers — server reads
	 * this for `/api/governance`'s `compliance` key, and the Observer loop (leaf 06) reads it as an
	 * additional finding source. Keeps `stateDir` private (same pattern as `auditLog`/`receipts`).
	 */
	async complianceFindings(): Promise<ComplianceFinding[]> {
		return evaluateCompliance({
			readAudit: (q) => readAudit(this.stateDir, q),
			forcedLands: () => readForcedLands(this.stateDir),
			validatorOverrides: () => readValidatorOverrides(this.stateDir),
			landLedger: () => readLandLedger(this.stateDir),
		});
	}

	/**
	 * Background-loop activity (scout/observer/opportunity/dispatch): the recent event feed plus per-loop
	 * rollups over a trailing window. The observability surface the audit log never carried — it answers
	 * "what is running in the background, how often, and what is it costing" (server reads this for /api/automation).
	 */
	automationActivity(query: AutomationQuery & { windowMs?: number } = {}): { events: AutomationEvent[]; rollup: ReturnType<AutomationLog["rollup"]> } {
		return { events: this.automation.recent(query), rollup: this.automation.rollup(query.windowMs) };
	}

	/**
	 * Agentic-learning-loop baseline (concern 01, server reads this for GET /api/metrics/learning-loop):
	 * per-metric rollups (count/sum/avg, broken down by tag) over a trailing window, plus the CURRENT
	 * flag resolution so an operator can see both "what's on" and "what effect it's had" in one call.
	 */
	learningMetricsSnapshot(windowMs?: number): { flags: ReturnType<typeof learningFlags>; rollup: MetricRollupRow[] } {
		return { flags: learningFlags(), rollup: this.learningMetrics.rollup(windowMs) };
	}

	/**
	 * First-glance factory liveness (server reads this for GET /api/factory/status). Answers the trust
	 * question the automation rollup couldn't: for every autonomous loop, is it flag-enabled, did it
	 * actually ARM this run, and — if not — WHY (the authoritative `planeRepos().length === 0` gate
	 * reason), plus its live heartbeat freshness and a derived status enum. `liveArmed` reads the manager's
	 * real runtime fields, so "armed but not fueled" is provably distinct from "off" and from "dead".
	 */
	factoryStatus(now = Date.now()): FactoryStatus {
		// Freshness window: the widest per-loop budget (3 cadences, floor 5m) so a recent heartbeat still
		// shows up in the rollup regardless of loop cadence.
		const windowMs = Math.max(...FACTORY_LOOPS.map((l) => Math.max(l.cadenceMs * 3, FACTORY_FRESHNESS_FLOOR_MS)));
		const liveArmed: Record<string, boolean> = {
			dispatch: !!this.dispatcher,
			observer: this.observers.length > 0,
			scout: this.scouts.size > 0,
			opportunity: this.opportunities.length > 0,
			residentPlanner: this.residentPlanners.length > 0,
			// orchestrator is always built, but its control loop only arms the timer when AUTODRIVE is on.
			autodrive: !!this.orchestrator && process.env.OMP_SQUAD_AUTODRIVE !== "0",
			autoland: this.autoLand,
		};
		return buildFactoryStatus({
			now,
			env: process.env,
			planeRepoCount: planeRepos().length,
			rollup: this.automation.rollup(windowMs, now),
			liveArmed,
			activeAgents: occupyingAgents(this.list()),
			persistFailures: this.store.saveFailures?.() ?? 0,
		});
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

	// ── Plan-vote rounds (PLAN-VOTE-COMMIT.md — the majority-of-assignees gate) ───────────────────
	// Business-rule guards that DON'T race ("A>0", "reviewGateOpen", candidate resolution, SHA
	// snapshot) live in server.ts's route handler, same "pure storage, caller validates" split as
	// setAssignees/comments above. The two guards that DO race — "no open round already exists"
	// (open) and "the round is still voting" (cast) — are enforced HERE, inside `withVoteLock`, so
	// the check and the append that depends on it are atomic per feature.

	/** Serialize `fn` against every other plan-vote mutation for `featureId` (open + cast), so a
	 *  check-then-append is never interleaved with a concurrent one. Mirrors land.ts's
	 *  `withRepoLandLock`: chain onto the previous op's settled promise, swallowing its result so one
	 *  op's failure never poisons the next. */
	private withVoteLock<T>(featureId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.voteLocks.get(featureId) ?? Promise.resolve();
		const run = prev.catch(() => {}).then(fn);
		this.voteLocks.set(featureId, run.catch(() => {}));
		return run;
	}

	/**
	 * Open a new round — ATOMIC check-and-open under the per-feature lock. The caller (server.ts) has
	 * already checked the non-racing preconditions (assignees non-empty, reviewGateOpen, candidate
	 * resolved, SHAs snapshotted); this re-checks the ONE racing precondition (no open round already)
	 * inside the lock so two concurrent calls can't both open a round. Returns `{ conflict: true }`
	 * when a round is already open (the server maps it to 409) — never a second live round.
	 */
	async openPlanVote(input: OpenPlanVoteInput, actor: Actor | string = LOCAL_ACTOR): Promise<PlanVoteRound | { conflict: true }> {
		return this.withVoteLock(input.featureId, async () => {
			if (await readCurrentPlanVoteRound(this.stateDir, input.repo, input.featureId)) return { conflict: true } as const;
			const round = await openPlanVoteRound(this.stateDir, input);
			void this.recordAudit(actor, "plan-vote.call", round.id, "ok", `${round.planPath} — ${round.assignees.length} assignee(s)`);
			this.emitFeaturesChanged();
			return round;
		});
	}

	async listPlanVoteRounds(q: { repo?: string; featureId?: string } = {}): Promise<PlanVoteRound[]> {
		return readPlanVoteRounds(this.stateDir, q);
	}

	/** The currently-open round for a feature, or undefined — what `/plan-vote/call`'s fast 409
	 *  pre-check and the GET endpoint's "current round" both read. Deterministic under a stray
	 *  double-open: `currentPlanVoteRound` returns the EARLIEST-opened voting round (fold order is
	 *  open order), and the lock above prevents a second open from ever being created anyway. */
	async currentPlanVote(repo: string, featureId: string): Promise<PlanVoteRound | undefined> {
		return readCurrentPlanVoteRound(this.stateDir, repo, featureId);
	}

	/**
	 * Cast one assignee's approve/reject on an open round — the whole read→cast→fold→close→side-effect
	 * runs ATOMIC under the per-feature lock, so a deciding cast's `onVotePassed`/reject side-effect
	 * fires EXACTLY ONCE. Two concurrent deciding casts serialize: the first closes the round; the
	 * second re-reads AFTER, sees `state !== "voting"`, and throws (no re-fire). Idempotent per actor
	 * (last write wins — no double-vote). Once `computeVoteQuorum` reports `decided`, closes:
	 *   - PASSED: calls the `onVotePassed` seam (the commit-on-pass unit's hand-off — this unit does
	 *     NOT commit/land anything; onVotePassed must be idempotent regardless, and V4 also guards).
	 *   - REJECTED: transitions the round's candidate to "rejected" (discarded, plan unchanged).
	 * `featureId` is the lock key (the round belongs to it); membership (`actorId` ∈ round.assignees,
	 * the CALL-TIME snapshot) is the CALLER's authz job. Throws if no such round exists / already closed.
	 */
	async castPlanVote(featureId: string, roundId: string, actorId: string, choice: PlanVoteChoice, actor: Actor | string = LOCAL_ACTOR): Promise<{ round: PlanVoteRound; quorum: VoteQuorum }> {
		return this.withVoteLock(featureId, async () => {
			const before = (await readPlanVoteRounds(this.stateDir, {})).find((r) => r.id === roundId);
			if (!before) throw new Error(`no such plan-vote round: ${roundId}`);
			if (before.state !== "voting") throw new Error(`plan-vote round ${roundId} is already ${before.state}`);
			await appendPlanVoteCast(this.stateDir, roundId, actorId, choice);
			let round = (await readPlanVoteRounds(this.stateDir, {})).find((r) => r.id === roundId);
			if (!round) throw new Error(`plan-vote round ${roundId} vanished mid-cast`);
			const quorum = tallyPlanVoteRound(round);
			void this.recordAudit(actor, "plan-vote.cast", roundId, "ok", `${actorId} ${choice}`);
			if (quorum.decided && round.state === "voting") {
				const outcome: "passed" | "rejected" = quorum.passed ? "passed" : "rejected";
				await appendPlanVoteClose(this.stateDir, roundId, outcome, quorum.reason);
				round = { ...round, state: outcome, closedAt: Date.now(), closedReason: quorum.reason };
				void this.recordAudit(actor, `plan-vote.${outcome}`, roundId, "ok", quorum.reason);
				if (outcome === "passed") {
					await this.onVotePassed(round);
				} else {
					const reviewer = typeof actor === "string" ? actor : actor.id;
					await transitionPlanRevisionCandidate(this.stateDir, round.candidateId, "rejected", reviewer, `plan vote failed: ${quorum.reason}`);
					void this.recordAudit(actor, "plan-vote.candidate-rejected", round.candidateId, "ok", quorum.reason);
				}
			}
			this.emitFeaturesChanged();
			return { round, quorum };
		});
	}

	/**
	 * COMMIT-ON-PASS (PLAN-VOTE-COMMIT.md §D/§H3): fires once per passing round, the instant it
	 * transitions to "passed", with that round's `baseSha`/`revisionSha`/`assignees`/`casts` already
	 * snapshotted at call time. The per-feature `withVoteLock` guarantees a single fire even under a
	 * concurrent deciding-cast race, but this is STILL defense-in-depth idempotent (guarded on the
	 * round's durable `commitOutcome` marker) against a crash between close and commit, or a future
	 * non-locked caller.
	 *
	 * Scoped doc-only merge, not a full `landAgent`: this lands one reviewed markdown file, not a code
	 * branch through the acceptance/regression/stale/risk gates that exist to protect a shared code
	 * tree from a whole branch's unverified changes. `revisionSha` (the producer branch's tip, resolved
	 * at call time) is a real commit object in the SAME repo's object database — every squad worktree
	 * is a `git worktree add` of this repo, so its history is reachable from the operator checkout by
	 * SHA alone, with no dependency on the producer's worktree still existing (it may already be
	 * reaped by the time a slow vote closes). `git show <sha>:<path>` reads the doc's content at that
	 * revision directly; `git add` + `git commit` land it, scoped to that one path.
	 *
	 * The base-SHA guard (§H3, mandatory): if the plan doc's CURRENT committed SHA has moved past
	 * `round.baseSha` since the round opened (someone else committed to it mid-vote), the vote's
	 * premise — "the assignees approved exactly this diff against exactly this base" — no longer
	 * holds. Refuse to commit, mark the round `commitOutcome: "superseded"` and the candidate
	 * `"superseded"`, and surface a clear "re-call the vote" outcome rather than silently merging over
	 * (or worse, clobbering) whatever changed underneath.
	 */
	private async onVotePassed(round: PlanVoteRound): Promise<void> {
		// Idempotency fast-path: re-read the durable round rather than trusting the possibly-stale object
		// the caller passed in. Once `commitOutcome` is set (committed/superseded/failed), a repeat call is
		// a no-op. Re-checked again INSIDE the repo-land lock below (the authoritative check) — this is
		// just to skip taking the lock in the overwhelming common case.
		const rounds = await readPlanVoteRounds(this.stateDir, { repo: round.repo, featureId: round.featureId });
		const current = rounds.find((r) => r.id === round.id) ?? round;
		if (current.commitOutcome) {
			this.log("info", `plan-vote ${round.id} onVotePassed: already ${current.commitOutcome} — no-op`);
			return;
		}

		// HIGH 3 (TOCTOU vs every other daemon git writer): the base-SHA guard → write → commit critical
		// section runs under the SAME repo-wide land lock landAgent uses (land.ts:withRepoLandLock), nested
		// under the per-feature vote lock the caller already holds. So the shared-tree mutation is atomic
		// against concurrent lands AND other votes — no writer can move the doc between our check and write.
		await withRepoLandLock(round.repo, async () => {
			// Authoritative idempotency re-check, now that we hold the land lock (a racing writer/second
			// onVotePassed could have finalized while we waited for it).
			const recheck = (await readPlanVoteRounds(this.stateDir, { repo: round.repo, featureId: round.featureId })).find((r) => r.id === round.id);
			if (recheck?.commitOutcome) {
				this.log("info", `plan-vote ${round.id} onVotePassed: already ${recheck.commitOutcome} (under lock) — no-op`);
				return;
			}

			const candidate = (await readPlanRevisionCandidates(this.stateDir, {})).find((c) => c.id === round.candidateId);
			if (!candidate) {
				await recordPlanVoteCommit(this.stateDir, round.id, "failed", { detail: `candidate ${round.candidateId} no longer exists` });
				void this.recordAudit(LOCAL_ACTOR, "plan-vote.commit", round.id, "error", `candidate ${round.candidateId} vanished`);
				this.emitFeaturesChanged();
				return;
			}

			const fail = async (detail: string) => {
				await recordPlanVoteCommit(this.stateDir, round.id, "failed", { detail });
				void this.recordAudit(LOCAL_ACTOR, "plan-vote.commit", round.id, "error", detail);
				this.emitFeaturesChanged();
			};

			const accept = async (sha: string, detail: string, auditDetail: string) => {
				await recordPlanVoteCommit(this.stateDir, round.id, "committed", { sha, detail });
				await transitionPlanRevisionCandidate(this.stateDir, round.candidateId, "accepted", LOCAL_ACTOR.id, detail);
				void this.recordAudit(LOCAL_ACTOR, "plan-vote.commit", round.id, "ok", auditDetail);
				this.emitFeaturesChanged();
			};

			// HIGH 1b (KEYSTONE — re-validate the path immediately before committing, never trust a stored
			// path): a PASS commits `planPath`'s content into the shared checkout bypassing the code-land
			// gate. Even though candidate creation already rejects non-plan-doc paths (server.ts), re-enforce
			// here so a persisted-state tamper / future non-HTTP caller can never make the vote commit code.
			if (!isPlanDocPath(round.planPath)) return fail(`refusing to commit a non-plan-doc path: ${round.planPath} (must be plan markdown under plans/)`);
			const abs = resolveSafeDocPath(round.repo, round.planPath);
			if (!abs) return fail(`refusing an unsafe doc path: ${round.planPath}`);

			// Codex hardening: `revisionSha` comes from storage — treat it as an OBJECT ID, not any rev git
			// might resolve (a branch name / "HEAD" / "@" could point somewhere unintended). Require a hex
			// object id, then confirm it names a real commit object.
			if (!round.revisionSha) return fail("no revision to land — the producer branch tip was never resolved at call time");
			if (!/^[0-9a-f]{7,64}$/i.test(round.revisionSha)) return fail(`revision ${round.revisionSha} is not a valid git object id`);
			const tipCheck = await hardenedGit(["-C", round.repo, "cat-file", "-e", `${round.revisionSha}^{commit}`]);
			if (tipCheck.code !== 0) return fail(`revision ${round.revisionSha} is not a reachable commit in ${round.repo} (producer branch/worktree gone before the vote closed)`);

			// §H3 base-SHA guard, now UNDER the land lock (HIGH 3): the doc's CURRENT committed SHA must still
			// match what the round snapshotted at call time. A mismatch means the doc moved under the voters.
			const nowBaseSha = await planDocHeadRevision(round.repo, round.planPath);
			if (nowBaseSha !== round.baseSha) {
				// MEDIUM 5 (crash between commit and marker): a mismatch might be OUR OWN prior commit whose
				// idempotency marker never got written (crash in the gap). Before declaring "superseded",
				// check whether the newest commit touching this doc carries THIS round's `Vote-round:` trailer
				// — if so, we already landed it; reconcile to committed/accepted rather than false-superseding.
				const head = await hardenedGit(["-C", round.repo, "log", "-1", "--format=%B", "--", round.planPath]);
				if (head.code === 0 && head.stdout.includes(`Vote-round: ${round.id}`)) {
					await accept(nowBaseSha, `plan vote ${round.id} passed — reconciled to already-landed ${nowBaseSha} (marker recovered after a crash)`, `${round.planPath} reconciled to ${nowBaseSha} (crash recovery)`);
					this.log("info", `plan-vote ${round.id} reconciled to already-committed ${nowBaseSha}`);
					return;
				}
				const detail = `plan doc ${round.planPath} moved (base was ${round.baseSha || "(none)"}, now ${nowBaseSha || "(none)"}) — revision changed under the vote; re-call the vote`;
				await recordPlanVoteCommit(this.stateDir, round.id, "superseded", { detail });
				await transitionPlanRevisionCandidate(this.stateDir, round.candidateId, "superseded", LOCAL_ACTOR.id, detail);
				void this.recordAudit(LOCAL_ACTOR, "plan-vote.superseded", round.id, "error", detail);
				this.emitFeaturesChanged();
				return;
			}

			// Never overwrite a manually-dirty doc in the operator checkout — same "refuse rather than
			// clobber" discipline landAgent applies to the whole main tree (land.ts's mainStatus guard),
			// scoped here to just the one path.
			const dirty = await hardenedGit(["-C", round.repo, "status", "--porcelain", "--", round.planPath]);
			if (dirty.code === 0 && dirty.stdout.trim().length > 0) return fail(`${round.planPath} has uncommitted changes in the operator checkout — refusing to overwrite them`);

			const content = await hardenedGit(["-C", round.repo, "show", `${round.revisionSha}:${round.planPath}`]);
			if (content.code !== 0) return fail(`could not read ${round.planPath} at ${round.revisionSha}: ${content.stderr || content.stdout}`);

			// HIGH 4 (never leave the shared tree dirty): from here we mutate the working tree. Any failure
			// after the write MUST restore the doc to its pre-write committed content — `git reset` only
			// unstages, it doesn't revert file contents, so we hard-restore from HEAD (the base we verified
			// above) and unstage. `committed` gates the restore off once the commit succeeds.
			let committed = false;
			try {
				await fs.writeFile(abs, content.stdout, "utf8");

				// No-op content (byte-identical to the committed doc): honor the vote by accepting the
				// candidate against the existing HEAD — nothing to commit.
				const afterWrite = await hardenedGit(["-C", round.repo, "status", "--porcelain", "--", round.planPath]);
				if (afterWrite.code === 0 && afterWrite.stdout.trim().length === 0) {
					committed = true; // nothing to restore — the write was a no-op
					const headSha = (await hardenedGit(["-C", round.repo, "rev-parse", "HEAD"])).stdout.trim();
					await accept(headSha, `plan vote ${round.id} passed (no-op — content unchanged)`, `${round.planPath} unchanged at ${headSha}`);
					return;
				}

				const planDir = path.dirname(round.planPath);
				// MEDIUM 6 (trailer injection): candidate.summary and actorIds are attacker-influenceable —
				// a summary or id carrying an embedded newline could forge `Approved-by:`/`Vote-round:`
				// trailers. Collapse every interpolated value to a single line (strip CR/LF + other control
				// chars) so injected newlines can't fabricate metadata.
				const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
				const approvers = round.casts.filter((c) => c.choice === "approve").map((c) => oneLine(c.actorId)).filter((id) => id.length > 0);
				const subject = `plan(${oneLine(planDir)}): adopt reviewed revision — ${oneLine(candidate.summary)}`;
				const trailers = [...approvers.map((id) => `Approved-by: ${id}`), `Vote-round: ${oneLine(round.id)}`].join("\n");
				const message = `${subject}\n\n${trailers}`;

				// HIGH 2 (unscoped commit sweeps pre-staged files): `--only -- <planPath>` records ONLY this
				// path's working-tree content, ignoring anything else already staged in the shared checkout.
				const commit = await hardenedGit(["-C", round.repo, "commit", "--only", "-m", message, "--", round.planPath]);
				if (commit.code !== 0) return fail(`git commit failed: ${commit.stderr || commit.stdout}`);
				committed = true;
				const newSha = (await hardenedGit(["-C", round.repo, "rev-parse", "HEAD"])).stdout.trim();
				await accept(newSha, `plan vote ${round.id} passed — landed ${newSha}`, `${round.planPath} -> ${newSha} (${approvers.length} approver(s))`);
				this.log("info", `plan-vote ${round.id} PASSED and COMMITTED ${round.planPath} -> ${newSha}`);
			} finally {
				if (!committed) {
					// Restore the shared checkout: unstage anything we touched, then hard-restore the file's
					// content from HEAD. Best-effort — the fail()/superseded record already captured the outcome.
					await hardenedGit(["-C", round.repo, "reset", "-q", "--", round.planPath]).catch(() => undefined);
					await hardenedGit(["-C", round.repo, "checkout", "-q", "HEAD", "--", round.planPath]).catch(() => undefined);
				}
			}
		});
	}

	/** Best-effort done-proof lookup for a feature — feeds the task-pipeline artifacts rail (Wave 4
	 *  X2's "cheaply derivable" done-proof surfacing). Tries each linked Plane issue identifier first
	 *  (the most specific key a proof can be filed under), then each worktree's branch. Read-only and
	 *  purely advisory: this never gates anything, mirroring done-proof.ts's own ledger contract. */
	async doneProofForFeature(featureId: string, repo?: string): Promise<DoneProof | undefined> {
		const list = await this.features(repo);
		const feature = list.find((f) => f.id === featureId);
		if (!feature) return undefined;
		for (const identifier of feature.issueIdentifiers ?? []) {
			const proof = getDoneProofByIssue(this.stateDir, identifier);
			if (proof) return proof;
		}
		for (const wt of feature.worktrees ?? []) {
			if (!wt.branch) continue;
			const proof = getDoneProofByBranch(this.stateDir, wt.branch);
			if (proof) return proof;
		}
		return undefined;
	}

	/** Saved cold-start resume digest for an agent ("" if none yet). */
	async getDigest(id: string): Promise<string> {
		return readDigest(this.stateDir, id);
	}

	/** Persist a pasted/dropped/captured/annotated chat image (Feature 2 D2) into THIS manager's
	 *  own `stateDir` — org-scoped for free, since callers only ever reach a manager already
	 *  resolved for their org (see server.ts's `managerFor(actor)`). Throws a short message on an
	 *  invalid/oversized/non-PNG payload; never writes a byte in that case. */
	async saveChatAttachment(dataUrl: string): Promise<SavedChatAttachment> {
		return writeChatAttachment(this.stateDir, dataUrl);
	}

	/** Read a previously-saved chat attachment back (org-scoped the same way). `undefined` if the
	 *  id is malformed or no such attachment exists in this manager's stateDir. */
	async getChatAttachment(id: string): Promise<Buffer | undefined> {
		return readChatAttachment(this.stateDir, id);
	}

	/** Route an extension UI request to a pending entry (and opt-in auto-answer). Protected so a test can drive it. */
	protected onUi(rec: AgentRecord, req: RpcExtensionUIRequest): void {
		let added: PendingRequest | undefined;
		if (req.method === "cancel") {
			this.setPending(rec, rec.dto.pending.filter((p) => p.id !== req.targetId), "pending-cancel");
			if (req.targetId) this.append(rec, "system", "input request cancelled", { pending: { requestId: req.targetId, action: "cancelled" }, status: "cancelled" });
		} else if (req.method === "notify") {
			// Un-black-hole the harness notify (cmux-research concern 03): previously a transcript-only
			// append with no way to surface it — now also a real attention row for non-omp harnesses
			// (which have no host-tool channel, so squad_attention is unreachable for them).
			this.append(rec, "system", `(${req.notifyType ?? "info"}) ${req.message}`);
			const event: AttentionEvent = { id: randomUUID(), summary: req.message, detail: undefined, source: "harness", createdAt: Date.now() };
			rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
			// emitAgent fires unconditionally at the end of this method (below) — no extra broadcast needed here.
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
				// The DRIVER's own claim wins. A prefix on an id (`gate_`) or a title (`GATE:`) is omp's
				// naming convention, and it was the whole classifier — so an ACP harness's
				// `session/request_permission` (id `acpui_<n>`, title from the tool call) matched neither and
				// was handed to the auto-supervisor's model, whose prompt says "when in doubt … approve."
				// A driver that knows it is relaying an approval gate says so; the conventions remain as the
				// fallback for harnesses that don't. (R7)
				gateClass: gateClassOf(req),
				// Tag pendings rebuilt from the agent-host's ring replay during the post-reattach settle window
				// (concern 04's ghost-expiry rules key off this — never gates answerability, only staleness).
				replayed: this.settling.has(rec.dto.id) ? true : undefined,
			};
			this.setPending(rec, [...rec.dto.pending.filter((p) => p.id !== req.id), added], "pending-add");
			this.append(rec, "system", `⛔ needs input: ${added.title}`, { pending: { requestId: added.id, action: "created" }, status: "running" });
		}
		// Idempotent when a branch above already ran setPending (derive() is deterministic and pure over
		// rec's current fields, so this early-returns as a same-state no-op) — only the "notify" branch,
		// which never touches pending, relies on this as its sole status recompute.
		this.transition(rec, this.derive(rec), "turn-progress");
		rec.dto.lastActivity = Date.now();
		this.emitAgent(rec);
		if (added) this.maybeAutoSupervise(rec, added); // opt-in bounded auto-answer (registers the request first, above)
	}

	/** Advertise the reserved squad host tools to an omp-backed agent once it's ready (and on each
	 *  reconnect/respawn, since omp loses them). Best-effort — never throws into the ready path. */
	private registerHostTools(rec: AgentRecord): void {
		// Capability gate (not a `runtime === "acp"` string check): skip advertisement for any harness whose
		// runtime has no host-tool channel (ACP harnesses, pi). Resolve from the record's own harness field,
		// falling back to the persisted options (so a rec built off any path is gated authoritatively). An
		// absent descriptor (workflow/flue kinds) keeps today's behavior — host tools advertised.
		const caps = (rec.harness ?? this.harnessFor(rec.options))?.capabilities;
		if (caps && !caps.hostTools) return;
		// Decision capture is flag-gated (default off): advertise squad_record_decision only when on,
		// so a fresh agent's tool list matches what onHostTool will actually dispatch.
		const tools = isOn(learningFlags(rec.dto.id).decisionCapture) ? [...SQUAD_HOST_TOOLS, RECORD_DECISION_TOOL_DEF] : SQUAD_HOST_TOOLS;
		try {
			rec.agent.setHostTools?.(tools);
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
		if (call.toolName === REPORT_TOOL) {
			void this.handleReportTool(rec, call);
			return;
		}
		if (call.toolName === RECORD_DECISION_TOOL) {
			// Gate dispatch on the SAME flag that gates advertisement (registerHostTools) — so turning the
			// flag off actually disables the feature (and keeps the "off" A/B arm clean) rather than only
			// hiding the tool while a carried-over / resumed / guessed call still writes decisions.
			if (isOn(learningFlags(rec.dto.id).decisionCapture)) {
				void this.handleRecordDecisionTool(rec, call);
			} else {
				rec.agent.respondHostTool(call.id, "decision capture is disabled", true);
			}
			return;
		}
		if (call.toolName === ATTENTION_TOOL) {
			void this.handleAttentionTool(rec, call);
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
			// Tag pendings rebuilt from the agent-host's ring replay during the post-reattach settle window
			// (concern 04's ghost-expiry rules key off this — never gates answerability, only staleness).
			replayed: this.settling.has(rec.dto.id) ? true : undefined,
		};
		this.setPending(rec, [...rec.dto.pending.filter((p) => p.id !== call.id), pending], "pending-add");
		this.append(rec, "system", `⛔ tool call needs host: ${call.toolName}`, { pending: { requestId: pending.id, action: "created" }, status: "running", tool: { callId: call.id, name: call.toolName, args: call.arguments, argsText: safeJson(call.arguments) } });
		this.transition(rec, this.derive(rec), "turn-progress"); // idempotent — setPending already derived/recorded above
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

	/**
	 * squad_report (Epic 5 HITL safeguards, DESIGN.md D2): "I'm unsure — here's a proposal" WITHOUT
	 * stopping. Modeled on `handlePeerMessageTool` above, NOT on the blocking `onHostTool` pending
	 * path — it responds to the agent immediately (the agent keeps running) and appends to the
	 * separate, non-blocking `AgentDTO.reports` channel. Never calls `setPending`: that would flip
	 * status to "input" and cap authority to observe, the exact opposite of this primitive's purpose.
	 */
	private async handleReportTool(rec: AgentRecord, call: { id: string; arguments: unknown }): Promise<void> {
		const args = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
		const summary = typeof args.summary === "string" ? args.summary.trim() : "";
		if (!summary) {
			rec.agent.respondHostTool(call.id, `usage: ${REPORT_TOOL}({ summary: string, proposal?: string, confidence?: number })`, true);
			return;
		}
		const proposal = typeof args.proposal === "string" ? args.proposal : undefined;
		const confidence = typeof args.confidence === "number" && Number.isFinite(args.confidence) ? Math.max(0, Math.min(1, args.confidence)) : undefined;
		const report: AgentReport = { id: randomUUID(), summary, proposal, confidence, createdAt: Date.now() };
		rec.dto.reports = [...(rec.dto.reports ?? []), report];
		this.append(rec, "system", `📝 report: ${truncate(summary, 200)}`, { status: "ok", tool: { callId: call.id, name: REPORT_TOOL, args: call.arguments, argsText: safeJson(call.arguments) } });
		rec.agent.respondHostTool(call.id, "report recorded — continue working, a human will review it when they can");
		void this.recordAudit(agentActor(rec.dto.id), "report.raised", rec.dto.id, "ok", truncate(summary, 120));
		this.emitAgent(rec);
	}

	/**
	 * squad_record_decision (research-tencentdb-agent-memory): capture a consequential decision into the
	 * agent's feature as a source:"agent" FeatureDecision, so it surfaces in the cold-start primer /
	 * squad_kb_search for future agents. NON-blocking like handleReportTool — responds immediately,
	 * never setPending. Best-effort: any failure is reported to the agent + warn-logged, never thrown.
	 * Idempotent: a normalized-text match against the feature's existing decisions is a no-op.
	 */
	private async handleRecordDecisionTool(rec: AgentRecord, call: { id: string; arguments: unknown }): Promise<void> {
		try {
			const args = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
			const text = typeof args.text === "string" ? args.text.trim() : "";
			if (!text) {
				rec.agent.respondHostTool(call.id, `usage: ${RECORD_DECISION_TOOL}({ text: string })`, true);
				return;
			}
			const featureId = rec.dto.featureId;
			if (!featureId) {
				rec.agent.respondHostTool(call.id, "no feature is attached to this agent, so the decision was not recorded", true);
				return;
			}
			const decision: FeatureDecision = {
				id: randomUUID(),
				text,
				source: "agent",
				createdAt: Date.now(),
				sourceRef: { agentId: rec.dto.id, runId: rec.run?.snapshot().runId },
			};
			// Atomic, adopt-aware append (resolves plan-derived features + can't clobber a concurrent capture).
			const outcome = await this.recordAgentDecision(featureId, decision, rec.dto.repo);
			if (outcome === "no-feature") {
				rec.agent.respondHostTool(call.id, "no feature is attached to this agent, so the decision was not recorded", true);
				return;
			}
			if (outcome === "duplicate") {
				rec.agent.respondHostTool(call.id, "decision already recorded — no change");
				return;
			}
			// Durably written. Respond success FIRST so a throw in the cosmetic post-steps below can never
			// flip an already-persisted decision to a "failed" reply (which would make the agent retry).
			this.learningMetrics.record("decision-captured", 1, { flag: "decision-capture", variant: learningFlags(rec.dto.id).decisionCapture });
			rec.agent.respondHostTool(call.id, "decision recorded — future agents on this work will inherit it");
			try {
				this.append(rec, "system", `📝 decision recorded: ${truncate(text, 200)}`, { status: "ok", tool: { callId: call.id, name: RECORD_DECISION_TOOL, args: call.arguments, argsText: safeJson(call.arguments) } });
				void this.recordAudit(agentActor(rec.dto.id), "decision.recorded", featureId, "ok", truncate(text, 120));
			} catch (postErr) {
				this.log("warn", `record-decision post-step failed for ${rec.dto.name} (decision was saved): ${String(postErr)}`);
			}
		} catch (err) {
			try {
				rec.agent.respondHostTool(call.id, `failed to record decision: ${String(err)}`, true);
			} catch {
				/* respond best-effort */
			}
			this.log("warn", `record-decision failed for ${rec.dto.name}: ${String(err)}`);
		}
	}

	/**
	 * squad_attention (cmux-research concern 03, harness-agnostic `glance notify`): "I need a human to
	 * look at this" WITHOUT stopping. Modeled on `handleReportTool` above, NOT the blocking `onHostTool`
	 * pending path — it responds to the agent immediately (the agent keeps running) and appends to the
	 * separate, non-blocking `AgentDTO.attentionEvents` channel. Never calls `setPending`.
	 */
	private async handleAttentionTool(rec: AgentRecord, call: { id: string; arguments: unknown }): Promise<void> {
		const args = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
		const summary = typeof args.summary === "string" ? args.summary.trim() : "";
		if (!summary) {
			rec.agent.respondHostTool(call.id, `usage: ${ATTENTION_TOOL}({ summary: string, detail?: string })`, true);
			return;
		}
		const detail = typeof args.detail === "string" ? args.detail : undefined;
		const event: AttentionEvent = { id: randomUUID(), summary, detail, source: "tool", createdAt: Date.now() };
		rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
		this.append(rec, "system", `🔔 attention: ${truncate(summary, 200)}`, { status: "ok", tool: { callId: call.id, name: ATTENTION_TOOL, args: call.arguments, argsText: safeJson(call.arguments) } });
		rec.agent.respondHostTool(call.id, "attention recorded — continue working, a human will look when they can");
		void this.recordAudit(agentActor(rec.dto.id), "attention.raised", rec.dto.id, "ok", truncate(summary, 120));
		this.emitAgent(rec);
	}

	private derive(rec: AgentRecord): AgentStatus {
		return deriveStatus({ status: rec.dto.status, pendingCount: rec.dto.pending.length, streaming: rec.streaming });
	}

	/**
	 * The single guarded write-path for AgentStatus (#lifecycle-truth). Every `rec.dto.status =`
	 * assignment elsewhere in this file is a bug (enforced by tests/lifecycle-enforcement.test.ts) —
	 * two whitelisted DTO-literal construction sites (attachExisting, restoreFlueMember) are the only
	 * exceptions, since there is no prior state to transition *from* at construction time.
	 *
	 * Recording semantics: a same-state call with a DERIVED reason is a hot-path no-op (turn-progress
	 * fires per RPC frame) — no record. A same-state call with an EXPLICIT/event reason (a second
	 * question while already "input", a repeat catastrophe with new detail) DOES record — that is this
	 * slice's headline deliverable, not an edge case to optimize away. A denied distinct-state attempt
	 * is spooled with `denied:true` plus a warn log — canTransition is permissive enough that this path
	 * is unreached today; it is kept as a bug detector, never a silent bug hider.
	 */
	private transition(rec: AgentRecord, to: AgentStatus, reason: TransitionReason, cause?: TransitionCause): void {
		const from = rec.dto.status;
		// Redacted once here (concern 02) — not just at the persisted-entry boundary in recordTransition/
		// recordDenied — because `cause.error` is also assigned straight onto `rec.dto.error` below, and
		// dto.error rides the emitted `agent` SquadEvent verbatim. DESIGN.md's redaction decision names
		// transition() itself as one of the three chokepoints (transition()/setPending()/persistNow()).
		const redactedCause = cause ? redactCause(cause) : undefined;
		if (from === to) {
			// Only "turn-progress" is the genuinely hot-path reason (fires per RPC frame, including every
			// streaming text delta) — it alone is a silent same-state no-op. `isDerivedReason()` is deliberately
			// NOT used here: it also covers pending-add/pending-answer/pending-cancel, which classify as
			// "derived" for terminal-state STICKINESS (canTransition, below) but are event-class for RECORDING
			// purposes — a second question while already "input", or a repeat orphan-close, DOES record (the
			// concern's own headline deliverable; DESIGN.md: "spool growth comes solely from turn-progress, so
			// exempting event-class reasons costs nothing"). Concern 04 (durable-pending's closeOrphanedPending,
			// which always calls transition() same-state by construction — it's an orphan-close note, not a
			// status change) is the first caller that actually depends on this distinction being correct.
			if (reason === "turn-progress") return;
		} else if (!canTransition(from, to, reason)) {
			this.recordDenied(rec, from, to, reason, redactedCause);
			this.log("warn", `denied transition ${rec.dto.name}: ${from} -> ${to} (${reason})`);
			return;
		}
		if (this.reattached.has(rec.dto.id) && this.settling.has(rec.dto.id)) {
			rec.dto.status = to; // still apply the state change — only recording is suppressed during settle
			if (redactedCause?.error !== undefined) rec.dto.error = redactedCause.error;
			return;
		}
		rec.dto.status = to;
		if (redactedCause?.error !== undefined) rec.dto.error = redactedCause.error; // fixes fail/markCatastrophe push-payload ordering (S6)
		this.recordTransition(rec, from, to, reason, redactedCause);
	}

	/** Mirrors transition() for `rec.dto.pending`. `opts.callerOwnsStatus` is for sites that manage status
	 *  themselves (restart clears pending AND sets "starting" via its own separate transition() call —
	 *  suppressing setPending's own derive+record here means restart's ledger gets exactly ONE "restart"
	 *  entry instead of a spurious intermediate "pending-cancel" derived entry ahead of it). Absent
	 *  `opts.callerOwnsStatus`, the resulting status is (re)derived and recorded under `reason` —
	 *  same-state early-return behavior is identical to a direct transition() call.
	 *
	 *  Redacts `title`/`message` on every entry before it lands on `rec.dto.pending` — today those fields
	 *  ride straight into state (and the emitted `agent` event) verbatim, which is the one gap append()'s
	 *  redaction chokepoint doesn't already cover (#lifecycle-truth concern 02). */
	private setPending(rec: AgentRecord, next: PendingRequest[], reason: DerivedReason, cause?: TransitionCause, opts?: { callerOwnsStatus?: boolean }): void {
		rec.dto.pending = next.map((p) => ({ ...p, title: redact(p.title), message: p.message === undefined ? undefined : redact(p.message) }));
		// Debounced persist trigger (concern 04) — scheduled regardless of the callerOwnsStatus branch
		// below, since `pending` already changed above either way. Suppressed during the replay settle
		// window: a ghost pending rebuilt by ring replay must never resurrect a stale question on disk.
		if (!this.settling.has(rec.dto.id)) this.schedulePendingPersist(rec.dto.id);
		if (opts?.callerOwnsStatus) return; // caller issues its own explicit transition() for the status change
		this.transition(rec, this.derive(rec), reason, cause);
	}

	/** Append a recorded (non-denied) transition to the persisted ring (stateDir/transitions.jsonl).
	 *  `cause` arrives already redacted (transition() redacts once, up front — see its comment). `seq` is
	 *  a uuid, not a per-process counter (#lifecycle-truth finding 7) — a counter would collide across a
	 *  restart boundary, exactly where dedupeTransitions's file/ring merge needs identity to be trustworthy. */
	private recordTransition(rec: AgentRecord, from: AgentStatus, to: AgentStatus, reason: TransitionReason, cause?: TransitionCause): void {
		const entry: TransitionEntry = { agentId: rec.dto.id, from, to, reason, at: Date.now(), cause, seq: randomUUID() };
		this.transitionLog.append(entry);
		this.recordErrorTransition(rec, entry); // finding 9's per-agent (not fleet-shared-ring) error tally
		this.pushTransitionEvent(rec, entry); // concern 03 wires DTO tail + rollup off this same call
		this.emit("event", { type: "transition", entry } satisfies SquadEvent);
	}

	/** Append a denied-transition attempt to the same ring, flagged so it is never confused with an
	 *  applied transition. Does not feed pushTransitionEvent — a denied attempt never changed dto.status. */
	private recordDenied(rec: AgentRecord, from: AgentStatus, to: AgentStatus, reason: TransitionReason, cause?: TransitionCause): void {
		const entry: TransitionEntry = { agentId: rec.dto.id, from, to, reason, at: Date.now(), cause, denied: true, seq: randomUUID() };
		this.transitionLog.append(entry);
		this.emit("event", { type: "transition", entry } satisfies SquadEvent);
	}

	/** Wires the DTO's capped `transitions` tail + the `errorTransitions1h` rollup off every recorded
	 *  (non-denied) transition. `turn-progress` entries never join the tail (hot-path noise); the rollup
	 *  is always recomputed from THIS agent's own bounded error-timestamp array (never the fleet-shared
	 *  ring — finding 9) so it never undercounts a busy/flapping agent. Both fields ride the next
	 *  `emitAgent()` the calling site already performs — no extra broadcast here. */
	private pushTransitionEvent(rec: AgentRecord, entry: TransitionEntry): void {
		if (entry.reason !== "turn-progress") {
			const tail = [...(rec.dto.transitions ?? []), entry];
			rec.dto.transitions = tail.length > 5 ? tail.slice(-5) : tail;
		}
		rec.dto.errorTransitions1h = this.countErrorTransitions1h(rec);
	}

	/** Append an error-class transition's timestamp onto THIS agent's own bounded array (#lifecycle-truth
	 *  finding 9) — the source countErrorTransitions1h now scans, replacing the fleet-shared 500-entry
	 *  transitionLog ring a busy fleet could evict this agent's own entries out of before the 1h window
	 *  elapses (the exact undercount the DTO field's doc promised never happens). */
	private recordErrorTransition(rec: AgentRecord, entry: TransitionEntry): void {
		if (entry.to !== "error" || (entry.reason !== "fail" && entry.reason !== "catastrophe" && entry.reason !== "exit-error")) return;
		rec.errorTransitionTimestamps = [...(rec.errorTransitionTimestamps ?? []), entry.at];
	}

	/** Linear scan + trim over THIS agent's own (small, unbounded-by-other-agents) error-timestamp array
	 *  — never the fleet-shared transitionLog ring (#lifecycle-truth finding 9: that ring is capped at
	 *  500 entries TOTAL across every agent, so a busy fleet can evict the very error entries being
	 *  counted for a quiet-but-flapping agent, contradicting this field's "never undercounts" doc). The
	 *  trim (not just the count) is what makes the rollup DECAY once an agent stops transitioning
	 *  (finding 8) — applyState's poll path calls this too, for agents with a nonzero count, so the
	 *  number ages out even without a fresh transition to trigger the recompute. */
	private countErrorTransitions1h(rec: AgentRecord): number {
		const cutoff = Date.now() - 3_600_000;
		const kept = (rec.errorTransitionTimestamps ?? []).filter((t) => t >= cutoff);
		rec.errorTransitionTimestamps = kept;
		return kept.length;
	}

	/** A blocking UI request suspends the agent's turn — so a turn that completed (agent_end fired) proves
	 *  no live request is actually open. Any pending still tagged replayed:true is a ghost from the ring
	 *  replay resurrecting an already-answered (pre-crash) question. Expire it, never silently. Idempotent
	 *  (no-op when there are no replayed:true entries) — safe to call from both expiry rules (concern 04). */
	private expireReplayedPending(rec: AgentRecord): void {
		const ghosts = rec.dto.pending.filter((p) => p.replayed);
		if (!ghosts.length) return;
		this.setPending(rec, rec.dto.pending.filter((p) => !p.replayed), "pending-cancel");
		for (const g of ghosts) this.append(rec, "system", `⛔ stale question expired (answered before restart): ${redact(g.title)}`, { pending: { requestId: g.id, action: "cancelled" } });
	}

	/** Full history for one agent: ring-served by default (fast, no file I/O); `full:true` additionally
	 *  reads transitions.jsonl and follows `cause.priorId` lineage (bounded hops) to stitch a crash-spanning
	 *  timeline for an agent that was cold-adopted under a fresh id (concern 04 populates priorId on adopt).
	 *
	 *  Deviation from the plan's literal snippet: the merge-then-lineage set is NOT pre-filtered to `id`
	 *  before calling followLineage — a prior id's entries live under a DIFFERENT agentId, so filtering to
	 *  `id` first would discard exactly the ancestor rows lineage-following needs. followLineage does its
	 *  own id-scoped filtering internally (see agent-lifecycle.ts) over the full ring∪file entry set. */
	async transitionHistory(id: string, opts: { full?: boolean } = {}): Promise<TransitionEntry[]> {
		const own = this.transitionLog.recent().filter((e) => e.agentId === id);
		if (!opts.full) return own; // ring-served, no file I/O — the default, fast path
		const fromFile = await this.transitionLog.hydrateAll();
		const merged = dedupeTransitions([...fromFile, ...this.transitionLog.recent()]);
		return followLineage(id, merged);
	}

	/** One tick so in-flight agent-host ring-replay frames (synchronous `.emit()` calls inside a
	 *  driver's `start()`) land before the settle gate closes. A microtask alone is not enough — replay
	 *  frames can be scheduled via setImmediate/setTimeout(0) inside the driver — so this parks behind
	 *  one macrotask boundary. Kept as a cheap floor UNDER the real fix below (armReplayCompleteWaiter) —
	 *  harmless for drivers that never emit a marker at all (fake test doubles), and for the
	 *  single-socket-read production case it guarantees the burst is fully applied even before the
	 *  marker-or-timeout race is even set up. */
	private drainOneTick(): Promise<void> {
		return new Promise((resolve) => setImmediate(resolve));
	}

	/** Concern 2's real settle-point fix: the agent-host replays its ring across however many socket
	 *  reads it takes (up to 4000 lines), NOT within one tick — a bare setImmediate (drainOneTick) is a
	 *  heuristic that can close the settle gate while frames are still straggling in. The host writes an
	 *  explicit `{__sq:"replay_complete"}` marker LAST, after every ring line, so a client always
	 *  processes it after everything that preceded it, however many ticks the delivery spanned (UDS/TCP
	 *  preserve stream order). Must be armed BEFORE `agent.start()` is called (see the
	 *  replayCompleteWaiters field comment) — a host that delivers its whole reply in the first socket
	 *  read can emit the marker synchronously inside start()'s own await chain.
	 *
	 *  Falls back to `this.replaySettleTimeoutMs` (default 2000ms) so an OLD agent-host process — spawned
	 *  before this fix shipped, surviving a daemon upgrade — that never sends the marker still settles
	 *  eventually instead of wedging maybeAutoSupervise and the ledger for that agent forever. Returns a
	 *  `cancel()` so a caller whose `agent.start()` itself rejected can tear the waiter (and its timer)
	 *  down immediately instead of leaving it to expire on its own. */
	private armReplayCompleteWaiter(id: string): { promise: Promise<void>; cancel: () => void } {
		let finish: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			let done = false;
			const timer = setTimeout(() => {
				finish();
			}, this.replaySettleTimeoutMs);
			finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.replayCompleteWaiters.delete(id);
				resolve();
			};
			this.replayCompleteWaiters.set(id, finish);
		});
		return { promise, cancel: () => finish() };
	}

	private fail(rec: AgentRecord, err: unknown): void {
		this.transition(rec, "error", "fail", { error: err instanceof Error ? err.message : String(err) });
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

	/** Bonus hygiene for chat image attachments (security review MEDIUM 1 follow-up): age-based TTL
	 *  sweep of this org's own `chat-attachments/` dir, on the same janitor cadence as
	 *  `reapDeadWorktrees` (every ~12th poll tick, per-org — not gated by `skipGlobalJanitors` since
	 *  each manager only ever sweeps its own `stateDir`). The hard ceiling is
	 *  `writeChatAttachment`'s write-time quota check, which holds regardless of this sweep. */
	private async reapStaleChatAttachmentsTick(): Promise<void> {
		const reaped = await reapStaleChatAttachments(this.stateDir).catch(() => [] as string[]);
		if (reaped.length) this.log("info", `reaped ${reaped.length} stale chat attachment(s)`);
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
			void this.reapStaleChatAttachmentsTick();
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
	 *  unique worktree mints a fresh key, so without this they accumulate one folder per agent forever.
	 *  Also runs the pid-liveness lease backstop (reapDeadSessions): `releaseAgentLeases` covers the
	 *  explicit `remove()` path, but a hard kill / crash / orphan-host reap never runs that call site, so
	 *  this catches those the same way sweepLeases() catches plain heartbeat staleness. */
	private async sweepRegistries(): Promise<void> {
		try {
			const [l, dead, p, pr, gl] = await Promise.all([sweepLeases(), reapDeadSessions(), sweepPresence(), sweepProofs(), sweepGateLogs()]);
			if (l + dead + p + pr + gl > 0) this.log("info", `swept stale registry dirs — ${l} leases, ${dead} dead-pid leases, ${p} presence, ${pr} proofs, ${gl} gate-logs`);
		} catch {
			/* best-effort cleanup */
		}
	}

	/** Free disk + git admin entries for squad worktrees whose agent is gone and whose work is safely in
	 *  the base branch or whose Plane issue is closed — repeated re-dispatch otherwise leaks one worktree
	 *  per attempt. Lossless (abandoned WIP committed to its branch; only merged+clean branches deleted)
	 *  and never touches a live agent's worktree or one created within the spawn grace. Opt out with
	 *  OMP_SQUAD_WORKTREE_REAP=0; tune the freshness window with OMP_SQUAD_WORKTREE_GRACE_MS. */
	protected async reapDeadWorktrees(): Promise<void> {
		if (process.env.OMP_SQUAD_WORKTREE_REAP === "0") return;
		const graceMs = envInt("OMP_SQUAD_WORKTREE_GRACE_MS", 120_000);
		const owned = new Set([...this.agents.values()].map((r) => r.options.worktree).filter((w): w is string => !!w));
		const repos = new Set<string>([...planeRepos(), ...[...this.agents.values()].map((r) => r.options.repo)]);
		for (const repo of repos) {
			if (!repo || repo.startsWith("(")) continue; // synthetic / no-repo agents have no worktrees to reap
			try {
				const root = await repoRoot(repo);
				const wts = await listWorktrees(root);
				const infos: WorktreeInfo[] = await Promise.all(
					wts.map(async (w) => {
						const stat = await fs.stat(w.worktree).catch(() => undefined);
						// DoneProof consulted FIRST: a proven-landed branch is reap-eligible regardless of
						// what the ahead-count reports (squash/rebase merges make it permanently nonzero) —
						// but only while the proof still covers the branch's CURRENT tip (`proofCoversTip`),
						// so a follow-up commit pushed after the proof was recorded is never reaped as if it
						// were landed too.
						const doneProof = !w.isPrimary && w.branch ? getDoneProofByBranch(this.stateDir, w.branch) : undefined;
						const proven = !!doneProof && w.branch !== undefined && (await proofCoversTip(doneProof, w.branch, root));
						// The -1 "unknown" sentinel flows straight into WorktreeInfo.aheadOfBase unmapped, by
						// design: selectReapable's `merged` test is `w.aheadOfBase === 0`, an EXACT-equality
						// check, so -1 (or any other nonzero) already falls into "not merged" without any
						// special-casing here — the fail-safe direction this consumer needs (never reap a
						// worktree we couldn't verify is landed). Do not change this to `> 0`/`< 0`.
						return {
							worktree: w.worktree,
							branch: w.branch ?? "",
							isPrimary: w.isPrimary,
							aheadOfBase: w.isPrimary || !w.branch ? 0 : await this.computeAheadOfBaseFor({ repo: root, branch: w.branch, cwd: root }),
							proven,
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
			if (rec.dto.status !== "stopped" && rec.dto.status !== "error") this.transition(rec, this.derive(rec), "turn-progress");
		} else {
			// Poll-based ghost-expiry fallback (concern 04) — gated behind OMP_SQUAD_PENDING_GHOST_EXPIRY
			// (default OFF, #lifecycle-truth finding 6). Rationale for gating: this rule shipped without
			// its design-mandated live acceptance test (a real omp blocked on a genuinely-open confirm
			// across a daemon restart), and the assumption it rests on — `isStreaming` reads false only
			// when NOT suspended on a blocking UI request — is plausible but unverified; a host waiting on
			// a blocking confirm is, definitionally, not streaming either. The DETERMINISTIC replay-tag
			// expiry (the agent_end / live-turn-boundary rule, `expireReplayedPending` above) stays ALWAYS
			// on — it only fires once a live turn has genuinely completed, which is proof, not a heuristic.
			if (pendingGhostExpiryEnabled()) {
				// An agent that was already idle pre-crash with a stale replayed ghost, and never gets
				// prompted again, would otherwise wedge here forever even with the live rule enabled — two
				// consecutive isStreaming===false polls is the signal RpcSessionState gives us that nothing
				// is in flight; piggybacks the same poll cadence the pending-queue guard above already gates
				// rec.streaming on.
				if (!state.isStreaming) {
					rec.nonStreamingPolls = (rec.nonStreamingPolls ?? 0) + 1;
					if (rec.nonStreamingPolls >= 2) this.expireReplayedPending(rec);
				} else {
					rec.nonStreamingPolls = 0;
				}
			}
		}
		// errorTransitions1h decay (#lifecycle-truth finding 8): without this, a dead errored agent that
		// never transitions again keeps a stale nonzero count forever (a standing false "flapping" alarm
		// in insights.ts) — countErrorTransitions1h's own trim only ever ran from the transition() path.
		// Recomputing here, on every poll tick, for agents that currently show a nonzero count, ages the
		// rollup out over time even with no new transitions.
		if ((rec.dto.errorTransitions1h ?? 0) > 0) rec.dto.errorTransitions1h = this.countErrorTransitions1h(rec);
		this.emitAgent(rec);
	}

	// ── Transcript + emission ─────────────────────────────────────────────────

	private append(rec: AgentRecord, kind: TranscriptKind, text: string, patch: Partial<TranscriptEntry> = {}): TranscriptEntry {
		// ponytail: append() is the single transcript chokepoint — redact here so secrets reach
		// neither the in-memory buffer, persisted state.json, nor the emitted transcript event.
		// Receipt fields carry paths/tallies (not free text), so they need no separate redaction.
		const seq = ++this.transcriptSeq;
		const entry: TranscriptEntry = {
			...patch,
			id: patch.id ?? `${rec.dto.id}:${seq}`,
			seq,
			kind,
			text: redact(text),
			// displayText is free text too (the user's bare typed prompt) — redact it at the same
			// chokepoint so a secret can't leak through the "clean" rendered copy.
			displayText: patch.displayText !== undefined ? redact(patch.displayText) : undefined,
			ts: Date.now(),
		};
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

	/** Completion-push disarm (voice-loop): called by the server, after its background push actually
	 *  sends, to consume the one-push-per-voice-dispatch latch. A no-op if the agent isn't resident (a
	 *  raced remove/eviction between the push firing and this call landing) or already disarmed. */
	clearVoicePushArmed(id: string): void {
		const rec = this.agents.get(id);
		if (!rec || rec.options.voicePushArmed !== true) return;
		rec.options.voicePushArmed = false;
		rec.dto.voicePushArmed = false;
		void this.persist();
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

	/**
	 * Live peer operator presence observed off the federation bus (SEAM 2). The server's
	 * `/api/federation` surface reads this instead of maintaining its own second coordinator
	 * socket. Stale peers are pruned; empty when there's no coordinator (or federation is off).
	 */
	peerPresence(now?: number): OperatorPresence[] {
		return this.peerRoster.live(now);
	}

	/**
	 * Gossip this operator's own live file leases once, now (SEAM 1). Also driven by an internal
	 * timer once started; exposed so a caller (or a test) can force an immediate publish. No-op
	 * (returns []) when federation is off (NullFederationBus) — the engine is never attached.
	 */
	async gossipLeasesNow(): Promise<string[]> {
		return (await this.leaseGossip?.publishNow().catch(() => [] as string[])) ?? [];
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private writeChain: Promise<void> = Promise.resolve();
	private queuedWrite?: Promise<void>;
	private writeInFlight = false;

	/** Per-agent debounce timers coalescing bursts of `pending[]` mutations (concern 04: durable pause)
	 *  into one full-roster persist ~1s after the last change, instead of a persist per mutation (which
	 *  would be too heavy — persistNow() serializes every agent's full transcript on every call). */
	private pendingPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/** Debounce a `pending[]`-mutation-triggered persist. A ≤1s crash window is documented best-effort —
	 *  strictly better than the pre-fix baseline of never persisting pending at all; a graceful stop()
	 *  flushes this timer synchronously so only an actual crash can lose the window. */
	private schedulePendingPersist(agentId: string): void {
		const existing = this.pendingPersistTimers.get(agentId);
		if (existing) clearTimeout(existing);
		this.pendingPersistTimers.set(
			agentId,
			setTimeout(() => {
				this.pendingPersistTimers.delete(agentId);
				void this.persist();
			}, 1000),
		);
	}

	/**
	 * Chain-deduped writer: a burst of N persist() calls produces at most 2 store.save() invocations (the
	 * in-flight one, plus one queued one that starts after it). Every caller's promise resolves only once a
	 * write that snapshots state AFTER their call has completed — persistNow() reads live agent state at
	 * write time, not at enqueue time, so the queued write durably contains every joiner's state. This keeps
	 * `await persist()` a real durability barrier (stop() depends on it) while collapsing the per-checkpoint
	 * chattiness a naive always-chain implementation has. Replaces a considered-and-rejected trailing-timer
	 * coalesce: a timer firing after stop()'s durability barrier could clobber a successor daemon's
	 * state.json (cross-process last-writer-wins race) — this introduces no post-stop() write path at all.
	 */
	private async persist(): Promise<void> {
		if (this.queuedWrite) return this.queuedWrite;
		if (!this.writeInFlight) {
			this.writeInFlight = true;
			const p = this.persistNow().finally(() => {
				this.writeInFlight = false;
			});
			this.writeChain = p.catch(() => {});
			return p;
		}
		const queued: Promise<void> = this.writeChain.then(() => {
			this.queuedWrite = undefined;
			this.writeInFlight = true;
			return this.persistNow().finally(() => {
				this.writeInFlight = false;
			});
		});
		this.queuedWrite = queued;
		this.writeChain = queued.catch(() => {});
		return queued;
	}

	/** Atomic write through the store: file mode → state.json temp+rename; DB mode → roster/feature tables + on-disk transcripts. */
	private async persistNow(): Promise<void> {
		// Fold in the live `pending[]` snapshot (concern 04: durable pause) — `r.options` alone is the
		// persisted-at-create() shape and never carries later pending mutations.
		//
		// Replayed-tagged (ghost-candidate) entries are EXCLUDED here regardless of settle-window timing
		// (#lifecycle-truth finding 5). setPending's settling-guard on schedulePendingPersist only stops a
		// NEW debounce timer from being armed while THIS agent is mid-settle — it does nothing about an
		// already-scheduled timer (armed before settling started) or an unrelated persist() call (a
		// different agent's own pending mutation, a capability install/audit write, stop()'s flush, …)
		// firing while THIS agent is mid-settle with a live replayed pending still sitting in dto.pending.
		// Filtering it out of every snapshot unconditionally is always safe: a replayed entry is either
		// answered normally (which clears it via setPending before persistNow ever sees it again) or
		// expired by one of the two ghost-expiry rules — it never needs to survive a crash, since a
		// subsequent reattach's ring replay resurrects it fresh with a live correlation id anyway (replay,
		// not the snapshot, is the source of truth on warm reattach — see DESIGN.md's warm-reattach
		// decision). The settling-guard above stays in place as a separate I/O-churn optimization; removing
		// it is a distinct (and not obviously behavior-identical) change, so it is left as-is here.
		const live = [...this.agents.values()].map((r) => ({ ...r.options, pending: r.dto.pending.filter((p) => !p.replayed) }));
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
		// Review finding 4: a branch child still in-flight for its workflow parent's current parallel node
		// must NOT be restored here under a fresh id. `create()` below mints a brand-new agent id but reuses
		// the OLD deterministic branch's `existingPath`/`branch` (the exact git worktree/branch the crashed
		// attempt used) — and moments after the parent is ALSO restored (further down this same loop) with
		// its checkpoint intact, its own resumed runParallel re-enters the SAME fan-out and re-spawns the
		// SAME deterministic branch id/worktree via spawnFleetBranch. Two roster agents would then race one
		// git worktree, and the fan-out collapses the instant createInternal's guard (or git itself) refuses.
		// The parent's own resumed runParallel is the sole source of truth for these slots (worktree reuse
		// rides the deterministic id either way) — skip restoring them here and let it re-spawn them fresh.
		// A branch already resolved (succeeded/failed) is NOT in this set (unresolvedBranchIds excludes it)
		// and restores normally, for display/audit (finding 1's same contract).
		const skipRestore = new Set<string>();
		for (const parent of list) {
			if (parent.kind !== "workflow") continue;
			for (const id of await this.unresolvedBranchIds(parent)) skipRestore.add(id);
		}
		// Count what we ACTUALLY restore. This used to `return list.length`, so the boot banner said
		// "restored 2 agent(s)" whether it restored two, skipped two as tombstoned, or (before the guard
		// above) minted two duplicates. A count that never disagrees with itself is not a count.
		let restoredCount = 0;
		for (const p of list) {
			// ALREADY RESIDENT ⇒ never re-create. `start()` runs first and `reconnectLive`/`adoptOrphanedAgents`
			// reattach persisted records VERBATIM, keyed by their original id (reconnectLive has this exact
			// guard). `--restore` then walked the same list and `create()`d each one under a FRESH id — so
			// every reattached record got a twin, and the twin was itself persisted, so the next
			// `up --restore` doubled again. Observed live on the operator's daemon: one `ompsq-445` became
			// two after one bounce and four after the next, each pair a terminal-marked workflow reattached
			// verbatim alongside a freshly-minted duplicate. The dispatcher was innocent — its ledger
			// correctly skips the issue; the roster was breeding at boot.
			if (this.agents.has(p.id)) {
				this.log("info", `skipped restoring ${p.name} (${p.id}) — already reattached by start()`);
				continue;
			}
			// rm-doesn't-stick fix (cross-lineage review MEDIUM 3): `--restore` was the one boot path that
			// bypassed the tombstone entirely, re-creating every persisted record — including explicitly
			// rm'd ones — under fresh ids. Same gate as reconnectLive/adoptOrphanedAgents.
			if (this.removedLedger.has(p.id)) {
				this.log("info", `skipped restoring ${p.name} (${p.id}) — explicitly removed (tombstoned)`);
				continue;
			}
			if (p.kind === "flue-service" && p.flue) {
				// Counted on SUCCESS only — a restore that threw is not a restore (grok-4.5).
				await this.restoreFlueMember(p)
					.then(() => {
						restoredCount++;
					})
					.catch((err) => this.log("error", `restore ${p.name} failed: ${String(err)}`));
				continue;
			}
			if (skipRestore.has(p.id)) {
				this.log("info", `skipped restoring branch child ${p.name} (${p.id}) — its parent's resumed fan-out will re-spawn it under the same deterministic id/worktree`);
				continue;
			}
			// Concern 07: a non-resumable harness (ACP — direct spawn, no detached host) can't be cold-restored
			// soundly; a fresh session would replace the dead one. Skip rather than respawn under the wrong state.
			if (!this.harnessResumable(p)) {
				this.log("info", `skipped restoring ${p.name} (${p.id}) — harness "${p.harness ?? p.runtime ?? "?"}" is not resumable across a restart`);
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
				// Restore the original system prompt (tool grants / profile memory / fabric primer) on both
				// fresh-id resume paths. It was dropped, so a resumed unit's child spawned with NO
				// --append-system-prompt and silently lost its capability scoping. For profiled units
				// createWithId re-prepends profile.memory+toolGrants (the persisted value is already-composed)
				// — cosmetic, idempotent content, no behavioral effect; non-profiled fleet units compose cleanly.
				appendSystemPrompt: p.appendSystemPrompt,
				issue: p.issue,
				parentId: p.parentId,
				...lineageFieldsFrom(p),
				// Restore the harness lineage so a cold-adopted/restored pi or ACP unit keeps its harness
				// instead of silently reverting to omp (audit finding — the warm path was already safe).
				...harnessFieldsFrom(p),
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
			})
				.then(async (dto) => {
					// SUCCESS only. `createWithId` catches a driver/handshake failure, marks the record `error`,
					// and RESOLVES with that DTO rather than rejecting (see its catch → settleSpawnFailure →
					// `return rec.dto`), so a bare `.then()` counted a unit that never came up. The boot banner
					// would print "restored 1 agent(s)" over a corpse. (grok-4.5 raised the attempts-vs-successes
					// gap; gpt-5.6-sol found the fulfilled-error path that makes `.catch` insufficient.)
					if (dto.status !== "error") restoredCount++;
					// Same fresh-id-fresh-correlation leak as adoptOrphanedAgents (this path also mints a new
					// agent id from a PersistedAgent) — close, never restore, any pending it carried (concern 04).
					// Unconditional, like adoptOrphanedAgents' call site — closeOrphanedPending unconditionally
					// stitches the cause.priorId lineage entry too (#lifecycle-truth finding 4).
					await this.closeOrphanedPending(dto.id, p);
					// Same prior-context surfacing as the adopt path (both mint a fresh id from a PersistedAgent).
					await this.surfaceResumeDigest(dto.id, p);
				})
				.catch((err) => this.log("error", `restore ${p.name} failed: ${String(err)}`));
		}
		return restoredCount;
	}
}

/** The cold-start context primer (R3). On by default: a unit that starts blind re-derives what the
 *  fabric already knows. `OMP_SQUAD_CONTEXT_PRIMER=0` turns it off. */
function contextPrimerEnabled(): boolean {
	return envBool("OMP_SQUAD_CONTEXT_PRIMER", true);
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

// Workflow graph sources (resolveWorkflowPath / capabilityWorkflowToDot / loadCommissionWorkflow)
// live in ./workflow-source.ts; the re-export keeps the public import path stable.
