/**
 * SquadServer — HTTP + WebSocket bridge over a SquadManager.
 *
 * Wire protocol (JSON):
 *   server → client : SquadEvent (plus a `roster` snapshot on connect)
 *   client → server : ClientCommand
 *
 * The web dashboard and any remote viewer are just WS clients. (Federation
 * peers are a separate transport — see federation.ts — not this local server.)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { Result } from "effect";
import type { ArtifactCommentDTO, ClientCommand, CreateAgentOptions, FeatureCategory, FeatureCriterion, FeatureDecision, FeatureDTO, FeatureRelationship, FeatureStage, IssueRef, PlanAnnotationTarget, PlanRevisionCandidateState, SquadEvent } from "./types.ts";
import { ChatAttachmentDimensionError, ChatAttachmentQuotaExceededError } from "./chat-attachment.ts";
import { envBool, envInt } from "./config.ts";
import { invalidFileAssignees, invalidOrgAssignees, isVoteAssignee } from "./feature-assignees.ts";
import { errText } from "./err-text.ts";
import { globalDefaultHarness, listHarnesses, listHarnessTiers } from "./harness-registry.ts";
import { decodeClientCommand } from "./schema/client-command.ts";
import {
	AgentLandBodySchema,
	AgentModeBodySchema,
	AgentVisionBodySchema,
	AnnotationCreateBodySchema,
	AnnotationSendBodySchema,
	AssigneesBodySchema,
	CapabilityInstallBodySchema,
	CapabilityInstallPatchBodySchema,
	CapabilityInstallRunBodySchema,
	CapabilitySourceBodySchema,
	ChatAttachmentCreateBodySchema,
	CommentsCreateBodySchema,
	ConsoleBodySchema,
	decodeBody,
	decodeBodyOrEmpty,
	FeatureAgentsLinkBodySchema,
	FeatureAnswersBodySchema,
	FeatureAutoBodySchema,
	FeatureConcernsPatchBodySchema,
	FeatureCreateBodySchema,
	FeatureFlagBodySchema,
	PolicyRulesBodySchema,
	FeatureFromPlanBodySchema,
	FeatureLandBodySchema,
	FeatureModuleBodySchema,
	FeatureModuleRepairBodySchema,
	FeaturePatchBodySchema,
	FederationCommandBodySchema,
	FeedbackItemsEnvelopeSchema,
	JoinRequestDecideBodySchema,
	OrgJoinPolicyBodySchema,
	OrgMemberInviteBodySchema,
	OrgMemberRoleBodySchema,
	OrgPatchBodySchema,
	PlanCandidateCreateBodySchema,
	PlanCandidateTransitionBodySchema,
	PlanVoteCallBodySchema,
	PlanVoteCastBodySchema,
	PushSubscriptionBodySchema,
	SpawnBodySchema,
	TaskStartBodySchema,
} from "./schema/http-body.ts";
import { worktreeDiffSinceFork, worktreeTree } from "./explore.ts";
import { appendConcernDecision, listPlanDirs, parsePlanConcerns, parsePlanDocuments } from "./features.ts";
import { isPlanDocPath, planDocDiffSince, planDocHeadRevision, readPlanDoc } from "./plan-doc.ts";
import { planVoteGateOpen, tallyPlanVoteRound } from "./plan-votes.ts";
import { hardenedGit } from "./git-harden.ts";
import { searchFabric, type KbDocType } from "./fabric-search.ts";
import type { FabricSnapshot } from "./fabric.ts";
import { readAudit, type AuditQuery } from "./audit.ts";
import type { AutomationEvent, AutomationLoop, AutomationQuery, AutomationRollupRow } from "./automation-log.ts";
import { learningFlags, type MetricName, type MetricRollupRow } from "./metrics.ts";
import { buildGraph, type GraphDoc } from "./omp-graph/index.ts";
import { buildAttribution, planFromEnv } from "./omp-graph/attribution.ts";
import { buildTaskClassMatrix, type TaskClassMatrixDoc } from "./omp-graph/task-class-matrix.ts";
import { buildProvenance, type ProvenanceDoc } from "./omp-graph/provenance.ts";
import { ingestHarnesses } from "./ingest/index.ts";
import { buildScoreboard, type Scoreboard } from "./attribution-scoreboard.ts";
import { readModelOutcomes } from "./model-outcomes.ts";
import { readTaskOutcomes } from "./task-outcomes.ts";
import { readAllReceipts } from "./receipts.ts";
import { fetchIssueDetail, listPlaneIssues, planeRepos } from "./plane.ts";
import { runVisionPass } from "./vision.ts";
import { checkVisionUrl } from "./ssrf.ts";
import { all, claim, release, who } from "./presence.ts";
import { type LeaseEntry, leasesFor } from "./leases.ts";
import { discoverRepos, planSpawn } from "./smart-spawn.ts";
import { hardAgentCeiling } from "./spawn-identity.ts";
import { liveAgents as liveAgentCount } from "./scheduler.ts";
import { assessHealth, defaultHealthLimits, type HealthSample } from "./watchdog.ts";
import { gitState, pullLatest, reexecDaemon } from "./upgrade.ts";
import type { SquadManager } from "./squad-manager.ts";
import type { ManagerRegistry } from "./manager-registry.ts";
import type { ComplianceFinding } from "./compliance.ts";
import { actorForRole, type AuthPolicy, RbacDenied, requestToken, requiredRole, resolveRole, roleAtLeast, tokenOk } from "./auth.ts";
import { handleFeedbackRoutes } from "./feedback-routes.ts";
import { configuredSocialProviders, signupOpen } from "./db/auth.ts";
import { getWorkosOrgPolicy, parseWorkosEvent, setWorkosOrgPolicy, ssoEnabled, verifyWorkosSignature } from "./workos.ts";

/** The agent id/name a `ClientCommand` mutates, if any — "create"/"snapshot"/"commission" name no
 *  agent (they don't need cross-manager resolution); "message" targets a peer by `to`, but that's
 *  scoped by `deliverPeerMessage`/RBAC within the caller's own manager, not agent ownership, so it's
 *  deliberately excluded here (unlike squad-manager's private `commandTarget`, which audits it). */
function commandAgentTarget(cmd: ClientCommand): string | undefined {
	return "id" in cmd ? cmd.id : undefined;
}

function requestScope(body: unknown): Pick<CreateAgentOptions, "requires" | "owns" | "produces" | "scopeSource"> {
	const out: Pick<CreateAgentOptions, "requires" | "owns" | "produces" | "scopeSource"> = {};
	if (!body || typeof body !== "object") return out;
	for (const key of ["requires", "owns", "produces"] as const) {
		const value = (body as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			const paths = value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
			if (paths.length) out[key] = paths;
		}
	}
	const source = (body as Record<string, unknown>).scopeSource;
	if (source === "operator" || source === "inferred") out.scopeSource = source;
	else if (out.requires || out.owns || out.produces) out.scopeSource = "operator";
	return out;
}
import { approveJoinRequest, denyJoinRequest, ensurePersonalWorkspace, listPendingJoinRequests, onboardWorkosUser, provisionScimEvent } from "./workos-provision.ts";
import { addMemberByEmail, getOrgProfile, listOrgMembers, removeMember, renameOrg, setMemberRole } from "./org-admin.ts";
import type { DbHandle } from "./db/index.ts";
import type { PushPayload, PushService } from "./push.ts";
import type { Actor, AgentDTO, AgentStatus, AuditEntry, OperatorPresence, Role, RunReceipt } from "./types.ts";
import type { TraceResponse } from "./spans.ts";
import { type FederationSnapshot, federationView } from "./federation.ts";
import { workflowSnapshot } from "./workflow-catalog.ts";
import { validateRequestedMode } from "./autonomy.ts";
import { resolveStateDir } from "./state-dir.ts";
import { featureFlagStates, isFeatureFlagKey, type RuntimeSettingsStore } from "./runtime-settings.ts";
import { parsePolicyDoc, type PolicyStore } from "./policy.ts";
import { publicCapabilityCatalog, publicCapabilityManifest } from "./capabilities/catalog.ts";
import type { CapabilityInstallState } from "./capabilities/index.ts";

const INDEX_HTML = path.join(import.meta.dir, "web", "index.html");
const WEB_DIR = path.join(import.meta.dir, "web");
const FEEDBACK_WIDGET = path.join(import.meta.dir, "web", "feedback-widget.js");
/** Vite SPA build output (CC-rewrite). Served only via the inert opt-in seam below. */
const WEBAPP_DIST = path.join(import.meta.dir, "..", "webapp", "dist");
const WEBAPP_INDEX = path.join(WEBAPP_DIST, "index.html");
const WEBAPP_ASSETS = path.join(WEBAPP_DIST, "assets");
const ASSET_TYPES: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise.catch(() => fallback),
		new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
	]);
}

export const CONSOLE_SYSTEM_PROMPT = `You are the omp-squad interactive console agent.

Default to chat, diagnosis, and concise guidance. Do not create features, issues, worktrees, workflows, files, commits, or other durable changes unless the user explicitly asks you to start/implement/change something. When the user asks a question, answer the question directly. When current feature context is included, use it as background, not as an instruction to mutate state. Keep replies terse and operator-focused.`;

/**
 * Inert opt-in serve seam for the Vite SPA rewrite. DEFAULT OFF: requires BOTH the explicit
 * `OMP_SQUAD_WEBAPP=1` flag AND an existing built `webapp/dist/index.html`. Until cutover the live
 * `src/web/index.html` is served unchanged. Exported for the build/serve gate test.
 * ponytail: env-flag + dist-exists check, not a config object — one toggle, no machinery.
 */
export function webappEnabled(): boolean {
	return envBool("OMP_SQUAD_WEBAPP", false) && existsSync(WEBAPP_INDEX);
}

export function feedbackEnabled(): boolean {
	return envBool("OMP_SQUAD_FEEDBACK", false);
}

/** Synthetic org id stamped on the on-box loopback bootstrap admin so managerFor routes it to the root
 *  factory in DB mode. The leading space cannot appear in a better-auth org id (nanoid), so it can never
 *  collide with a real tenant org. */
export const ROOT_FACTORY_ORG = " root-factory";
/** Files served without a token so the PWA can install + bootstrap before sign-in. */
const PUBLIC_ASSETS: Record<string, string> = {
	"/manifest.webmanifest": "application/manifest+json",
	"/sw.js": "text/javascript; charset=utf-8",
	"/icon.svg": "image/svg+xml",
	"/icon-192.png": "image/png",
	"/icon-512.png": "image/png",
	"/icon-maskable-512.png": "image/png",
};

export interface ModelOption {
	label: string;
	value: string;
}

export function modelOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
	const seen = new Set<string>();
	const models = (env.OMP_SQUAD_MODELS ?? "")
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((value) => {
			if (seen.has(value)) return false;
			seen.add(value);
			return true;
		});
	return [{ label: "omp default", value: "" }, ...models.map((value) => ({ label: value, value }))];
}

export function mergeModelOptions(...groups: ModelOption[][]): ModelOption[] {
	const seen = new Set<string>();
	return groups.flat().filter((option) => {
		const value = option.value || "__default__";
		if (seen.has(value)) return false;
		seen.add(value);
		return true;
	});
}
function capabilityInstallState(value: unknown): CapabilityInstallState | undefined {
	return value === "imported" || value === "validated" || value === "approved" || value === "enabled" || value === "disabled" || value === "failed" || value === "removed" ? value : undefined;
}

function featureCriteria(value: unknown): FeatureCriterion[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item): FeatureCriterion[] => {
		if (!item || typeof item !== "object") return [];
		const rec = item as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id : undefined;
		const text = typeof rec.text === "string" ? rec.text.trim() : "";
		if (!id || !text) return [];
		return [{ id, text, completed: rec.completed === true, source: rec.source === "plan" || rec.source === "ticket" || rec.source === "workflow" || rec.source === "manual" ? rec.source : "manual" }];
	});
}

function featureDecisions(value: unknown): FeatureDecision[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item): FeatureDecision[] => {
		if (!item || typeof item !== "object") return [];
		const rec = item as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id : undefined;
		const text = typeof rec.text === "string" ? rec.text.trim() : "";
		if (!id || !text) return [];
		return [{ id, text, source: rec.source === "plan" || rec.source === "human" || rec.source === "agent" ? rec.source : "human", createdAt: typeof rec.createdAt === "number" ? rec.createdAt : undefined }];
	});
}

function featureRelationships(value: unknown): FeatureRelationship[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item): FeatureRelationship[] => {
		if (!item || typeof item !== "object") return [];
		const rec = item as Record<string, unknown>;
		const targetId = typeof rec.targetId === "string" ? rec.targetId.trim() : "";
		const id = typeof rec.id === "string" ? rec.id : targetId;
		if (!id || !targetId) return [];
		const type = rec.type === "issue" || rec.type === "blocks" || rec.type === "depends-on" || rec.type === "related" ? rec.type : "related";
		return [{ id, targetId, targetTitle: typeof rec.targetTitle === "string" && rec.targetTitle.trim() ? rec.targetTitle.trim() : targetId, type, url: typeof rec.url === "string" ? rec.url : undefined }];
	});
}

function planAnnotationTarget(value: unknown): PlanAnnotationTarget | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	const planPath = typeof rec.planPath === "string" ? rec.planPath.trim() : "";
	if (!planPath) return undefined;
	const lineStart = typeof rec.lineStart === "number" && Number.isInteger(rec.lineStart) && rec.lineStart > 0 ? rec.lineStart : undefined;
	const lineEnd = typeof rec.lineEnd === "number" && Number.isInteger(rec.lineEnd) && rec.lineEnd > 0 ? rec.lineEnd : lineStart;
	const quote = typeof rec.quote === "string" && rec.quote.trim() ? rec.quote.trim().slice(0, 4000) : undefined;
	const blockId = typeof rec.blockId === "string" && rec.blockId.trim() ? rec.blockId.trim() : undefined;
	const heading = typeof rec.heading === "string" && rec.heading.trim() ? rec.heading.trim().slice(0, 200) : undefined;
	return { planPath, lineStart, lineEnd, quote, blockId, heading };
}

function planAnnotationPrompt(feature: FeatureDTO, comment: ArtifactCommentDTO): string {
	const a = comment.annotation;
	const where = a ? `${a.planPath}${a.heading ? ` (§ ${a.heading})` : ""}${a.lineStart ? `:${a.lineStart}${a.lineEnd && a.lineEnd !== a.lineStart ? `-${a.lineEnd}` : ""}` : ""}` : "the linked plan";
	const quote = a?.quote ? `\n\nSelected plan text:\n> ${a.quote.replace(/\n/g, "\n> ")}` : "";
	return `Update the plan for feature "${feature.title}" (${feature.id}).

Reviewer annotation at ${where}:${quote}

Requested change:
${comment.body}

Apply the smallest coherent markdown change to the plan docs. Preserve existing plan structure, update acceptance criteria/prerequisites/decisions when relevant, and stop after the plan revision is complete.`;
}




interface SocketData {
	id: number;
	/** RBAC tier granted by the token presented at the WS handshake; gates inbound commands. */
	role: Role;
	/** Org whose fleet this socket sees (DB-registry mode); undefined in file mode / no active org. */
	orgId?: string;
	/** True iff this socket authenticated via the on-box loopback break-glass bearer token (no
	 *  session) in DB-registry mode — the SAME identity `bootstrapAdmin` names on the HTTP path.
	 *  Lets `resolveCommandManager` route a mutating command to the agent's actual owning manager
	 *  instead of always the root factory. Never true for a tenant session socket. */
	bootstrapAdmin?: boolean;
}

/** Resolved better-auth session shape we read (subset; structural typing tolerates better-auth's wider type). */
export interface AuthSession {
	user: { id: string; name: string; email: string; image?: string | null };
	session: { activeOrganizationId?: string | null };
}

/** Minimal structural view of a better-auth instance — enough to serve `/api/auth/*`, read the
 *  session, and bridge the active-org role. Avoids depending on better-auth's full inferred type. */
export interface AuthInstance {
	handler(req: Request): Promise<Response>;
	api: {
		getSession(input: { headers: Headers }): Promise<AuthSession | null>;
		getActiveMemberRole(input: { headers: Headers; query?: { organizationId?: string } }): Promise<{ role: string }>;
	};
}

export interface SquadServerOptions {
	port?: number;
	hostname?: string;
	/** Bearer secret for the `admin` tier — full access, including `/api/upgrade`. Required on every
	 *  /api request + the WS handshake. Omit (and omit `roleTokens`) to disable auth (loopback unit tests). */
	token?: string;
	/** Terminate TLS in-process (paths to PEM files). Omit to serve plain HTTP (e.g. behind `tailscale serve`). */
	tls?: { cert: string; key: string };
	/** Background Web Push registry; alerts fire when an agent needs a human. */
	push?: PushService;
	/** This host's operator identity, for labelling the local roster in the federation view. Defaults to OMP_SQUAD_OPERATOR / OS user. */
	operator?: Actor;
	/** Optional lower-tier tokens. `operator` grants every mutation except daemon upgrade; `viewer`
	 *  grants reads + transcript subscription only. Unset tiers are simply unavailable. */
	roleTokens?: { operator?: string; viewer?: string };
	/** Coordinator URL, reported on `/api/federation` (panel-gating). Defaults to OMP_SQUAD_COORDINATOR;
	 *  unset ⇒ federation surface stays inert. Peer presence itself now comes from the manager's bus (SEAM 2). */
	coordinator?: string;
	/** Pre-shared coordinator token. Accepted for back-compat; the server no longer dials the coordinator
	 *  (the manager's bus owns the single connection, SEAM 2), so this is unused by the server itself. */
	coordinatorToken?: string;
	/** DB-mode identity layer (better-auth). Set ⇒ DB mode: cookie sessions + orgs replace the bearer gate. Unset ⇒ FILE mode (today's bearer gate). */
	auth?: AuthInstance;
	/** The open DB handle backing DB mode; held so the server's lifetime owns it (closed by the daemon). */
	db?: DbHandle;
	/** Origins trusted for the squad's own cross-site mutation defense (DB mode). Same list the
	 *  better-auth instance gets (reachable daemon origins + BETTER_AUTH_URL). FILE mode ignores it. */
	trustedOrigins?: string[];
	/** DB-registry mode: a per-org SquadManager fleet. Set ⇒ route every request/WS to the caller's
	 *  org manager (org from the session) and fan WS events out per org. Unset ⇒ single-manager / file mode. */
	registry?: ManagerRegistry;
	/** DB-registry mode + root factory: the org id the operator signs into to watch their OWN factory.
	 *  When a session's active org equals this, requests/WS route to the root `manager` (the factory) instead
	 *  of a lazy tenant manager. Unset ⇒ the factory is reachable only via the on-box loopback admin. */
	rootOrgId?: string;
	/** Runtime feature-flag settings persisted under the state dir and applied to process.env. */
	runtimeSettings?: RuntimeSettingsStore;
	/** Operator policy rules (C-RULES) persisted under the state dir; agents read them at tool-call time. */
	policy?: PolicyStore;
}

/** Pure: a short, stable fingerprint of the served UI. Changes whenever index.html changes,
 *  letting connected tabs detect a post-upgrade asset change and self-refresh. */
export function computeUiVersion(html: string): string {
	return createHash("sha256").update(html).digest("hex").slice(0, 12);
}

/** Pure: does this status transition warrant a human-attention push, and with what payload? */
export function escalationPayload(prev: AgentStatus | undefined, a: AgentDTO, seeded: boolean): PushPayload | null {
	if (!seeded || prev === undefined || prev === a.status) return null;
	if (a.status !== "input" && a.status !== "error") return null;
	const title = a.status === "input" ? `⛔ ${a.name} needs you` : `⚠ ${a.name} errored`;
	const body = a.status === "input" ? a.pending[0]?.title ?? "waiting for input" : a.error ?? "agent error";
	return { title, body, url: `/#/agent/${a.id}`, tag: a.id };
}

// ponytail: 'unsafe-inline' is forced by the single-file inline-script/style SPA;
// connect-src 'self' is the compensating control (blocks token exfil to other origins).
/** Security response headers stamped on every dashboard + API response (finding F-3). */
export function securityHeaders(): Record<string, string> {
	return {
		"Content-Security-Policy":
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "no-referrer",
	};
}

/** True if a socket peer address is loopback (IPv4, IPv6, or IPv4-mapped). */
function isLoopbackAddr(ip: string): boolean {
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export class SquadServer {
	private readonly singleManager?: SquadManager;
	/** DB-registry mode fleet (per-org managers); undefined ⇒ single-manager (file mode / db-single). */
	private readonly registry?: ManagerRegistry;
	/** DB-registry mode + root factory: the operator's own org id, routed to `singleManager` (the factory). */
	private readonly rootOrgId?: string;
	/** Single-manager mode WS clients (one bucket). */
	private readonly clients = new Set<ServerWebSocket<SocketData>>();
	/** DB-registry mode WS clients bucketed by org so events fan out per tenant (risk #3). */
	private readonly clientsByOrg = new Map<string, Set<ServerWebSocket<SocketData>>>();
	private server?: Server<SocketData>;
	private readonly opts: SquadServerOptions;
	private sockSeq = 0;
	private readonly onEvent: (e: SquadEvent) => void;
	private presenceTimer?: Timer;
	private presenceDebounce?: Timer;
	/** agentId → repo it's claimed under, so we can release the claim on removal. */
	private readonly claimed = new Map<string, string>();
	/** Agent ids present when the server booted = survivors the daemon reattached to (vs spawned later). */
	private readonly startupAgentIds = new Set<string>();
	/** agentId → last status seen, so a push fires only on the transition into a blocking state. */
	private readonly lastStatus = new Map<string, AgentStatus>();
	/** agentId → last push epoch ms, throttling repeat alerts. */
	private readonly lastPush = new Map<string, number>();
	/** seeded after the first roster so a reconnect replay never alerts in bulk. */
	private pushSeeded = false;
	/** Fingerprint of the served UI at boot; sent on every roster so stale tabs self-refresh after an upgrade. */
	private uiVersion = "";
	/** This host's operator identity (labels the local roster in the federation view). */
	private readonly operator: Actor;
	/** Coordinator URL, reported on the `/api/federation` surface; null ⇒ federation surface inert.
	 *  Peer presence itself now comes from the manager's own bus (SEAM 2), not a second socket here. */
	private readonly coordinator: string | null;
	/** Token → tier map gating every /api request + WS command. Empty ⇒ auth off (loopback test mode). */
	private readonly authPolicy: AuthPolicy;
	/** DB-mode identity layer; when set the bearer gate is replaced by better-auth cookie sessions. Undefined ⇒ FILE mode. */
	private readonly auth: AuthInstance | undefined;
	/** Open DB handle backing DB mode (owned by the daemon; held here for member/org reads). */
	private readonly db: DbHandle | undefined;
	/** Origins allowed to mutate the squad's own routes in DB mode (cross-site defense). */
	private readonly trustedOrigins: Set<string>;
	/** ponytail: in-process public intake limiter; restart resets it, campaign token + origin + byte caps are the real controls. */
	private readonly feedbackRate = new Map<string, { minute: number; count: number }>();

	constructor(manager: SquadManager | undefined, opts: SquadServerOptions = {}) {
		this.singleManager = manager;
		this.registry = opts.registry;
		this.rootOrgId = opts.rootOrgId;
		this.opts = opts;
		this.onEvent = (e: SquadEvent) => this.broadcast(e);
		// Mirror index.ts's daemon resolution so self's operator id matches what the daemon gossips.
		this.operator = opts.operator ?? { id: process.env.OMP_SQUAD_OPERATOR || os.userInfo().username || "local", origin: "local" };
		this.coordinator = opts.coordinator ?? process.env.OMP_SQUAD_COORDINATOR ?? null;
		this.authPolicy = { admin: opts.token, operator: opts.roleTokens?.operator, viewer: opts.roleTokens?.viewer };
		this.auth = opts.auth;
		this.db = opts.db;
		this.trustedOrigins = new Set(opts.trustedOrigins ?? []);
	}

	get url(): string {
		const host = this.opts.hostname ?? "127.0.0.1";
		const scheme = this.opts.tls ? "https" : "http";
		return `${scheme}://${host}:${this.server?.port ?? this.opts.port ?? 0}`;
	}

	/** True in DB mode (a better-auth instance is wired); false in FILE mode. */
	private get dbMode(): boolean {
		return !!this.auth;
	}

	/** Bridge identity → RBAC tier: active-org role owner|admin ⇒ admin; member ⇒ operator;
	 *  authed but with NO active org (or the lookup fails) ⇒ viewer (read-only, never operator).
	 *  Only called in DB mode. */
	private async bridgeRole(req: Request, activeOrgId: string | null | undefined): Promise<Role> {
		if (!this.auth || !activeOrgId) return "viewer";
		try {
			const { role } = await this.auth.api.getActiveMemberRole({ headers: req.headers });
			return role === "owner" || role === "admin" ? "admin" : "operator";
		} catch {
			return "viewer";
		}
	}

	/** DB-mode break-glass: a loopback request carrying the daemon's admin bearer token resolves to
	 *  admin without a session, so the operator on the box can provision the first org/members.
	 *  Off-box requests get no token shortcut — they must authenticate with a session. */
	private loopbackBootstrapAdmin(req: Request, server: Server<SocketData>): boolean {
		const token = this.opts.token;
		if (!token) return false;
		const ip = server.requestIP(req)?.address;
		if (!ip || !isLoopbackAddr(ip)) return false;
		return tokenOk(requestToken(req), token);
	}

	/** DB-mode cross-site mutation defense: a present Origin must be in trustedOrigins. Same-origin
	 *  and Origin-less requests (CLI, server-to-server) pass; cross-site is rejected (beyond SameSite=Lax). */
	private originAllowed(req: Request): boolean {
		const origin = req.headers.get("origin");
		if (!origin) return true;
		return this.trustedOrigins.has(origin);
	}

	private feedbackRateAllowed(req: Request, server: Server<SocketData>, campaignId: string): boolean {
		const limit = envInt("OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN", 30);
		if (limit <= 0) return true;
		const minute = Math.floor(Date.now() / 60_000);
		const ip = server.requestIP(req)?.address ?? "unknown";
		const key = `${campaignId || "unknown"}:${ip}`;
		const rec = this.feedbackRate.get(key);
		if (!rec || rec.minute !== minute) {
			this.feedbackRate.set(key, { minute, count: 1 });
			return true;
		}
		rec.count++;
		return rec.count <= limit;
	}

	/** True when this org id names the operator's root factory (DB mode): the on-box loopback admin's
	 *  synthetic sentinel, or the configured OMP_SQUAD_ROOT_ORG. Only meaningful when a root factory exists. */
	private isRootOrg(orgId: string | undefined): boolean {
		if (!this.singleManager || !orgId) return false;
		return orgId === ROOT_FACTORY_ORG || (!!this.rootOrgId && orgId === this.rootOrgId);
	}

	/** Resolve the fleet an org id acts on. Single-manager mode: the root manager. DB-registry mode: the
	 *  operator's root factory (root org / loopback admin) when present, else the caller's per-org tenant
	 *  manager, else none. Org is always session-derived, never request-supplied. */
	private async fleetForOrg(orgId: string | undefined): Promise<SquadManager | undefined> {
		if (!this.registry) return this.singleManager;
		if (this.isRootOrg(orgId)) return this.singleManager;
		return orgId ? await this.registry.get(orgId) : undefined;
	}

	/** Resolve the fleet a request/socket acts on. This is the ONLY way to reach a manager. */
	private managerFor(actor: Actor): Promise<SquadManager | undefined> {
		return this.fleetForOrg(actor.orgId);
	}

	/** The manager set a GET reaches for fleet-wide observability (health/graph/usage/heat/activity/
	 *  action-items/governance) — the SAME break-glass audience GET /api/agents already unions via
	 *  `registry.liveManagers()`: the optional root factory plus every currently live org manager. A
	 *  tenant session is never bootstrapAdmin, so it always gets its own single-manager array here
	 *  (or none, if it has no active org) — isolation is unaffected; only the on-box loopback admin
	 *  bearer token ever sees more than one manager. */
	private observabilityManagers(bootstrapAdmin: boolean, manager: SquadManager | undefined): SquadManager[] {
		if (!bootstrapAdmin) return manager ? [manager] : [];
		return [...(this.singleManager ? [this.singleManager] : []), ...(this.registry?.liveManagers() ?? [])];
	}

	/**
	 * The rm-doesn't-stick incident, layer 3: `managerFor(actor)` (via `fleetForOrg`) hard-codes the
	 * bootstrap admin's org to `ROOT_FACTORY_ORG`, so every mutating command from that identity always
	 * dispatched to the root factory — even one naming an agent that actually lives on a lazily-created
	 * ORG manager (`ManagerRegistry`'s per-org fleet). `resolveRemovalId` (squad-manager.ts) then missed
	 * it in the root's own live roster AND persisted store, fell back to tombstoning the raw identifier
	 * in the ROOT's ledger, and reported success — a no-op that looked like it worked.
	 *
	 * Fix: for the bootstrap-admin identity ONLY, a command that names a target agent (by id or bare
	 * display name) is resolved against the SAME break-glass union `observabilityManagers` already
	 * built for the GET read-path (#113) — the root factory plus every currently live org manager —
	 * instead of blindly using `defaultManager`. A tenant session is never bootstrap-admin (see the
	 * `bootstrapAdmin` predicate at its call sites), so its commands are completely unaffected and stay
	 * confined to its own single-manager array, exactly as before.
	 *
	 * Resolution order mirrors `resolveRemovalId`'s own "never guess" rule, just widened across
	 * managers instead of within one: an exact id match (unambiguous) first, then a name match that is
	 * unique across the WHOLE union. Returns:
	 *  - `defaultManager` unchanged when the actor isn't bootstrap-admin, there's no registry, or the
	 *    command carries no agent target (create/snapshot/commission/message) — byte-identical to the
	 *    pre-fix routing.
	 *  - the actual owning manager when the target is found live somewhere in the union (the fix).
	 *  - `undefined` when the actor IS bootstrap-admin, the command DOES name a target, and that target
	 *    is live in NO candidate manager — an honest "not found" instead of silently forwarding to the
	 *    root and letting its tombstone-anyway fallback (a deliberate safety net for ITS OWN
	 *    evict/recreate race, not this cross-manager one) report false success.
	 */
	private resolveCommandManager(cmd: ClientCommand, bootstrapAdmin: boolean, defaultManager: SquadManager | undefined): SquadManager | undefined {
		if (!bootstrapAdmin || !this.registry) return defaultManager;
		const target = commandAgentTarget(cmd);
		if (!target) return defaultManager;
		const candidates = this.observabilityManagers(true, defaultManager);
		for (const m of candidates) if (m.list().some((a) => a.id === target)) return m;
		const byName = candidates.filter((m) => m.list().some((a) => a.name === target));
		if (byName.length === 1) return byName[0];
		if (byName.length > 1) console.warn(`[server] bootstrap-admin command "${cmd.type}" target "${target}" matched ${byName.length} live managers by name — refusing to guess`);
		return undefined;
	}

	/** GET-only fleet-wide observability routes, resolved against `managers` (see `observabilityManagers`)
	 *  instead of the single per-request `manager` — so the bootstrap-admin break-glass view aggregates
	 *  every live org manager exactly like GET /api/agents does, instead of silently reading empty just
	 *  because no root factory is configured. Returns undefined for any other pathname/method so the
	 *  caller falls through to the single-manager route table below. */
	private async handleObservability(url: URL, req: Request, managers: SquadManager[], role: Role, actor: Actor): Promise<Response | undefined> {
		if (req.method !== "GET" || managers.length === 0) return undefined;
		if (url.pathname === "/api/health") {
			const h = await aggregateHealth(managers);
			const projects = new Set(managers.flatMap((m) => m.projects().map((p) => p.repo))).size;
			return Response.json({ ok: h.warnings.length === 0, warnings: h.warnings, ...h.sample, projects, uptimeSec: Math.round(process.uptime()), at: h.at });
		}
		if (url.pathname === "/api/usage") return Response.json(await usagePayload(managers, url));
		if (url.pathname === "/api/heat") return Response.json(await heatPayload(managers, url));
		if (url.pathname === "/api/activity/heatmap") return Response.json(await activityHeatmapPayload(managers, url));
		if (url.pathname === "/api/graph" || url.pathname === "/api/graph/commit" || url.pathname === "/api/graph/attribution" || url.pathname === "/api/graph/scoreboard" || url.pathname === "/api/graph/provenance") {
			const repo = resolveGraphRepo(url, managers);
			if (!repo) return new Response("repo not allowed", { status: 403 });
			if (url.pathname === "/api/graph") return Response.json(await graphPayload(url, repo));
			if (url.pathname === "/api/graph/commit") return Response.json(await commitDetailPayload(url, repo));
			if (url.pathname === "/api/graph/attribution") return Response.json(await attributionPayload(url, repo));
			if (url.pathname === "/api/graph/scoreboard") return Response.json(await scoreboardPayload(repo));
			return Response.json(await provenancePayload(url, repo, managers));
		}
		// Not nested under the resolveGraphRepo-gated /api/graph block above: TaskOutcomeRow (the joined
		// outcome log this reads) has no `repo` field — a unit's routing decision isn't a per-repo concept
		// — so there is nothing for that allowlist to scope. Fleet-wide, like /api/usage and /api/heat.
		if (url.pathname === "/api/graph/task-class") return Response.json(await taskClassPayload(managers, url));
		if (url.pathname === "/api/action-items") return Response.json(await actionItemsPayload(managers, url));
		if (url.pathname === "/api/governance") return Response.json(await governancePayload(managers, role, this.dbMode, !!this.registry));
		if (url.pathname === "/api/leases") {
			const repo = url.searchParams.get("repo");
			// File mode (no registry): the lease registry IS this one host's whole world — serve it
			// directly, unchanged from before this fix. DB-registry mode: union each reachable
			// manager's own org-scoped leases (see orgScopedLeasesAcross).
			return Response.json(this.registry ? await this.orgScopedLeasesAcross(managers, repo) : await leasesFor(repo ?? process.cwd()));
		}
		if (url.pathname === "/api/fabric") {
			const repo = url.searchParams.get("repo");
			// fabric is org-safe in both modes: leases are keyed to the manager's own agents/repos,
			// so includeLeases never leaks cross-org. Always include them (real data, even in DB mode).
			return Response.json(await fabricSnapshotAcross(managers, actor, { repos: repo ? [repo] : undefined, includeLeases: true }));
		}
		if (url.pathname === "/api/fabric/search") {
			// Ranked search over the SAME unioned-but-still-scoped snapshot — never widens what the
			// actor can see beyond the break-glass union every other observability route already grants.
			const repo = url.searchParams.get("repo");
			const q = url.searchParams.get("q") ?? "";
			const topK = boundedNumber(url.searchParams.get("topK"), 20, 1, 100);
			const type = (url.searchParams.get("type") ?? undefined) as KbDocType | undefined;
			const snapshot = await fabricSnapshotAcross(managers, actor, { repos: repo ? [repo] : undefined, includeLeases: true });
			const results = q.trim() ? searchFabric(snapshot, q, { topK, type }) : [];
			return Response.json({ query: q, results, counts: { agents: snapshot.agents.length, digests: snapshot.digests.length, hotAreas: snapshot.hotAreas.length, scout: snapshot.scout.length, leases: snapshot.leases.length, decisions: snapshot.decisions.length } });
		}
		if (url.pathname === "/api/audit") {
			const q = url.searchParams;
			const limit = Number(q.get("limit"));
			return Response.json(
				await auditPayloadAcross(managers, {
					limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
					actor: q.get("actor") ?? undefined,
					action: q.get("action") ?? undefined,
					target: q.get("target") ?? undefined,
				}),
			);
		}
		if (url.pathname === "/api/automation") {
			// Background-loop observability: recent events + per-loop rollups. ?loop= filters one loop,
			// ?windowMs= sizes the rollup window (default 1h), ?meaningful=1 drops heartbeats, ?limit= caps the feed.
			const q = url.searchParams;
			const loopParam = q.get("loop");
			const loop = loopParam === "scout" || loopParam === "observer" || loopParam === "opportunity" || loopParam === "dispatch" ? loopParam : undefined;
			const limit = Number(q.get("limit"));
			const windowMs = Number(q.get("windowMs"));
			const sinceMs = Number(q.get("sinceMs"));
			return Response.json(
				await automationPayloadAcross(managers, {
					loop,
					limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
					windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined,
					sinceMs: Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined,
					meaningfulOnly: q.get("meaningful") === "1",
				}),
			);
		}
		if (url.pathname === "/api/metrics/learning-loop") {
			// Agentic-learning-loop baseline (concern 01): current flag resolution + per-metric rollups
			// (first-try-green, fixups-to-green, escalation, land-failure-streak, primer-empty), so every
			// later concept in the loop can be A/B-compared against this. ?windowMs= sizes the rollup window.
			const windowMs = Number(url.searchParams.get("windowMs"));
			return Response.json(learningLoopPayloadAcross(managers, Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined));
		}
		return undefined;
	}

	/** Actor for an inbound WS command — the socket's tier plus, in DB-registry mode, its stamped org. */
	private actorForSocket(ws: ServerWebSocket<SocketData>): Actor {
		return this.registry ? { id: `web:${ws.data.role}`, origin: "local", role: ws.data.role, orgId: ws.data.orgId } : actorForRole(ws.data.role);
	}

	/** Register an opening socket in its bucket and return the fleet to seed its roster from. */
	private async registerSocket(ws: ServerWebSocket<SocketData>): Promise<SquadManager | undefined> {
		if (!this.registry) {
			this.clients.add(ws);
			return this.singleManager;
		}
		const key = ws.data.orgId ?? "";
		let bucket = this.clientsByOrg.get(key);
		if (!bucket) {
			bucket = new Set();
			this.clientsByOrg.set(key, bucket);
		}
		bucket.add(ws);
		// Root-org sockets bucket under their org key (so root-manager events fan out to them) but seed
		// their roster from the root factory, not a lazy tenant manager.
		return this.fleetForOrg(ws.data.orgId);
	}

	/** Drop a closing socket from its bucket (and prune the bucket when empty). */
	private unregisterSocket(ws: ServerWebSocket<SocketData>): void {
		if (!this.registry) {
			this.clients.delete(ws);
			return;
		}
		const key = ws.data.orgId ?? "";
		const bucket = this.clientsByOrg.get(key);
		if (bucket) {
			bucket.delete(ws);
			if (bucket.size === 0) this.clientsByOrg.delete(key);
		}
	}

	/** DB-registry response for an actor with no active org: reads are empty, mutations denied. */
	private noFleet(req: Request, url: URL): Response {
		if (req.method !== "GET") return new Response("no active organization", { status: 403 });
		if (url.pathname === "/api/version") return Response.json({ version: this.uiVersion });
		if (url.pathname === "/api/info") return Response.json({ cwd: process.cwd() });
		// Available coding-agent harnesses for the create surfaces. Unverified ones appear only when
		// OMP_SQUAD_UNVERIFIED_HARNESS=1 (honest gating — a harness not smoke-tested against a live binary
		// isn't offered by default). `?all=1` includes them regardless so an operator can inspect the roster.
		if (url.pathname === "/api/harnesses") {
			const all = url.searchParams.get("all") === "1";
			// Tiers are additive to the existing shape — `verified` (the gate's own bit) is untouched;
			// `tier`/`binDetected`/`usageVerified`/`alert` are honest labels alongside it, not a replacement.
			const tiers = new Map(listHarnessTiers().map((t) => [t.name, t]));
			return Response.json({
				default: globalDefaultHarness(),
				harnesses: listHarnesses(all || undefined).map((h) => {
					const t = tiers.get(h.name);
					return { name: h.name, protocol: h.protocol, verified: h.verified, capabilities: h.capabilities, note: t?.note ?? h.note, tier: t?.tier, binDetected: t?.binDetected, usageVerified: t?.usageVerified ?? false, alert: t?.alert };
				}),
			});
		}
		return Response.json([]);
	}

	start(): string {
		if (this.singleManager) for (const a of this.singleManager.list()) this.startupAgentIds.add(a.id);
		this.uiVersion = computeUiVersion(readFileSync(webappEnabled() ? WEBAPP_INDEX : INDEX_HTML, "utf8"));

		this.server = Bun.serve<SocketData>({
			port: this.opts.port ?? 7878,
			hostname: this.opts.hostname ?? "127.0.0.1",
			tls: this.opts.tls ? { cert: Bun.file(this.opts.tls.cert), key: Bun.file(this.opts.tls.key) } : undefined,
			// seconds. Bun's default is 10s — too short for an idle dashboard socket or a handler stalled
			// under fan-out load; both got dropped, spamming "[Bun.serve]: request timed out after 10s".
			idleTimeout: 120,
			fetch: async (req, server) => {
				const resp = await this.handle(req, server);
				if (resp) for (const [k, v] of Object.entries(securityHeaders())) resp.headers.set(k, v);
				return resp;
			},
			websocket: {
				// Max (255s). Idle dashboards send no commands for minutes; sendPings (default on) keeps the
				// socket warm so it doesn't 1006-drop and trigger the client's error/reconnect loop.
				idleTimeout: 255,
				open: async (ws) => {
					const m = await this.registerSocket(ws);
					const agents = m?.list() ?? [];
					ws.send(JSON.stringify({ type: "roster", agents, version: this.uiVersion } satisfies SquadEvent));
					for (const a of agents) {
						const commands = m?.commandsFor(a.id);
						if (commands?.length) ws.send(JSON.stringify({ type: "commands", id: a.id, commands } satisfies SquadEvent));
					}
				},
				close: (ws) => this.unregisterSocket(ws),
				message: async (ws, raw) => {
					let parsed: unknown;
					try {
						parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
					} catch {
						return;
					}
					// Untrusted wire: validate the command envelope before dispatch. A malformed or
					// hostile frame (unknown type, mistyped/missing field, injected keys) is dropped.
					const decoded = decodeClientCommand(parsed);
					if (Result.isFailure(decoded)) return;
					const cmd = decoded.success;
					// Route to the socket's org fleet (registry mode) or the single manager; org never from the wire.
					const actor = this.actorForSocket(ws);
					const defaultManager = await this.managerFor(actor);
					if (!defaultManager) return;
					// Bootstrap-admin cross-manager routing (mirrors the HTTP /api/command path below and
					// #113's GET read-path union): a command naming a target agent may own live on a
					// different org manager than the root factory `defaultManager` resolved to. A tenant
					// session socket is never `bootstrapAdmin` (see the WS handshake above), so this is a
					// no-op for it — `m` is always `defaultManager`, exactly as before.
					const m = this.resolveCommandManager(cmd, !!ws.data.bootstrapAdmin, defaultManager);
					if (!m) return; // bootstrap-admin named a target live in no manager — honest no-op (WS has no per-command response channel to report 404 on)
					// Transcript replay is unicast to the requesting socket.
					if (cmd.type === "subscribe") {
						for (const entry of m.getTranscript(cmd.id)) {
							ws.send(JSON.stringify({ type: "transcript", id: cmd.id, entry } satisfies SquadEvent));
						}
						return;
					}
					// Carry the socket's granted tier; applyCommand denies a command above it (logged there).
					// This is a fire-and-forget dispatch (a WS message handler, no reply channel to report a
					// failure on) — `void`-ing the call means ANY rejection that escapes this `.catch` becomes
					// an unhandled promise rejection with no further catcher in the chain. Rethrowing a
					// non-RbacDenied error here (the old behavior) manufactured exactly that: a console-chat
					// prompt to an agent whose harness failed to (re)start propagated an ensureConnected
					// rejection through applyCommand, landed here, got rethrown, and the resulting orphaned
					// rejection took the whole daemon down. RbacDenied is already logged inside applyCommand
					// (denied-command audit trail) so it's a silent no-op here; anything else is a genuine bug
					// upstream that should have been caught into the agent's own error state — log it loudly so
					// it's never lost, but never let it become a floating rejection again.
					void m.applyCommand(cmd, actor).catch((err) => {
						if (err instanceof RbacDenied) return;
						console.error(`[ws] applyCommand("${cmd.type}") failed unexpectedly:`, err);
					});
				},
			},
		});

		if (this.registry) {
			// DB-registry mode: per-org fan-out via the registry's event sink. No global presence/federation (risk #6).
			this.registry.onEvent = (orgId, e) => this.broadcastTo(orgId, e);
			// Root factory (opt-in): fan its events out to the operator's own socket buckets, reusing the exact
			// per-org WS path. Both the on-box loopback admin (bucketed under the ROOT_FACTORY_ORG sentinel) and
			// a browser operator signed into OMP_SQUAD_ROOT_ORG watch the factory move over the same transport.
			if (this.singleManager) {
				const rootBuckets = [ROOT_FACTORY_ORG, ...(this.rootOrgId ? [this.rootOrgId] : [])];
				this.singleManager.on("event", (e) => {
					for (const b of rootBuckets) this.broadcastTo(b, e);
				});
			}
		} else {
			this.singleManager?.on("event", this.onEvent);
			void this.syncPresence();
			this.presenceTimer = setInterval(() => void this.syncPresence(), 25_000);
			this.presenceTimer.unref?.();
			// SEAM 2: peer presence is read straight off the manager's federation bus (see
			// federationSnapshot → manager.peerPresence). No second coordinator socket is opened here.
		}
		return this.url;
	}

	private async handle(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
		const indexFile = Bun.file(webappEnabled() ? WEBAPP_INDEX : INDEX_HTML);
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			// The handshake only authenticates; per-command tier checks happen in applyCommand,
			// so a viewer may connect to read the roster + subscribe to transcripts.
			if (this.dbMode && !this.originAllowed(req)) return new Response("forbidden origin", { status: 403 });
			let role: Role | null;
			let orgId: string | undefined;
			let bootstrapAdmin = false;
			if (this.auth) {
				// DB mode: loopback admin token bootstraps; otherwise the session cookie rides the upgrade headers.
				if (this.loopbackBootstrapAdmin(req, server)) {
					role = "admin";
					// Same break-glass identity the HTTP path names `bootstrapAdmin` — only meaningful (and only
					// ever true) with a registry, matching that predicate exactly (see the POST /api/command gate).
					bootstrapAdmin = !!this.registry;
					// On-box operator: bucket this socket to the root factory (if one exists) so it sees the roster.
					if (this.singleManager) orgId = ROOT_FACTORY_ORG;
				} else {
					const session = await this.auth.api.getSession({ headers: req.headers });
					if (session) {
						role = await this.bridgeRole(req, session.session.activeOrganizationId);
						orgId = session.session.activeOrganizationId ?? undefined;
					} else {
						role = null;
					}
				}
			} else {
				role = resolveRole(req, this.authPolicy);
			}
			if (role === null) return new Response("unauthorized", { status: 401 });
			const upgraded = this.auth
				? server.upgrade(req, { data: { id: ++this.sockSeq, role, orgId, bootstrapAdmin } })
				: server.upgrade(req, { data: { id: ++this.sockSeq, role, orgId, bootstrapAdmin }, headers: { "Sec-WebSocket-Protocol": "ompsq-token" } });
			if (upgraded) return undefined;
			return new Response("websocket upgrade failed", { status: 426 });
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			// index.html references content-hashed bundles by name, so it MUST revalidate every load —
			// otherwise a browser caches it heuristically (no validator ⇒ stale for hours) and never
			// picks up a new deploy, pinning the user to an old bundle. no-cache forces the refetch.
			return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
		}
		// No favicon is bundled; 204 (public, pre-auth) beats the 401 the auth gate would otherwise log.
		if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
		const asset = PUBLIC_ASSETS[url.pathname];
		if (asset) return new Response(Bun.file(path.join(WEB_DIR, url.pathname.slice(1))), { headers: { "content-type": asset } });
		// Inert webapp seam: serve Vite's content-hashed bundle tokenless (like the shell) when enabled.
		// Containment check keeps requests inside dist/assets — no path traversal out of the build dir.
		if (webappEnabled() && url.pathname.startsWith("/assets/")) {
			const resolved = path.join(WEBAPP_ASSETS, url.pathname.slice("/assets/".length));
			if (resolved.startsWith(WEBAPP_ASSETS + path.sep) && existsSync(resolved)) {
				const type = ASSET_TYPES[path.extname(resolved)] ?? "application/octet-stream";
				// Vite filenames embed a content hash, so a given URL is immutable — cache it hard.
				// (index.html revalidates and always points at the current hashes.)
				return new Response(Bun.file(resolved), { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
			}
			return new Response("not found", { status: 404 });
		}
		if (url.pathname === "/feedback/widget.js") {
			if (!feedbackEnabled() || !existsSync(FEEDBACK_WIDGET)) return new Response("not found", { status: 404 });
			return new Response(Bun.file(FEEDBACK_WIDGET), { headers: { "content-type": "text/javascript; charset=utf-8" } });
		}
		if (url.pathname === "/api/feedback/items" && req.method === "POST") {
			if (!feedbackEnabled()) return new Response("not found", { status: 404 });
			if (!this.singleManager) return new Response("feedback unavailable", { status: 404 });
			const body: unknown = await req.json().catch(() => null);
			const parsedFeedback = decodeBodyOrEmpty(FeedbackItemsEnvelopeSchema, body);
			const campaignId = typeof parsedFeedback.campaignId === "string" ? parsedFeedback.campaignId : "";
			if (!this.feedbackRateAllowed(req, server, campaignId)) return new Response("rate limited", { status: 429 });
			try {
				// `body` (not `parsedFeedback`) is forwarded verbatim — submitFeedbackItem owns its own
				// validation of the full item shape; the schema above only narrows campaignId.
				const item = await this.singleManager.submitFeedbackItem(body, req.headers.get("origin"));
				return Response.json({ item }, { status: 201 });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = /token|origin/.test(message) ? 403 : 400;
				return Response.json({ error: message }, { status });
			}
		}
		// Public mode probe — lets the SPA pick its auth style before any login. No auth required.
		// The SPA reads this pre-login to choose its auth style and render only affordances the server backs:
		// file mode ⇒ bearer token (no login page); db mode ⇒ session login, with sign-up + social buttons
		// gated by what's actually configured server-side.
		if (url.pathname === "/api/auth/mode") return Response.json({ mode: this.dbMode ? "db" : "file", allowSignup: this.dbMode && signupOpen(), socialProviders: this.dbMode ? configuredSocialProviders() : [], sso: this.dbMode && ssoEnabled() });
		// WorkOS Directory Sync (SCIM) webhook. Unauthenticated by session — authenticated by the HMAC
		// signature over the RAW body (verifyWorkosSignature). Placed OUTSIDE /api/auth/* so better-auth's
		// catch-all doesn't intercept it. 404 when no secret is configured (feature off).
		if (url.pathname === "/api/workos/webhook" && req.method === "POST") {
			const secret = process.env.WORKOS_WEBHOOK_SECRET;
			if (!secret) return new Response("not found", { status: 404 });
			const raw = await req.text();
			const verdict = verifyWorkosSignature({ rawBody: raw, sigHeader: req.headers.get("workos-signature"), secret, now: Date.now() });
			if (!verdict.ok) return new Response(`invalid signature: ${verdict.reason}`, { status: 400 });
			const evt = parseWorkosEvent(raw);
			// SECURELY RECEIVED → provision. dsync.user.created/updated/group.user_added add the member to the
			// mapped org (creating the user by email if needed); dsync.user.deleted/group.user_removed remove them.
			if (evt && this.db) {
				try {
					const result = await provisionScimEvent(this.db.db, evt);
					if (result.handled) console.log(`[workos] dsync ${evt.event} → ${result.action}`);
				} catch (err) {
					console.error(`[workos] dsync provisioning failed for ${evt.event}:`, err);
				}
			}
			return new Response("ok");
		}
		if (url.pathname === "/llms.txt") return new Response("# omp-squad capability API\n\n- GET /api/capability-discovery\n- GET /api/capability-catalog\n- GET /api/capability-packs\n- POST /api/capability-sources\n- POST /api/capability-installs\n- GET /api/federation/capabilities\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
		if (url.pathname === "/openapi.json") return Response.json({ openapi: "3.1.0", info: { title: "omp-squad capability API", version: this.uiVersion }, paths: { "/api/capability-discovery": { get: {} }, "/api/capability-catalog": { get: {} }, "/api/capability-packs": { get: {} }, "/api/capability-sources": { get: {}, post: {} }, "/api/capability-installs": { get: {}, post: {} }, "/api/federation/capabilities": { get: {} } } });
		// DB mode: better-auth owns the rest of /api/auth/* (sign-in/up/out, org, members). Reachable
		// unauthenticated so login works; /api/auth/check stays our own (excluded here), handled below.
		if (this.auth && url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/auth/check") {
			return this.auth.handler(req);
		}
		// F4 (DB mode): reject cross-site mutations of our OWN routes as defense-in-depth (beyond
		// SameSite=Lax). Better-auth's /api/auth/* routes already returned above with their own check.
		if (this.dbMode && req.method !== "GET" && !this.originAllowed(req)) return new Response("forbidden origin", { status: 403 });
		// Auth gate. FILE mode: the bearer-token gate (unchanged) — public bootstrap (shell, manifest,
		// service worker, icons handled above) loads tokenless so the PWA can install and prompt. DB
		// mode: a valid better-auth cookie session, with the active-org role bridged to an RBAC tier.
		let role: Role;
		let session: AuthSession | null = null;
		if (this.auth) {
			// Break-glass: a loopback admin token bootstraps before any org/session exists.
			if (this.loopbackBootstrapAdmin(req, server)) {
				role = "admin";
			} else {
				session = await this.auth.api.getSession({ headers: req.headers });
				if (session === null) return new Response("unauthorized", { status: 401 });
				role = await this.bridgeRole(req, session.session.activeOrganizationId);
			}
		} else {
			const resolved = resolveRole(req, this.authPolicy);
			if (resolved === null) return new Response("unauthorized", { status: 401 });
			role = resolved;
		}
		// WorkOS onboarding — map existing memberships, else domain-match (auto-join / request-to-join per the
		// org's policy), else create a personal workspace; then point the session at the active org. BEFORE the
		// tier gate on purpose: a freshly-signed-in SSO user is org-less (⇒ viewer) and must onboard themselves.
		if (url.pathname === "/api/workos/sync" && req.method === "POST") {
			if (!this.auth || !this.db || session === null) return Response.json({ outcome: "none" });
			try {
				// WorkOS-linked users onboard via their org memberships / domain match; everyone else (email,
				// GitHub) with no org gets a personal workspace so self-serve tenancy works without WorkOS.
				const result = ssoEnabled() ? await onboardWorkosUser(this.db.db, session.user.id) : { outcome: "none" as const };
				if (result.outcome === "none") {
					const orgId = await ensurePersonalWorkspace(this.db.db, session.user.id);
					if (orgId) return Response.json({ outcome: "personal", organizationId: orgId });
				}
				return Response.json(result);
			} catch (err) {
				console.error("[auth] onboarding failed:", err);
				return Response.json({ outcome: "none", error: "onboarding failed" }, { status: 500 });
			}
		}
		if (!roleAtLeast(role, requiredRole(req.method, url.pathname))) return new Response("forbidden", { status: 403 });
		if (url.pathname === "/api/me") {
			if (!this.auth || session === null) return Response.json({ mode: "file" });
			const u = session.user;
			return Response.json({ mode: "db", user: { id: u.id, name: u.name, email: u.email, image: u.image ?? null }, activeOrganizationId: session.session.activeOrganizationId ?? null, role });
		}
		// Admin: pending join requests for the caller's active org (domain-match "require approval" policy).
		// Exposes member emails ⇒ admin-only, scoped to the caller's own active org.
		if (url.pathname === "/api/workos/join-requests" && req.method === "GET") {
			if (!this.auth || !this.db || session === null || !roleAtLeast(role, "admin")) return Response.json([]);
			const orgId = session.session.activeOrganizationId;
			return Response.json(orgId ? await listPendingJoinRequests(this.db.db, orgId) : []);
		}
		if (url.pathname === "/api/workos/join-requests/decide" && req.method === "POST") {
			if (!this.auth || !this.db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const raw: unknown = await req.json().catch(() => null);
			const decoded = decodeBody(JoinRequestDecideBodySchema, raw);
			if (Result.isFailure(decoded)) return new Response("missing id", { status: 400 });
			const body = decoded.success;
			const ok = body.action === "deny" ? await denyJoinRequest(this.db.db, body.id, orgId) : await approveJoinRequest(this.db.db, body.id, orgId);
			return Response.json({ ok });
		}
		// Org settings. Profile is visible to any member of the active org; member management is admin-only,
		// scoped to the caller's own active org.
		if (url.pathname === "/api/org" && req.method === "GET") {
			if (!this.auth || !this.db || session === null) return new Response("unavailable", { status: 400 });
			const orgId = session.session.activeOrganizationId;
			return Response.json(orgId ? await getOrgProfile(this.db.db, orgId) : null);
		}
		if (url.pathname === "/api/org" && req.method === "PATCH") {
			if (!this.auth || !this.db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const body = decodeBodyOrEmpty(OrgPatchBodySchema, await req.json().catch(() => null));
			const ok = await renameOrg(this.db.db, orgId, typeof body.name === "string" ? body.name : "");
			return Response.json({ ok });
		}
		if (url.pathname === "/api/org/members" && req.method === "GET") {
			if (!this.auth || !this.db || session === null || !roleAtLeast(role, "admin")) return Response.json([]);
			const orgId = session.session.activeOrganizationId;
			return Response.json(orgId ? await listOrgMembers(this.db.db, orgId) : []);
		}
		if ((url.pathname === "/api/org/members/role" || url.pathname === "/api/org/members/remove") && req.method === "POST") {
			if (!this.auth || !this.db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const decoded = decodeBody(OrgMemberRoleBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.userId) return new Response("missing userId", { status: 400 });
			const { userId, role: targetRole } = decoded.success;
			if (userId === session.user.id) return Response.json({ ok: false, error: "you can't change your own membership here" });
			const result =
				url.pathname === "/api/org/members/role"
					? await setMemberRole(this.db.db, orgId, userId, typeof targetRole === "string" ? targetRole : "")
					: await removeMember(this.db.db, orgId, userId);
			return Response.json(result);
		}
		if (url.pathname === "/api/org/members/invite" && req.method === "POST") {
			if (!this.auth || !this.db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const decoded = decodeBody(OrgMemberInviteBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.email) return new Response("missing email", { status: 400 });
			const { email, role: inviteRole } = decoded.success;
			return Response.json(await addMemberByEmail(this.db.db, orgId, email, typeof inviteRole === "string" ? inviteRole : "member"));
		}
		// Domain-join policy (WorkOS orgs only) — read/set the org's auto|approval policy in WorkOS metadata.
		if (url.pathname === "/api/org/join-policy" && req.method === "GET") {
			if (!this.auth || !this.db || session === null || !roleAtLeast(role, "admin")) return Response.json({ policy: null });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return Response.json({ policy: null });
			const profile = await getOrgProfile(this.db.db, orgId);
			if (!profile?.workosOrgId) return Response.json({ policy: null }); // not a WorkOS org
			return Response.json({ policy: await getWorkosOrgPolicy(profile.workosOrgId) });
		}
		if (url.pathname === "/api/org/join-policy" && req.method === "POST") {
			if (!this.auth || !this.db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const profile = await getOrgProfile(this.db.db, orgId);
			if (!profile?.workosOrgId) return Response.json({ ok: false, error: "not a WorkOS-backed organization" });
			const body = decodeBodyOrEmpty(OrgJoinPolicyBodySchema, await req.json().catch(() => null));
			const policy = body.policy === "auto" ? "auto" : "approval";
			return Response.json({ ok: await setWorkosOrgPolicy(profile.workosOrgId, policy), policy });
		}
		if (url.pathname === "/api/auth/check") return Response.json({ ok: true });
		if (url.pathname === "/api/push/key") return Response.json({ publicKey: this.opts.push?.publicKey ?? "" });
		if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
			if (!this.opts.push) return new Response("push unavailable", { status: 501 });
			const decoded = decodeBody(PushSubscriptionBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("invalid subscription", { status: 400 });
			const sub = decoded.success;
			await this.opts.push.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/settings" && req.method === "GET") {
			const flags = this.opts.runtimeSettings ? await this.opts.runtimeSettings.states() : featureFlagStates();
			return Response.json({ featureFlags: flags });
		}
		if (url.pathname === "/api/settings/feature-flags" && req.method === "POST") {
			if (!this.opts.runtimeSettings) return new Response("settings persistence unavailable", { status: 501 });
			const decoded = decodeBody(FeatureFlagBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !isFeatureFlagKey(decoded.success.key)) {
				return new Response("feature flag key and enabled boolean required", { status: 400 });
			}
			const flags = await this.opts.runtimeSettings.setFeatureFlag(decoded.success.key, decoded.success.enabled);
			return Response.json({ featureFlags: flags });
		}
		if (url.pathname === "/api/policy/rules" && req.method === "GET") {
			if (!this.opts.policy) return new Response("policy persistence unavailable", { status: 501 });
			return Response.json(await this.opts.policy.load());
		}
		if (url.pathname === "/api/policy/rules" && req.method === "POST") {
			if (!this.opts.policy) return new Response("policy persistence unavailable", { status: 501 });
			const decoded = decodeBody(PolicyRulesBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("a rules array is required", { status: 400 });
			// parsePolicyDoc drops malformed rules (fail-open); the store persists the sanitized set.
			const doc = await this.opts.policy.setRules(parsePolicyDoc({ rules: decoded.success.rules }).rules);
			return Response.json(doc);
		}
		// Resolve the caller's fleet. Single-manager mode: the root manager. DB-registry mode: session
		// callers route to their org manager; the on-box bearer token is a break-glass operator view.
		//
		// Important DB-mode edge: bearer-token CLI reads have no session org. They still must see live org
		// managers for operator observability (`glance list`, GET /api/agents) while remaining loopback-only.
		// If a root factory also exists, include it rather than making a zero-agent root mask live tenant units.
		const bootstrapAdmin = !!this.registry && session === null && role === "admin";
		if (bootstrapAdmin && this.registry && req.method === "GET" && url.pathname === "/api/agents") {
			return Response.json([...(this.singleManager?.list() ?? []), ...this.registry.liveAgents()]);
		}
		const orgId = this.registry
			? bootstrapAdmin && this.singleManager
				? ROOT_FACTORY_ORG
				: (session?.session.activeOrganizationId ?? undefined)
			: undefined;
		const actor: Actor =
			this.registry && session
				? { id: `db:${session.user.id}`, displayName: session.user.name, origin: "local", role, orgId }
				: bootstrapAdmin
					? { ...actorForRole(role), orgId }
					: actorForRole(role);
		const manager = await this.managerFor(actor);
		// Seed identity for features created this request: a real signed-in user's `db:<userId>` when
		// there's a session, else undefined ⇒ the manager falls back to its own operator identity
		// (file mode, or an on-box bootstrap admin with no session). Never seeds a role-derived id.
		const featureAuthor = session ? actor.id : undefined;
		// Fleet-wide GET observability (graph/usage/heat/activity/action-items/governance) is resolved
		// against the SAME break-glass audience as GET /api/agents above (see observabilityManagers) so
		// it must be checked before the `!manager` gate below: a bootstrap-admin without a root factory
		// has no single `manager` (orgId stayed unresolved above) but DOES have live org managers to
		// aggregate. A tenant session's set is always its own 1-manager array, so isolation is unaffected.
		const observabilityResponse = await this.handleObservability(url, req, this.observabilityManagers(bootstrapAdmin, manager), role, actor);
		if (observabilityResponse) return observabilityResponse;
		if (!manager) return this.noFleet(req, url);
		// Authenticated feedback routes live in ./feedback-routes.ts (the pre-auth widget
		// submit + widget.js stay above — they need the server's rate limiter).
		const feedbackResponse = await handleFeedbackRoutes(url, req, manager, actor);
		if (feedbackResponse) return feedbackResponse;
		if (url.pathname === "/api/agents") return Response.json(manager.list());
		if (url.pathname === "/api/projects") return Response.json(manager.projects());
		if (url.pathname === "/api/workflows") return Response.json(workflowSnapshot(manager.list(), manager.capabilityWorkflowDefinitions()));
		if (url.pathname === "/api/models") return Response.json({ models: mergeModelOptions(modelOptionsFromEnv(), await manager.modelOptions()) });
		if (url.pathname === "/api/profiles") return Response.json({ profiles: manager.profiles() });
		if (url.pathname === "/api/capabilities") return Response.json(manager.capabilities());
		if (url.pathname === "/api/capability-audit") return Response.json({ audit: manager.capabilities().audit });
		if (url.pathname === "/api/capability-verifications") return Response.json({ verifications: manager.capabilities().verifications });
		if (url.pathname === "/api/capability-catalog") return Response.json({ catalog: publicCapabilityCatalog() });
		if (url.pathname === "/api/capability-sources" && req.method === "GET") return Response.json({ sources: manager.capabilities().sources });
		if (url.pathname === "/api/capability-sources" && req.method === "POST") {
			const decoded = decodeBody(CapabilitySourceBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("manifest or catalogId required", { status: 400 });
			const rec = decoded.success;
			const catalogId = typeof rec.catalogId === "string" ? rec.catalogId : undefined;
			const catalogEntry = catalogId ? publicCapabilityManifest(catalogId) : undefined;
			const manifest = catalogEntry?.manifest ?? rec.manifest;
			if (!manifest) return new Response(catalogId ? "catalog capability not found" : "manifest required", { status: 400 });
			const name = typeof rec.name === "string" ? rec.name : catalogEntry?.source;
			const sourceUrl = typeof rec.url === "string" ? rec.url : catalogId ? `catalog:${catalogId}` : undefined;
			const trusted = typeof rec.trusted === "boolean" ? rec.trusted : catalogId ? true : undefined;
			return Response.json(manager.importCapability({ name, url: sourceUrl, trusted, manifest }, actor));
		}
		if (url.pathname === "/api/capability-packs" && req.method === "GET") return Response.json({ packs: manager.capabilities().packs });
		const mcpack = url.pathname.match(/^\/api\/capability-packs\/([^/]+)(?:\/diff\/([^/]+))?$/);
		if (mcpack && req.method === "GET") {
			const id = decodeURIComponent(mcpack[1]);
			if (mcpack[2]) return Response.json({ changes: manager.capabilityDiff(id, decodeURIComponent(mcpack[2])) });
			const pack = manager.capabilities().packs.find((item) => item.id === id);
			return pack ? Response.json(pack) : new Response("capability pack not found", { status: 404 });
		}
		if (url.pathname === "/api/capability-installs" && req.method === "GET") return Response.json({ installs: manager.capabilities().installs });
		if (url.pathname === "/api/capability-installs" && req.method === "POST") {
			const decoded = decodeBody(CapabilityInstallBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("packId required", { status: 400 });
			const rec = decoded.success;
			const overrides = rec.overrides && typeof rec.overrides === "object" && !Array.isArray(rec.overrides) ? rec.overrides as Record<string, unknown> : undefined;
			const enable = typeof rec.enable === "boolean" ? rec.enable : undefined;
			return Response.json(manager.installCapability({ packId: rec.packId, overrides, enable }, actor));
		}
		const mcinstall = url.pathname.match(/^\/api\/capability-installs\/([^/]+)(?:\/(run))?$/);
		if (mcinstall && req.method === "PATCH" && !mcinstall[2]) {
			const patch = decodeBodyOrEmpty(CapabilityInstallPatchBodySchema, await req.json().catch(() => null));
			return Response.json(manager.updateCapability(decodeURIComponent(mcinstall[1]), {
				state: capabilityInstallState(patch.state),
				enabled: typeof patch.enabled === "boolean" ? patch.enabled : undefined,
				removed: patch.removed === true,
				rollback: patch.rollback === true,
				upgradeToPackId: typeof patch.upgradeToPackId === "string" ? patch.upgradeToPackId : undefined,
				overrides: patch.overrides && typeof patch.overrides === "object" && !Array.isArray(patch.overrides) ? patch.overrides as Record<string, unknown> : undefined,
			}, actor));
		}
		if (mcinstall && req.method === "POST" && mcinstall[2] === "run") {
			const rec = decodeBodyOrEmpty(CapabilityInstallRunBodySchema, await req.json().catch(() => null));
			const bindingKey = typeof rec.bindingKey === "string" ? rec.bindingKey : undefined;
			const repo = typeof rec.repo === "string" && rec.repo ? rec.repo : undefined;
			const prompt = typeof rec.prompt === "string" && rec.prompt.trim() ? rec.prompt.trim() : undefined;
			const agent = await manager.runCapability(decodeURIComponent(mcinstall[1]), bindingKey, { repo, prompt }, actor);
			return Response.json({ agent, installId: decodeURIComponent(mcinstall[1]), bindingKey });
		}
		if (url.pathname === "/api/features" && req.method === "GET") return Response.json(await manager.features(url.searchParams.get("repo") ?? undefined));
		if (url.pathname === "/api/features/archived" && req.method === "GET") return Response.json({ features: manager.archivedFeatures(url.searchParams.get("repo") ?? undefined) });
		if (url.pathname === "/api/features" && req.method === "POST") {
			const decoded = decodeBody(FeatureCreateBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("title required", { status: 400 });
			const body = decoded.success;
			const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const planDir = typeof body.planDir === "string" ? body.planDir : undefined;
			manager.createFeature({ title: body.title, repo, planDir, author: featureAuthor });
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/features/from-plan" && req.method === "POST") {
			const decoded = decodeBody(FeatureFromPlanBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("planDir required", { status: 400 });
			const body = decoded.success;
			const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const planDir = body.planDir.replace(/\/+$/, "");
			const planTitle = (await listPlanDirs(repo)).find((pd) => pd.dir === planDir)?.title;
			const fallbackTitle = typeof body.title === "string" && body.title.trim() ? body.title.trim() : path.basename(planDir).replace(/[-_]+/g, " ");
			const title = planTitle ?? fallbackTitle;
			const existing = (await manager.features(repo)).find((f) => f.planDir === planDir);
			const pf = existing ?? manager.createFeature({ title, repo, planDir, author: featureAuthor });
			return Response.json(pf);
		}
		if (url.pathname === "/api/features/auto" && req.method === "POST") {
			const decoded = decodeBody(FeatureAutoBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.goal.trim()) return new Response("goal required", { status: 400 });
			const body = decoded.success;
			const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : body.goal.trim().slice(0, 48);
			const model = typeof body.model === "string" && body.model ? body.model : undefined;
			const { feature, agent } = await manager.createAutoFeature({ title, repo, goal: body.goal.trim(), model, author: featureAuthor });
			return Response.json({ feature, agentId: agent.id });
		}
		const mfpatch = url.pathname.match(/^\/api\/features\/([^/]+)$/);
		if (mfpatch && req.method === "PATCH") {
			const body = decodeBodyOrEmpty(FeaturePatchBodySchema, await req.json().catch(() => null));
			const patch: { title?: string; stageOverride?: FeatureStage | null; category?: FeatureCategory | null; archived?: boolean; repo?: string; description?: string; acceptanceCriteria?: FeatureCriterion[]; decisions?: FeatureDecision[]; relationships?: FeatureRelationship[] } = {};
			if ("repo" in body && typeof body.repo === "string") patch.repo = body.repo;
			if ("title" in body && typeof body.title === "string") patch.title = body.title;
			if ("description" in body && typeof body.description === "string") patch.description = body.description;
			if ("archived" in body && typeof body.archived === "boolean") patch.archived = body.archived;
			if ("stageOverride" in body) patch.stageOverride = typeof body.stageOverride === "string" ? (body.stageOverride as FeatureStage) : null;
			if ("category" in body) patch.category = typeof body.category === "string" ? (body.category as FeatureCategory) : null;
			if ("acceptanceCriteria" in body) patch.acceptanceCriteria = featureCriteria(body.acceptanceCriteria);
			if ("decisions" in body) patch.decisions = featureDecisions(body.decisions);
			if ("relationships" in body) patch.relationships = featureRelationships(body.relationships);
			const pf = await manager.updateFeature(decodeURIComponent(mfpatch[1]), patch);
			return pf ? Response.json(pf) : new Response("no such feature", { status: 404 });
		}
		if (mfpatch && req.method === "DELETE") {
			const repo = url.searchParams.get("repo") ?? undefined;
			const plane = url.searchParams.get("plane") === "detach" ? "detach" : "keep";
			const result = await manager.deleteFeature(decodeURIComponent(mfpatch[1]), { repo, plane });
			return result.deleted ? Response.json(result) : new Response("no such feature", { status: 404 });
		}
		// Human assignees — the substrate for plan voting (a later vote is majority-of-all-assignees).
		// GET is viewer-readable; PUT is admin-only (see restActionTier). Identity validation is
		// mode-aware: DB mode checks each id against the active org's roster; file mode collapses to
		// the single operator identity.
		const mfassign = url.pathname.match(/^\/api\/features\/([^/]+)\/assignees$/);
		if (mfassign && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? undefined;
			const assignees = await manager.featureAssignees(decodeURIComponent(mfassign[1]), repo);
			return assignees ? Response.json({ assignees }) : new Response("no such feature", { status: 404 });
		}
		if (mfassign && req.method === "PUT") {
			const decoded = decodeBody(AssigneesBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("assignees (string[]) required", { status: 400 });
			const requested = [...new Set(decoded.success.assignees)];
			const repo = url.searchParams.get("repo") ?? undefined;
			const orgId = session?.session.activeOrganizationId ?? undefined;
			if (this.dbMode && this.db && orgId) {
				// DB mode: every assignee must be a real member of the caller's active org.
				const unknown = invalidOrgAssignees(requested, await listOrgMembers(this.db.db, orgId));
				if (unknown.length) return new Response(`not org members: ${unknown.join(", ")}`, { status: 400 });
			} else {
				// File mode (or an on-box operator with no org roster): the only valid assignee is the
				// single operator identity — multi-user voting needs DB mode.
				const operatorId = manager.operatorId;
				const unknown = invalidFileAssignees(requested, operatorId);
				if (unknown.length) return new Response(`file mode has a single operator (${operatorId}); multi-user voting needs DB mode`, { status: 400 });
			}
			const pf = await manager.setAssignees(decodeURIComponent(mfassign[1]), requested, repo);
			return pf ? Response.json(pf) : new Response("no such feature", { status: 404 });
		}
		// Plan-vote rounds (PLAN-VOTE-COMMIT.md) — the majority-of-assignees gate a plan-revision
		// candidate must clear before a (later, separate unit's) commit lands it. GET is
		// viewer-readable; call/cast are admin-gated (restActionTier) PLUS an app-layer check that the
		// actor is one of THIS feature's assignees — the vote's real authorization boundary, finer
		// than the coarse role tier (mirrors the /assignees PUT's mode-aware validation above).
		const mfvoteCall = url.pathname.match(/^\/api\/features\/([^/]+)\/plan-vote\/call$/);
		if (mfvoteCall && req.method === "POST") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const featureId = decodeURIComponent(mfvoteCall[1]);
			const feature = (await manager.features(repo)).find((f) => f.id === featureId);
			if (!feature) return new Response("no such feature", { status: 404 });
			const assignees = feature.assignees ?? [];
			// A=0 first: with no assignees the membership check below would ALWAYS 403 (nobody can ever
			// be "in" an empty roster), silently masking the more useful "assign someone first" message.
			// In practice `feature.assignees` is never actually empty (buildFeatures/feature-assignees.ts
			// default a cleared or legacy-missing list back to `[operator]`) — this is defense-in-depth
			// for that invariant, not a reachable path today.
			if (assignees.length === 0) return new Response("assign someone first", { status: 400 });
			// Call-time authz uses the LIVE assignee list — the snapshot is TAKEN here, at call. (Cast
			// authz, by contrast, uses the round's frozen roster — see the cast handler below.) Mode-aware:
			// in file mode a bearer actor IS the single operator (isVoteAssignee, feature-assignees.ts) —
			// otherwise the default-seeded operator identity could never call its own feature's vote.
			if (!isVoteAssignee(actor, assignees, { dbMode: this.dbMode, operatorId: manager.operatorId })) return new Response("only a feature assignee may call a vote", { status: 403 });
			// Fast 409 for the common case; the authoritative, race-proof check-and-open happens
			// atomically inside manager.openPlanVote (per-feature lock) and returns { conflict } below.
			if (await manager.currentPlanVote(repo, featureId)) return new Response("a vote is already open for this feature", { status: 409 });
			const body = decodeBodyOrEmpty(PlanVoteCallBodySchema, await req.json().catch(() => null));
			const candidates = await manager.listPlanRevisionCandidates({ repo, featureId, state: "candidate" });
			const requestedId = typeof body.candidateId === "string" ? body.candidateId : undefined;
			const candidate = requestedId
				? candidates.find((c) => c.id === requestedId)
				: [...candidates].sort((a, b) => b.createdAt - a.createdAt)[0];
			if (!candidate) return new Response(requestedId ? "no such open candidate" : "no head candidate to vote on", { status: 400 });
			const docPath = candidate.planPath;
			const comments = await manager.listComments({ repo, subject: featureId });
			if (!planVoteGateOpen(comments, docPath)) return new Response("unresolved review comments — resolve them before calling a vote", { status: 400 });
			const baseSha = await planDocHeadRevision(repo, docPath);
			// Candidate branch tip — best-effort: a missing/unresolvable producer agent or branch never
			// blocks calling the vote (the collaborative back-and-forth is the point), it just leaves
			// revisionSha "" for the later commit-on-pass unit to notice it has nothing to land.
			let revisionSha = "";
			if (candidate.producerAgentId) {
				const agent = manager.list().find((a) => a.id === candidate.producerAgentId);
				if (agent?.branch) {
					const rev = await hardenedGit(["rev-parse", agent.branch], { cwd: agent.repo || repo });
					if (rev.code === 0) revisionSha = rev.stdout.trim();
				}
			}
			const deadlineMs = typeof body.deadlineMs === "number" ? body.deadlineMs : undefined;
			const opened = await manager.openPlanVote({ featureId, repo, planPath: docPath, candidateId: candidate.id, baseSha, revisionSha, assignees, openedBy: actor.id, deadlineMs }, actor);
			if ("conflict" in opened) return new Response("a vote is already open for this feature", { status: 409 });
			return Response.json({ round: opened, quorum: tallyPlanVoteRound(opened) });
		}
		const mfvoteCast = url.pathname.match(/^\/api\/features\/([^/]+)\/plan-vote\/cast$/);
		if (mfvoteCast && req.method === "POST") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const featureId = decodeURIComponent(mfvoteCast[1]);
			const decoded = decodeBody(PlanVoteCastBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response('roundId and choice ("approve"|"reject") required', { status: 400 });
			const { roundId, choice: rawChoice } = decoded.success;
			const choice = rawChoice === "approve" || rawChoice === "reject" ? rawChoice : undefined;
			if (!choice) return new Response('choice must be "approve" or "reject"', { status: 400 });
			const rounds = await manager.listPlanVoteRounds({ repo, featureId });
			const round = rounds.find((r) => r.id === roundId);
			if (!round) return new Response("no such vote round", { status: 404 });
			// HIGH 2: authorize against the round's CALL-TIME snapshot roster, NOT the live
			// feature.assignees — editing assignees mid-round must not let a non-snapshot actor cast
			// (whom quorum ignores → a stranded round) nor block a snapshot voter. The snapshot is the
			// quorum denominator, so it must also be the cast-authz set. Mode-aware for the same reason
			// as the call handler above: in file mode a bearer actor IS the single operator.
			if (!isVoteAssignee(actor, round.assignees, { dbMode: this.dbMode, operatorId: manager.operatorId })) return new Response("only an assignee of this vote round may cast", { status: 403 });
			if (round.state !== "voting") return new Response(`vote round already ${round.state}`, { status: 409 });
			// The cast is stored (and tallied — computeVoteQuorum keys casts by actorId against
			// round.assignees) under the ASSIGNEE identity, not necessarily the literal bearer id: in file
			// mode isVoteAssignee just authorized this actor as the operator via the operatorId fallback,
			// so recording the cast under the operator's own snapshot-roster id (rather than "web:admin",
			// which is never in round.assignees) is what makes it actually count toward quorum.
			const castActorId = round.assignees.includes(actor.id) ? actor.id : manager.operatorId;
			try {
				const result = await manager.castPlanVote(featureId, roundId, castActorId, choice, actor);
				return Response.json(result);
			} catch (err) {
				// A race between two concurrent casts both observing "voting" above (the round closed in
				// between) is the only realistic way manager.castPlanVote's own locked guards throw here.
				return new Response(errText(err), { status: 409 });
			}
		}
		const mfvoteGet = url.pathname.match(/^\/api\/features\/([^/]+)\/plan-vote$/);
		if (mfvoteGet && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const featureId = decodeURIComponent(mfvoteGet[1]);
			const rounds = await manager.listPlanVoteRounds({ repo, featureId });
			const round = rounds.find((r) => r.state === "voting") ?? rounds[rounds.length - 1];
			return Response.json(round ? { round, quorum: tallyPlanVoteRound(round) } : { round: null, quorum: null });
		}
		const mflink = url.pathname.match(/^\/api\/features\/([^/]+)\/agents$/);
		if (mflink && req.method === "POST") {
			const id = decodeURIComponent(mflink[1]);
			const body = decodeBodyOrEmpty(FeatureAgentsLinkBodySchema, await req.json().catch(() => null));
			if (typeof body.task === "string" && body.task.trim()) {
				const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
				const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
				const feature = await manager.updateFeature(id, { repo });
				if (!feature) return new Response("no such feature", { status: 404 });
				const dto = await manager.create({ repo, name, task: body.task.trim(), featureId: feature.id, approvalMode: "yolo", track: true }, actor);
				manager.linkAgent(feature.id, dto.id);
				return Response.json({ agent: dto });
			}
			if (typeof body.agentId !== "string") return new Response("agentId required", { status: 400 });
			const unlink = body.unlink === true;
			return Response.json({ ok: manager.linkAgent(id, body.agentId, unlink) });
		}
		const mfconcern = url.pathname.match(/^\/api\/features\/([^/]+)\/concerns$/);
		if (mfconcern && req.method === "PATCH") {
			const decoded = decodeBody(FeatureConcernsPatchBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.file.trim()) {
				return new Response("file required", { status: 400 });
			}
			const body = decoded.success;
			const repo = typeof body.repo === "string" && body.repo ? body.repo : undefined;
			const opts: { repo?: string; file: string; status?: string; blockedBy?: number[] } = { repo, file: body.file };
			if ("status" in body && typeof body.status === "string" && body.status.trim()) opts.status = body.status.trim();
			if ("blockedBy" in body && Array.isArray(body.blockedBy)) opts.blockedBy = body.blockedBy.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n));
			if (opts.status === undefined && opts.blockedBy === undefined) return new Response("nothing to update", { status: 400 });
			const concern = await manager.updateConcern(decodeURIComponent(mfconcern[1]), opts, actor);
			return concern ? Response.json({ concern }) : new Response("no such concern", { status: 404 });
		}
		const mfanswer = url.pathname.match(/^\/api\/features\/([^/]+)\/answers$/);
		if (mfanswer && req.method === "POST") {
			const decoded = decodeBody(FeatureAnswersBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.file.trim()) {
				return new Response("file required", { status: 400 });
			}
			const body = decoded.success;
			const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
			const value = typeof body.value === "string" ? body.value.trim() : "";
			if (!prompt || !value) return new Response("prompt and value required", { status: 400 });
			const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const featureId = decodeURIComponent(mfanswer[1]);
			const feature = (await manager.features(repo)).find((x) => x.id === featureId);
			if (!feature || !feature.planDir) return new Response("no such feature", { status: 404 });
			const concernPath = path.join(feature.planDir, path.basename(body.file));
			const concern = await appendConcernDecision(feature.repo, concernPath, `Q: ${prompt} — A: ${value}`);
			if (!concern) return new Response("no such concern", { status: 404 });
			const detail = `${prompt} — ${value}`;
			void manager.recordAudit(actor, "plan-answer", featureId, "ok", detail.length > 80 ? `${detail.slice(0, 79)}…` : detail);
			return Response.json({ concern });
		}
		if (url.pathname === "/api/federation/capabilities") return Response.json({ capabilities: manager.capabilityFederation() });
		if (url.pathname === "/api/capability-discovery") return Response.json({ name: "omp-squad capabilities", routes: ["/api/capability-catalog", "/api/capability-sources", "/api/capability-packs", "/api/capability-installs", "/api/federation/capabilities"], privateTenantData: false });
		const mfland = url.pathname.match(/^\/api\/features\/([^/]+)\/land$/);
		if (mfland && req.method === "POST") {
			const body = decodeBodyOrEmpty(FeatureLandBodySchema, await req.json().catch(() => null));
			const force = body.force === true;
			const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;
			return Response.json(await manager.landFeature(decodeURIComponent(mfland[1]), force, actor, reason));
		}
		const mftickets = url.pathname.match(/^\/api\/features\/([^/]+)\/tickets$/);
		if (mftickets && req.method === "GET") return Response.json(await withTimeout(manager.featurePlaneTickets(decodeURIComponent(mftickets[1])), 1500, { tickets: null }));
		const mfmodule = url.pathname.match(/^\/api\/features\/([^/]+)\/module$/);
		if (mfmodule && req.method === "POST") {
			const body = decodeBodyOrEmpty(FeatureModuleBodySchema, await req.json().catch(() => null));
			const repo = typeof body.repo === "string" && body.repo ? body.repo : undefined;
			const createTickets = body.tickets === true;
			const out = await manager.createFeatureModule(decodeURIComponent(mfmodule[1]), { repo, createTickets });
			return out ? Response.json(out) : new Response("module create failed (Plane not configured?)", { status: 501 });
		}
		const mfmoduleRepair = url.pathname.match(/^\/api\/features\/([^/]+)\/module\/repair$/);
		if (mfmoduleRepair && req.method === "POST") {
			const body = decodeBodyOrEmpty(FeatureModuleRepairBodySchema, await req.json().catch(() => null));
			const repo = typeof body.repo === "string" && body.repo ? body.repo : undefined;
			const closeOrphans = body.closeOrphans === true;
			const out = await manager.repairFeatureModuleTickets(decodeURIComponent(mfmoduleRepair[1]), { repo, closeOrphans });
			return out ? Response.json(out) : new Response("module repair failed (Plane not configured?)", { status: 501 });
		}
		const mfpipe = url.pathname.match(/^\/api\/features\/([^/]+)\/pipeline$/);
		if (mfpipe && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const list = await manager.features(repo);
			const f = list.find((x) => x.id === decodeURIComponent(mfpipe[1]));
			if (!f) return new Response("no such feature", { status: 404 });
			const concerns = f.planDir ? await parsePlanConcerns(f.repo, f.planDir) : [];
			const documents = f.planDir ? await parsePlanDocuments(f.repo, f.planDir) : [];
			const ids = f.issueIdentifiers;
			let issues: IssueRef[] = [];
			if (ids && ids.length) {
				const planeIssues = await withTimeout(listPlaneIssues(f.repo), 1500, null);
				if (planeIssues) issues = planeIssues.filter((i) => i.identifier !== undefined && ids.includes(i.identifier));
			}
			const comments = await manager.listComments({ repo: f.repo, subject: f.id });
			const candidates = await manager.listPlanRevisionCandidates({ repo: f.repo, featureId: f.id });
			return Response.json({ feature: f, readiness: f.readiness, concerns, documents, issues, comments, candidates, agentIds: f.agentIds });
		}
		// Wave 4 X2 (task-pipeline artifacts rail): read-only, viewer-tier by the same blanket default
		// as every other GET here (see restActionTier in authz.ts) — no per-route auth code needed.
		// org-scoped via `manager` (managerFor(actor)), same as the pipeline route above.
		const mfproof = url.pathname.match(/^\/api\/features\/([^/]+)\/done-proof$/);
		if (mfproof && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const doneProof = await manager.doneProofForFeature(decodeURIComponent(mfproof[1]), repo);
			return Response.json({ doneProof: doneProof ?? null });
		}
		if (url.pathname === "/api/info") return Response.json({ cwd: process.cwd() });
		const mcand = url.pathname.match(/^\/api\/features\/([^/]+)\/plan-candidates$/);
		if (mcand && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			return Response.json(await manager.listPlanRevisionCandidates({ repo, featureId: decodeURIComponent(mcand[1]) }));
		}
		if (mcand && req.method === "POST") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const featureId = decodeURIComponent(mcand[1]);
			const decoded = decodeBody(PlanCandidateCreateBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.planPath.trim() || !decoded.success.summary.trim()) {
				return new Response("planPath and summary required", { status: 400 });
			}
			const rec = decoded.success;
			const planPath = rec.planPath.trim();
			const summary = rec.summary.trim();
			// KEYSTONE gate (security review HIGH 1a — reject at the source): a candidate's planPath is
			// what a PASSED plan-vote later commits into the shared checkout, bypassing the code-land gate.
			// Constrain it to plan MARKDOWN under plans/ HERE so a candidate naming, e.g., "src/server.ts"
			// or "package.json" can never be created. onVotePassed re-validates the same rule immediately
			// before committing (defense in depth).
			if (!isPlanDocPath(planPath)) return new Response("planPath must be a plan markdown doc under plans/ (e.g. plans/foo/01-bar.md)", { status: 400 });
			return Response.json(await manager.addPlanRevisionCandidate({ repo, featureId, planPath, summary, producerAgentId: typeof rec.producerAgentId === "string" ? rec.producerAgentId : undefined, runId: typeof rec.runId === "string" ? rec.runId : undefined, traceId: typeof rec.traceId === "string" ? rec.traceId : undefined, diffRef: typeof rec.diffRef === "string" ? rec.diffRef : undefined }, actor));
		}
		const mcandState = url.pathname.match(/^\/api\/features\/([^/]+)\/plan-candidates\/([^/]+)\/(accept|reject|supersede)$/);
		if (mcandState && req.method === "POST") {
			const body = decodeBodyOrEmpty(PlanCandidateTransitionBodySchema, await req.json().catch(() => null));
			const reason = typeof body.reason === "string" ? body.reason : undefined;
			const state = ({ accept: "accepted", reject: "rejected", supersede: "superseded" } as Record<string, PlanRevisionCandidateState>)[mcandState[3]];
			const candidate = await manager.transitionPlanRevisionCandidate(decodeURIComponent(mcandState[2]), state, actor, reason);
			return candidate ? Response.json(candidate) : new Response("candidate not found", { status: 404 });
		}
		const mann = url.pathname.match(/^\/api\/features\/([^/]+)\/annotations$/);
		if (mann && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const featureId = decodeURIComponent(mann[1]);
			const comments = await manager.listComments({ repo, subject: featureId });
			return Response.json(comments.filter((comment) => comment.kind === "plan-annotation" && comment.annotation));
		}
		if (mann && req.method === "POST") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const featureId = decodeURIComponent(mann[1]);
			const body = decodeBodyOrEmpty(AnnotationCreateBodySchema, await req.json().catch(() => null));
			const text = typeof body.body === "string" ? body.body.trim() : "";
			const annotation = planAnnotationTarget(body);
			if (!text || !annotation) return new Response("body and planPath required", { status: 400 });
			const feature = (await manager.features(repo)).find((x) => x.id === featureId);
			if (!feature) return new Response("no such feature", { status: 404 });
			return Response.json(await manager.addComment({ repo, subject: featureId, body: text, kind: "plan-annotation", annotation }, actor));
		}
		const mannr = url.pathname.match(/^\/api\/features\/([^/]+)\/annotations\/([^/]+)\/resolve$/);
		if (mannr && req.method === "POST") {
			await manager.resolveComment(decodeURIComponent(mannr[2]), actor);
			return Response.json({ ok: true });
		}
		const manns = url.pathname.match(/^\/api\/features\/([^/]+)\/annotations\/([^/]+)\/send$/);
		if (manns && req.method === "POST") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const featureId = decodeURIComponent(manns[1]);
			const annotationId = decodeURIComponent(manns[2]);
			const body = decodeBodyOrEmpty(AnnotationSendBodySchema, await req.json().catch(() => null));
			const mode = body.mode === "agent" ? "agent" : "planner";
			const feature = (await manager.features(repo)).find((x) => x.id === featureId);
			if (!feature) return new Response("no such feature", { status: 404 });
			const comment = (await manager.listComments({ repo, subject: featureId })).find((item) => item.id === annotationId);
			if (!comment || comment.kind !== "plan-annotation") return new Response("annotation not found", { status: 404 });
			const message = planAnnotationPrompt(feature, comment);
			if (mode === "agent") {
				const agentId = typeof body.agentId === "string" ? body.agentId : "";
				if (!agentId) return new Response("agentId required", { status: 400 });
				await manager.applyCommand({ type: "prompt", id: agentId, message }, actor);
				return Response.json({ agentId, mode });
			}
			// Live incident (exit-classification bug, fixed in squad-manager.ts's wire() exit handler): a
			// plan-reviser turn completing and its ACP process tearing down via SIGTERM looked identical to a
			// crash, surfacing as an "errored"/"needs you" row with an apparently empty Changes panel. The
			// SECOND half of that symptom is not a bug: this agent's own worktree diff (the per-agent
			// Land/Changes tab) is CORRECTLY empty of anything landable — a plan-doc revision never goes
			// through the normal git-merge Land flow. It deliberately stays UNCOMMITTED: the product design is
			// a collaborative back-and-forth, then a majority vote of the plan's assignees, and only a
			// passing vote commits (that vote→commit step is a separate, incoming feature — not built here).
			// The real legibility surface for "plan updated, awaiting review" already exists below —
			// `addPlanRevisionCandidate` registers a `state: "candidate"` row the instant this fires, rendered
			// by ProofProvenancePanel's "Plan revision candidates" list (labeled "pending review" there) —
			// so a completed plan-reviser turn was already visible there the whole time; only the false
			// "errored" status (now fixed) made it look broken.
			const dto = await manager.create({ repo, name: "plan-reviser", task: message, featureId, approvalMode: "write", autoRoute: false, track: true, owns: feature.planDir ? [feature.planDir] : undefined }, actor);
			await manager.addPlanRevisionCandidate({ repo, featureId, planPath: comment.annotation?.planPath ?? feature.planDir ?? "plans", producerAgentId: dto.id, summary: comment.body, diffRef: comment.annotation?.planPath }, actor);
			return Response.json({ agentId: dto.id, mode });
		}
		// Single plan-doc read + revision diff, for the design-review screen (/review/:taskId in the
		// webapp): a path-guarded read of one markdown file plus its git history, so the client can
		// render "changed since your last view" without pulling the whole feature pipeline payload.
		if (url.pathname === "/api/plan-doc" && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const docPath = url.searchParams.get("path") ?? "";
			if (!docPath.trim()) return new Response("path required", { status: 400 });
			const doc = await readPlanDoc(repo, docPath);
			return doc ? Response.json(doc) : new Response("no such doc", { status: 404 });
		}
		if (url.pathname === "/api/plan-doc/diff" && req.method === "GET") {
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const docPath = url.searchParams.get("path") ?? "";
			const since = url.searchParams.get("since") ?? "";
			if (!docPath.trim()) return new Response("path required", { status: 400 });
			if (!since.trim()) return new Response("since required", { status: 400 });
			return Response.json(await planDocDiffSince(repo, docPath, since));
		}
		if (url.pathname === "/api/version") return Response.json({ version: this.uiVersion });
		// /api/health and the rest of the graph/usage/heat/activity/action-items/governance observability
		// family are handled by handleObservability (above, before the `!manager` gate) — see its doc.
		if (url.pathname === "/api/presence") {
			// risk #6: the global presence registry is machine-wide; never serve it in DB-registry mode.
			if (this.registry) return Response.json([]);
			const repo = url.searchParams.get("repo");
			return Response.json(repo ? await who(repo) : await all());
		}
		// /api/leases and the rest of the fabric/audit/automation/metrics-learning-loop observability
		// family are handled by handleObservability (above, before the `!manager` gate) — see its doc.
		if (url.pathname === "/api/opportunities") {
			const repos = url.searchParams.get("repo") ? [url.searchParams.get("repo") as string] : (planeRepos().length ? planeRepos() : manager.projects().map((p) => p.repo));
			const issues = (await Promise.all(repos.map((repo) => listPlaneIssues(repo).catch(() => null)))).flatMap((x) => x ?? []);
			return Response.json(issues.filter((i) => i.name.includes("[opportunity]")));
		}
		if (url.pathname === "/api/federation") return Response.json(this.federationSnapshot(manager));
		if (url.pathname === "/api/federation/command" && req.method === "POST") {
			// Outbound remote steering: send a ClientCommand to a peer operator's daemon. The
			// local manager gates on operator tier; the RECEIVER re-authorizes independently
			// (whois-verified actor + RBAC), so this can never grant authority it doesn't have.
			const rec = decodeBodyOrEmpty(FederationCommandBodySchema, await req.json().catch(() => null));
			const to = typeof rec.to === "string" ? rec.to.trim() : "";
			const cmd = rec.cmd && typeof rec.cmd === "object" && typeof (rec.cmd as Record<string, unknown>).type === "string" ? (rec.cmd as ClientCommand) : undefined;
			if (!to || !cmd) return new Response("to (operator id) and cmd ({type,...}) required", { status: 400 });
			try {
				const cmdId = manager.sendFederationCommand(to, cmd, actor);
				// Best-effort outcome: wait briefly for the peer's ack. null ⇒ sent, no ack
				// (peer offline / older version) — the send itself still succeeded.
				const ack = await manager.waitForAck(cmdId);
				return Response.json({ ok: true, sent: cmd.type, to, cmdId, ack });
			} catch (err) {
				if (err instanceof RbacDenied) return new Response(err.message, { status: 403 });
				return new Response(err instanceof Error ? err.message : String(err), { status: 400 });
			}
		}
		if (url.pathname === "/api/factory/status") {
			// First-glance liveness: per autonomous loop, whether it's flag-enabled, actually armed, the
			// reason it didn't arm (the authoritative no-backlog gate), heartbeat freshness, and a status
			// enum (moving|idle|not-armed|off). Makes an idle-but-alive fleet legibly different from a dead one.
			return Response.json(manager.factoryStatus());
		}
		const mtrace = url.pathname.match(/^\/api\/trace\/([^/]+)$/);
		if (mtrace && req.method === "GET") {
			const trace = await tracePayload(manager, decodeURIComponent(mtrace[1]));
			if (trace.receipts.length === 0 && trace.root.children.length === 0) return new Response("trace not found", { status: 404 });
			return Response.json(trace);
		}
		// D3: the reachable reasoning/IO a trace node's `attrs.digest` links to — compact, already
		// fenced/redacted markdown (src/digest.ts), never raw prompts/outputs. Read-only + non-sensitive,
		// so no extra RBAC beyond this block's existing auth gate.
		const mdigest = url.pathname.match(/^\/api\/digest\/([^/]+)$/);
		if (mdigest && req.method === "GET") {
			const digestId = decodeURIComponent(mdigest[1]);
			// The id becomes `<stateDir>/digests/<id>.md` (src/digest.ts) — reject any id that could escape
			// that dir (`..`, path separators via %2F) before it touches the filesystem. Agent ids are
			// always plain `[A-Za-z0-9._-]`, so a stricter allowlist is safe and closes the traversal.
			if (!/^[A-Za-z0-9._-]+$/.test(digestId) || digestId.includes("..")) return new Response("invalid digest id", { status: 400 });
			const md = await manager.getDigest(digestId);
			if (!md) return new Response("digest not found", { status: 404 });
			return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
		}
		if (url.pathname === "/api/spawn" && req.method === "POST") {
			const decoded = decodeBody(SpawnBodySchema, await req.json().catch(() => null));
			const prompt = Result.isSuccess(decoded) ? decoded.success.prompt.trim() : "";
			if (prompt.length === 0) return new Response("empty prompt", { status: 400 });
			const profileId = Result.isSuccess(decoded) && typeof decoded.success.profileId === "string" ? decoded.success.profileId : undefined;
			const tracked = manager.projects().map((p) => p.repo);
			// research-sirvir/03 (dead-wire fix): feed the outcome-driven model shift from THIS request's
			// resolved `manager` — never a bare `resolveStateDir()`, which in DB mode returns the global
			// root and would read another tenant's (or an empty) ledger instead of `manager`'s own private
			// `stateDir`. Gated the same way `shiftedModel` itself is, so the scoreboard's receipts scan is
			// skipped entirely (not just ignored) when the feature is off.
			const scoreboard = envBool("OMP_SQUAD_MODEL_OUTCOMES", false) ? await manager.spawnScoreboard() : undefined;
			const plan = await planSpawn(prompt, { cwd: process.cwd(), candidates: discoverRepos(process.cwd(), tracked), scoreboard });
			try {
				const dto = await manager.create({ ...plan, profileId, track: true }, actor);
				return Response.json({ agent: dto, plan });
			} catch (err) {
				return new Response(err instanceof Error ? err.message : String(err), { status: 409 });
			}
		}
		if (url.pathname === "/api/console" && req.method === "POST") {
			const body = decodeBodyOrEmpty(ConsoleBodySchema, await req.json().catch(() => null));
			const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
			const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
			const dto = await manager.create({ repo, name: "chat", model, profileId, autoRoute: false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT }, actor);
			return Response.json({ agentId: dto.id });
		}
		// Feature 2 D2 (CANVAS-AND-PAGE-CHAT.md): a pasted/dropped/captured/annotated chat image
		// persists here as a chat ARTIFACT (org-scoped by `manager`, size/PNG-magic-validated in
		// chat-attachment.ts) — the composer then folds its returned `path` into the outgoing prompt
		// text as a fenced untrusted-data reference, since neither /api/console nor the prompt
		// command carry an inline image channel today (see chat-attachment.ts's header comment).
		if (url.pathname === "/api/chat-attachments" && req.method === "POST") {
			const decoded = decodeBody(ChatAttachmentCreateBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("dataUrl required", { status: 400 });
			try {
				const saved = await manager.saveChatAttachment(decoded.success.dataUrl);
				return Response.json(saved);
			} catch (err) {
				// MEDIUM 1 (disk-fill quota) and MEDIUM 2 (IHDR dimension bomb) — both are resource
				// rejections, not shape/mime validation, so both surface as 413 rather than the generic
				// 400 every other malformed-payload error on this route returns.
				if (err instanceof ChatAttachmentQuotaExceededError || err instanceof ChatAttachmentDimensionError) {
					return new Response(err.message, { status: 413 });
				}
				// errText, not the inline ternary — this is the one site the effect-migration ratchet's
				// error-message-idiom baseline doesn't already budget for on this branch (see err-text.ts).
				return new Response(errText(err), { status: 400 });
			}
		}
		const mattachment = url.pathname.match(/^\/api\/chat-attachments\/([^/]+)$/);
		if (mattachment && req.method === "GET") {
			const bytes = await manager.getChatAttachment(decodeURIComponent(mattachment[1]));
			if (!bytes) return new Response("not found", { status: 404 });
			return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" } });
		}
		const mt = url.pathname.match(/^\/api\/agents\/([^/]+)\/transcript$/);
		if (mt) return Response.json(manager.getTranscript(decodeURIComponent(mt[1])));
		const mtrans = url.pathname.match(/^\/api\/agents\/([^/]+)\/transitions$/);
		if (mtrans) {
			const full = url.searchParams.get("full") === "1";
			return Response.json(await manager.transitionHistory(decodeURIComponent(mtrans[1]), { full }));
		}
		const msub = url.pathname.match(/^\/api\/agents\/([^/]+)\/subagents$/);
		if (msub) return Response.json(manager.subagents(decodeURIComponent(msub[1])));
		const mrec = url.pathname.match(/^\/api\/agents\/([^/]+)\/receipts$/);
		if (mrec) return Response.json(await manager.receipts(decodeURIComponent(mrec[1])));
		// Read-only checkpoint history for the fork-step picker; never includes `vars` (see
		// SquadManager.checkpoints's doc comment).
		const mchk = url.pathname.match(/^\/api\/agents\/([^/]+)\/checkpoints$/);
		if (mchk) return Response.json(await manager.checkpoints(decodeURIComponent(mchk[1])));
		const mcmd = url.pathname.match(/^\/api\/agents\/([^/]+)\/commands$/);
		if (mcmd) return Response.json(manager.commandsFor(decodeURIComponent(mcmd[1])) ?? []);
		const mdiff = url.pathname.match(/^\/api\/agents\/([^/]+)\/(diff|tree)$/);
		if (mdiff) {
			const dto = manager.getAgent(decodeURIComponent(mdiff[1]));
			if (!dto) return new Response("no such agent", { status: 404 });
			return Response.json(mdiff[2] === "diff" ? await worktreeDiffSinceFork(dto.worktree) : await worktreeTree(dto.worktree));
		}
		const mland = url.pathname.match(/^\/api\/agents\/([^/]+)\/land$/);
		if (mland && req.method === "POST") {
			const id = decodeURIComponent(mland[1]);
			const dto = manager.getAgent(id);
			if (!dto) return new Response("no such agent", { status: 404 });
			let message = `squad(${dto.name}): ${dto.issue?.name ?? "agent changes"}`;
			const body = decodeBodyOrEmpty(AgentLandBodySchema, await req.json().catch(() => null));
			const force = body.force === true;
			const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;
			if (typeof body.message === "string" && body.message.trim()) {
				message = body.message.trim();
			}
			const result = await manager.land(id, message, { auto: false, force, reason, actor });
			return Response.json(result, { status: result.ok ? 200 : 409 });
		}
		const mverify = url.pathname.match(/^\/api\/agents\/([^/]+)\/verify$/);
		if (mverify && req.method === "POST") {
			const id = decodeURIComponent(mverify[1]);
			const dto = manager.getAgent(id);
			if (!dto) return new Response("no such agent", { status: 404 });
			try {
				const ok = await manager.verifyAgentWork(id, actor);
				return Response.json({ ok });
			} catch (err) {
				return new Response(err instanceof Error ? err.message : String(err), { status: 409 });
			}
		}
		const mmode = url.pathname.match(/^\/api\/agents\/([^/]+)\/mode$/);
		if (mmode && req.method === "POST") {
			const body = decodeBodyOrEmpty(AgentModeBodySchema, await req.json().catch(() => null));
			const mode = validateRequestedMode(body.mode);
			if (!mode) return new Response("invalid mode", { status: 400 });
			const reason = typeof body.reason === "string" ? body.reason : undefined;
			const dto = await manager.transitionMode(decodeURIComponent(mmode[1]), mode, actor, reason);
			if (!dto) return new Response("no such agent", { status: 404 });
			return Response.json(dto);
		}
		const mvision = url.pathname.match(/^\/api\/agents\/([^/]+)\/vision$/);
		if (mvision && req.method === "POST") {
			const dto = manager.getAgent(decodeURIComponent(mvision[1]));
			if (!dto) return new Response("no such agent", { status: 404 });
			const body = decodeBodyOrEmpty(AgentVisionBodySchema, await req.json().catch(() => null));
			const target = typeof body.url === "string" && body.url.trim() ? body.url.trim() : process.env.OMP_SQUAD_APP_URL;
			if (!target) return new Response("no url for vision — pass {url} or set OMP_SQUAD_APP_URL", { status: 422 });
			// SSRF guard (OMPSQ-152): the daemon's browser must not be aimed at private/loopback/metadata
			// targets. Only http(s) public hosts pass; the operator's OMP_SQUAD_APP_URL origin is allowlisted.
			const checked = await checkVisionUrl(target);
			if (!checked.ok) return new Response(`refusing vision target: ${checked.reason}`, { status: 400 });
			// Evidence only: returns the artifact paths the pass captured; it never gates a land.
			return Response.json({ artifacts: await runVisionPass({ worktree: dto.worktree, url: checked.url.href }) });
		}
		const mfverify = url.pathname.match(/^\/api\/features\/([^/]+)\/verify$/);
		if (mfverify && req.method === "POST") {
			const out = await manager.verifyFeature(decodeURIComponent(mfverify[1]));
			return out ? Response.json(out) : new Response("no such feature", { status: 404 });
		}
		if (url.pathname === "/api/plane/issues") {
			const issues = await listPlaneIssues(url.searchParams.get("project") ?? "");
			if (issues === null) return new Response("plane not configured", { status: 501 });
			return Response.json(issues);
		}
		const mstart = url.pathname.match(/^\/api\/tasks\/([^/]+)\/start$/);
		if (mstart && req.method === "POST") {
			const id = decodeURIComponent(mstart[1]);
			if (!id) return new Response("task id required", { status: 400 });
			const body = decodeBodyOrEmpty(TaskStartBodySchema, await req.json().catch(() => null));
			const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const issues = await listPlaneIssues(repo);
			if (issues === null) return new Response("plane not configured", { status: 501 });
			const issue = issues.find((i) => i.id === id);
			if (!issue) return new Response("issue not found or not open", { status: 404 });
			const dto = await manager.startTask(repo, issue, actor);
			return Response.json({ agentId: dto.id });
		}
		if (url.pathname.startsWith("/api/tasks/")) {
			const id = decodeURIComponent(url.pathname.slice("/api/tasks/".length));
			if (!id) return new Response("task id required", { status: 400 });
			const detail = await fetchIssueDetail(url.searchParams.get("repo") ?? process.cwd(), id);
			if (detail === null) return new Response("plane not configured", { status: 501 });
			return Response.json(detail);
		}
		if (url.pathname === "/api/comments" && req.method === "GET") {
			const subject = url.searchParams.get("subject") ?? "";
			if (!subject) return new Response("subject required", { status: 400 });
			const repo = url.searchParams.get("repo") ?? process.cwd();
			const unresolved = url.searchParams.get("unresolved") === "1";
			return Response.json(await manager.listComments({ repo, subject, unresolved }));
		}
		if (url.pathname === "/api/comments" && req.method === "POST") {
			const decoded = decodeBody(CommentsCreateBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.subject || !decoded.success.body.trim()) {
				return new Response("subject and body required", { status: 400 });
			}
			const body = decoded.success;
			const repo = typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const urgent = body.urgent === true;
			return Response.json(await manager.addComment({ repo, subject: body.subject, body: body.body.trim(), urgent }, actor));
		}
		const mresolve = url.pathname.match(/^\/api\/comments\/([^/]+)\/resolve$/);
		if (mresolve && req.method === "POST") {
			await manager.resolveComment(decodeURIComponent(mresolve[1]), actor);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/upgrade/status") return Response.json(await gitState(process.cwd()));
		if (url.pathname === "/api/upgrade" && req.method === "POST") {
			const repo = process.cwd();
			const pull = await pullLatest(repo);
			const after = await gitState(repo);
			// Detach agents (their hosts survive), free the port, and re-exec — the
			// relaunched daemon reconnects to the live agents with full context.
			setTimeout(() => {
				void (async () => {
					if (this.registry) await this.registry.stopAll();
					else await manager.stop();
					this.server?.stop(true);
					reexecDaemon({ cmd: process.argv, cwd: repo });
					process.exit(0);
				})();
			}, 300);
			return Response.json({ ok: true, pull, git: after, restarting: true });
		}
		if (url.pathname === "/api/command" && req.method === "POST") {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return new Response("bad json", { status: 400 });
			}
			const decoded = decodeClientCommand(body);
			if (Result.isFailure(decoded)) return new Response(`bad command: ${decoded.failure.message}`, { status: 400 });
			const cmd = decoded.success;
			if (cmd.type === "create") {
				const dto = await manager.create({ ...cmd.options, track: true }, actor);
				return Response.json(dto);
			}
			if (cmd.type === "commission") {
				const result = await manager.commission(cmd.spec, { install: true }, actor);
				return Response.json(result);
			}
			// Bootstrap-admin cross-manager routing (rm-doesn't-stick, layer 3): `manager` above is always
			// the root factory for this identity (`fleetForOrg`'s hard-coded `ROOT_FACTORY_ORG`), which is
			// wrong for a command naming an agent that actually lives on a different org's live manager.
			// `resolveCommandManager` is a no-op (returns `manager` unchanged) for every non-bootstrap-admin
			// caller — tenant sessions stay exactly as confined as before.
			const owner = this.resolveCommandManager(cmd, bootstrapAdmin, manager);
			if (!owner) return new Response("agent not found", { status: 404 });
			// kill/restart/remove are admin-tier (commandTier); applyCommand is the single authority.
			// Surface its denial as 403 here (the WS handler swallows the same throw) — not a 2nd authz site.
			try {
				await owner.applyCommand(cmd, actor);
			} catch (err) {
				if (err instanceof RbacDenied) return new Response("forbidden", { status: 403 });
				throw err;
			}
			return Response.json({ ok: true });
		}
		return new Response("not found", { status: 404 });
	}

	private broadcast(e: SquadEvent): void {
		// Stamp the live UI version onto roster snapshots (manager-emitted ones leave it blank).
		const s = JSON.stringify(e.type === "roster" ? { ...e, version: this.uiVersion } : e);
		for (const ws of this.clients) {
			try {
				ws.send(s);
			} catch {
				/* dropped client */
			}
		}
		this.maybePushAlert(e);
		if (e.type === "agent" || e.type === "removed" || e.type === "roster") this.schedulePresence();
	}

	/** DB-registry per-org fan-out: serialize once, deliver only to that org's sockets (risk #3).
	 *  Background push + global presence are file-mode-only, so neither fires here. */
	private broadcastTo(orgId: string, e: SquadEvent): void {
		const bucket = this.clientsByOrg.get(orgId);
		if (!bucket) return;
		const s = JSON.stringify(e.type === "roster" ? { ...e, version: this.uiVersion } : e);
		for (const ws of bucket) {
			try {
				ws.send(s);
			} catch {
				/* dropped client */
			}
		}
	}

	/** Fire a background push when an agent transitions into a state that needs a human. Mirrors the
	 *  client's seed-then-notify guard so a reconnect/roster replay never alerts in bulk. */
	private maybePushAlert(e: SquadEvent): void {
		const push = this.opts.push;
		if (!push) return;
		if (e.type === "roster") {
			for (const a of e.agents) this.lastStatus.set(a.id, a.status);
			this.pushSeeded = true;
			return;
		}
		if (e.type !== "agent") return;
		const a = e.agent;
		const prev = this.lastStatus.get(a.id);
		this.lastStatus.set(a.id, a.status);
		const payload = escalationPayload(prev, a, this.pushSeeded);
		if (!payload) return;
		const now = Date.now();
		if (now - (this.lastPush.get(a.id) ?? 0) < 3000) return;
		this.lastPush.set(a.id, now);
		void push.notify(payload);
	}

	private schedulePresence(): void {
		if (this.presenceDebounce) return;
		this.presenceDebounce = setTimeout(() => {
			this.presenceDebounce = undefined;
			void this.syncPresence();
		}, 1500);
		this.presenceDebounce.unref?.();
	}

	/** Mirror live squad agents into the shared presence registry so `who` + the command center see them next to raw omp sessions. */
	private async syncPresence(): Promise<void> {
		if (!this.singleManager) return;
		const liveIds = new Set<string>();
		for (const a of this.singleManager.list()) {
			liveIds.add(a.id);
			this.claimed.set(a.id, a.repo);
			await claim({ repo: a.repo, agent: a.name, branch: a.branch, task: a.issue?.name ?? a.activity, source: "squad", id: a.id, reattached: this.startupAgentIds.has(a.id) });
		}
		for (const [id, repo] of this.claimed) {
			if (!liveIds.has(id)) {
				await release(id, repo);
				this.claimed.delete(id);
			}
		}
	}

	/**
	 * Roster-of-rosters for the command center: this host's live roster merged
	 * with any peer rosters gathered off the coordinator, plus cross-operator
	 * branch collisions. Single-host with no peers returns the LOCAL operator's own
	 * presence (its live agents) — never empty, never an error.
	 *
	 * Single-manager / file mode: self = the root manager's roster, peers = the
	 * coordinator feed (absent ⇒ self only). DB-registry mode: self = the calling
	 * org's manager roster; there's no global federation bus per org, so peers stay
	 * empty (`coordinator: null`), but the org still sees its OWN operators/agents
	 * instead of a blanket-empty payload (and never another org's).
	 */
	private federationSnapshot(manager: SquadManager): FederationSnapshot {
		const self: OperatorPresence = {
			operator: this.operator,
			availability: "active",
			host: os.hostname(),
			agents: manager.list(),
			updatedAt: Date.now(),
		};
		// DB-registry mode has no per-org coordinator feed; only single-manager mode gossips peers.
		// Peers come from the manager's OWN bus roster (SEAM 2) — no separate socket in the server.
		const peers = this.registry ? [] : manager.peerPresence();
		const coordinator = this.registry ? null : this.coordinator;
		return { coordinator, ...federationView(self, peers) };
	}

	/**
	 * DB-registry mode lease scope: leases for repos the calling org's fleet actually works on.
	 * The on-disk lease registry is machine-wide (keyed by cross-host repo identity), so we must
	 * NOT serve it wholesale in a multi-tenant daemon — that would leak another org's leases. We
	 * instead derive the repo set from this org manager's live agents and union in an explicit
	 * `?repo=` only when that org has an agent on it. Empty fleet ⇒ no repos ⇒ no leases.
	 */
	private async orgScopedLeases(manager: SquadManager, repo: string | null): Promise<LeaseEntry[]> {
		const orgRepos = new Set(manager.list().map((a) => a.repo));
		const repos = repo ? (orgRepos.has(repo) ? [repo] : []) : [...orgRepos];
		const seen = new Set<string>();
		const out: LeaseEntry[] = [];
		for (const r of repos) {
			for (const lease of await leasesFor(r).catch(() => [])) {
				const key = `${lease.repo} ${lease.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(lease);
			}
		}
		return out;
	}

	/** Same "must not lie by omission" bar as usagePayload/heatPayload: a bootstrap-admin's break-
	 *  glass array can be several live org managers, so union each one's own org-scoped leases
	 *  rather than reading only the single (possibly wrong/absent) `manager`. A tenant session's
	 *  array is always its own 1 manager (see `observabilityManagers`), so this is a no-op union. */
	private async orgScopedLeasesAcross(managers: SquadManager[], repo: string | null): Promise<LeaseEntry[]> {
		const perManager = await Promise.all(managers.map((m) => this.orgScopedLeases(m, repo)));
		const seen = new Set<string>();
		const out: LeaseEntry[] = [];
		for (const list of perManager) {
			for (const lease of list) {
				const key = `${lease.repo} ${lease.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(lease);
			}
		}
		return out;
	}

	stop(): void {
		this.singleManager?.off("event", this.onEvent);
		if (this.registry) this.registry.onEvent = () => {};
		clearInterval(this.presenceTimer);
		clearTimeout(this.presenceDebounce);
		for (const [id, repo] of this.claimed) void release(id, repo);
		this.claimed.clear();
		this.server?.stop(true);
	}
}

/**
 * Per-runId trace cache: `manager.trace()` scans EVERY receipt on disk (`readAllReceipts`), which is
 * fine for an occasional click but not for one wired raw behind a fast poll. A finalized run's trace
 * never changes, so once every receipt in its tree has `endedAt` set, the response is cached; a run
 * still in flight (any receipt missing `endedAt`) is recomputed every call — that scan is cheap (one
 * active run's worth of receipts), so correctness costs nothing there.
 *
 * Scoped PER MANAGER (topology review finding 1): a bare module-level `Map<traceId, …>` would be
 * shared across every `SquadManager` instance in the process — in DB-registry mode each org gets its
 * own manager, so a shared cache would serve org A's cached receipts/costs/spans to org B on a
 * colliding trace id (and the root-factory manager would leak into every org, and vice versa). Keying
 * by the manager INSTANCE (a `WeakMap`) makes that structurally impossible — manager A's entries live
 * in manager A's Map, full stop — and needs no explicit org/manager-id plumbing since the same
 * long-lived manager instance already IS the isolation boundary (ManagerRegistry, ManagerRegistry.md).
 *
 * No receipt-count invalidation: `readAllReceipts` always does a full directory scan regardless of
 * `id`, so a cheap "has this trace grown?" check doesn't exist — computing it costs the same as
 * recomputing the trace outright. Instead of trusting the TTL alone (finding 2: a re-dispatched
 * feature's new run could otherwise stay invisible under a stale-but-unexpired `feat:<id>` cache hit
 * for up to `TRACE_CACHE_TTL_MS`), a hit is cheaply re-validated against the manager's live in-memory
 * roster (`manager.list()` — no disk I/O): if any roster entry shares the cached feature id and started
 * AFTER the entry was cached, a new run has begun under that feature and the hit is treated as a miss.
 *
 * Bounded two ways so distinct, never-repeated trace ids (a click-through of many one-off runs)
 * can't grow a manager's cache forever: `sweepExpiredTraceCache` runs on every insert (the map is
 * small — O(cache size), cheap next to the trace scan that just ran) evicting every TTL-expired entry,
 * not just the requested id; and `TRACE_CACHE_MAX` FIFO-evicts the oldest-inserted entry (Map iteration
 * order = insertion order) once the sweep still leaves that manager's cache at capacity.
 */
type TraceCache = Map<string, { at: number; response: TraceResponse }>;
const traceCachesByManager = new WeakMap<SquadManager, TraceCache>();
export const TRACE_CACHE_TTL_MS = 30_000;
export const TRACE_CACHE_MAX = 200;

/** The manager-scoped cache Map, lazily created. Exported (only) for test setup/inspection. */
export function traceCacheFor(manager: SquadManager): TraceCache {
	let cache = traceCachesByManager.get(manager);
	if (!cache) {
		cache = new Map();
		traceCachesByManager.set(manager, cache);
	}
	return cache;
}

export function sweepExpiredTraceCache(cache: TraceCache, now = Date.now()): void {
	for (const [key, entry] of cache) {
		if (now - entry.at >= TRACE_CACHE_TTL_MS) cache.delete(key);
	}
}

/** True when a run for `id`'s feature started strictly after `cachedAt` — a re-dispatch the cached
 *  response predates. Roster-only (no disk scan), so re-validating a hit costs nothing next to the
 *  full trace recompute it's meant to avoid. Non-feature trace ids (bare / `run:`-prefixed — always
 *  scoped to one immutable run) never go stale this way, so they're always considered fresh. */
function hasNewerRunForTrace(manager: SquadManager, id: string, cachedAt: number): boolean {
	if (!id.startsWith("feat:")) return false;
	const featureId = id.slice(5);
	return manager.list().some((dto) => dto.featureId === featureId && (dto.startedAt ?? 0) > cachedAt);
}

export async function tracePayload(manager: SquadManager, id: string): Promise<TraceResponse> {
	const cache = traceCacheFor(manager);
	const hit = cache.get(id);
	if (hit) {
		if (Date.now() - hit.at < TRACE_CACHE_TTL_MS && !hasNewerRunForTrace(manager, id, hit.at)) return hit.response;
		cache.delete(id); // expired, or superseded by a new run under the same feature — evict either way
	}
	const response = await manager.trace(id);
	// Only cache once the trace looks finalized: it must have at least one receipt (an empty/not-yet-
	// journaled trace is never "finalized" — caching it would hide receipts that land moments later for
	// up to TRACE_CACHE_TTL_MS) and no receipt still mid-run (no receipt missing endedAt).
	if (response.receipts.length > 0 && response.receipts.every((r) => r.endedAt !== undefined)) {
		sweepExpiredTraceCache(cache);
		if (cache.size >= TRACE_CACHE_MAX) {
			const oldest = cache.keys().next().value; // Map preserves insertion order — FIFO
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(id, { at: Date.now(), response });
	}
	return response;
}

/** Every persisted receipt across every manager the caller can see — a tenant session's array is always
 *  1 manager (unchanged behavior); the bootstrap-admin break-glass array can be several, so this unions
 *  them rather than reading only the first (which would silently drop every other org's history). */
async function allReceiptsAcross(managers: SquadManager[]): Promise<RunReceipt[]> {
	return (await Promise.all(managers.map((m) => m.allReceipts()))).flat();
}

/**
 * Knowledge-view incident, layer 1: `/api/fabric` and `/api/fabric/search` used to read the single
 * per-request `manager` like a plain feature route (post `!manager` gate), instead of joining
 * `handleObservability`'s break-glass union — the exact disease #113 fixed for graph/usage/heat/
 * activity/action-items/governance/health. A bootstrap-admin without a root factory (the daemon's
 * default: `OMP_SQUAD_ROOT_FACTORY` unset) never resolves a single `manager` at all and fell
 * through to `noFleet`'s bare `[]`; even WITH a root factory, this route's own `manager` would
 * only ever be the root's, silently omitting every other live org's facts. Unions each reachable
 * manager's own `.fabric()` — a tenant session's array is always its own 1 manager (see
 * `observabilityManagers`), so this is a no-op union for it; isolation is unaffected.
 */
async function fabricSnapshotAcross(managers: SquadManager[], actor: Actor, opts: { repos?: string[]; includeLeases?: boolean }): Promise<FabricSnapshot> {
	const snapshots = await Promise.all(managers.map((m) => m.fabric(actor, opts)));
	if (snapshots.length <= 1) return snapshots[0] ?? { actor: actor.id, generatedAt: Date.now(), scope: [], agents: [], digests: [], hotAreas: [], scout: [], leases: [], decisions: [], failures: [] };
	return {
		actor: actor.id,
		generatedAt: Math.max(...snapshots.map((s) => s.generatedAt)),
		scope: [...new Set(snapshots.flatMap((s) => s.scope))].sort(),
		agents: snapshots.flatMap((s) => s.agents),
		digests: snapshots.flatMap((s) => s.digests),
		hotAreas: snapshots
			.flatMap((s) => s.hotAreas)
			.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
			.slice(0, 50),
		scout: snapshots.flatMap((s) => s.scout),
		leases: snapshots.flatMap((s) => s.leases),
		decisions: snapshots.flatMap((s) => s.decisions),
		failures: snapshots.flatMap((s) => s.failures),
	};
}

/** Same disease, `/api/audit`: union each manager's own audit log (fetched uncapped via `limit: 0`,
 *  matching `readAudit`'s own "<=0 ⇒ no cap" contract) before re-sorting newest-first and applying
 *  the CALLER's requested limit — a per-manager pre-merge cap would silently drop entries that
 *  should have made the merged top-N. */
async function auditPayloadAcross(managers: SquadManager[], query: AuditQuery): Promise<AuditEntry[]> {
	const perManager = await Promise.all(managers.map((m) => m.auditLog({ ...query, limit: 0 })));
	const merged = perManager.flat().sort((a, b) => b.at - a.at || b.id - a.id);
	const limit = query.limit ?? 200;
	return limit > 0 ? merged.slice(0, limit) : merged;
}

function mergeAutomationRollups(rows: AutomationRollupRow[][]): AutomationRollupRow[] {
	const merged = new Map<AutomationLoop, AutomationRollupRow>();
	for (const list of rows) {
		for (const r of list) {
			const cur = merged.get(r.loop) ?? { loop: r.loop, events: 0, llmCalls: 0, found: 0, filed: 0, spawned: 0, errors: 0, lastAt: 0 };
			cur.events += r.events;
			cur.llmCalls += r.llmCalls;
			cur.found += r.found;
			cur.filed += r.filed;
			cur.spawned += r.spawned;
			cur.errors += r.errors;
			if (r.lastAt >= cur.lastAt) {
				cur.lastAt = r.lastAt;
				cur.lastSkipReason = r.lastSkipReason;
			}
			merged.set(r.loop, cur);
		}
	}
	return [...merged.values()].sort((a, b) => a.loop.localeCompare(b.loop));
}

/** Same disease, `/api/automation`: union each manager's recent events (fetched uncapped, same
 *  `limit: 0` convention as auditPayloadAcross) then re-sort/re-limit, and sum the per-loop rollups
 *  field-by-field (a straight count/sum aggregation — `lastAt`/`lastSkipReason` take the max). */
async function automationPayloadAcross(managers: SquadManager[], query: AutomationQuery & { windowMs?: number }): Promise<{ events: AutomationEvent[]; rollup: AutomationRollupRow[] }> {
	const perManager = await Promise.all(managers.map((m) => m.automationActivity({ ...query, limit: 0 })));
	const merged = perManager.flatMap((r) => r.events).sort((a, b) => b.at - a.at || b.id - a.id);
	const limit = query.limit ?? 200;
	return { events: limit > 0 ? merged.slice(0, limit) : merged, rollup: mergeAutomationRollups(perManager.map((r) => r.rollup)) };
}

function mergeMetricRollups(rows: MetricRollupRow[][]): MetricRollupRow[] {
	const merged = new Map<MetricName, MetricRollupRow>();
	for (const list of rows) {
		for (const r of list) {
			const cur = merged.get(r.name) ?? { name: r.name, count: 0, sum: 0, avg: 0 };
			cur.count += r.count;
			cur.sum += r.sum;
			cur.avg = cur.count ? cur.sum / cur.count : 0;
			if (r.byTag) {
				cur.byTag ??= {};
				for (const [tagKey, tagVals] of Object.entries(r.byTag)) {
					cur.byTag[tagKey] ??= {};
					for (const [val, bucket] of Object.entries(tagVals)) {
						const b = (cur.byTag[tagKey][val] ??= { count: 0, sum: 0, avg: 0 });
						b.count += bucket.count;
						b.sum += bucket.sum;
						b.avg = b.count ? b.sum / b.count : 0;
					}
				}
			}
			merged.set(r.name, cur);
		}
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Same disease, `/api/metrics/learning-loop`: `flags` is pure env resolution (`learningFlags()`),
 *  identical regardless of which manager answers, so it's read once; the per-metric rollups are
 *  summed across every reachable manager. */
function learningLoopPayloadAcross(managers: SquadManager[], windowMs?: number): { flags: ReturnType<typeof learningFlags>; rollup: MetricRollupRow[] } {
	return { flags: learningFlags(), rollup: mergeMetricRollups(managers.map((m) => m.learningMetricsSnapshot(windowMs).rollup)) };
}

async function usagePayload(managers: SquadManager[], url: URL): Promise<{
	runs: RunReceipt[];
	receipts: RunReceipt[];
	toolCalls: number;
	costUsd?: number;
	tokens?: number;
	durationMs?: number;
	agents: number;
	since?: number;
}> {
	const limit = boundedNumber(url.searchParams.get("limit"), 100, 1, 1000);
	const repo = url.searchParams.get("repo") ?? undefined;
	const agentId = url.searchParams.get("agentId") ?? undefined;
	const since = boundedNumber(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER) || undefined;
	// Source the persisted ledger (like attributionPayload/trace), not the live roster: receipts outlive
	// the agents that produced them — reaped agents, and every agent after a daemon restart — so
	// roster-scoping hid all but the currently-live runs' history.
	const receipts = (await allReceiptsAcross(managers)).filter(
		(r) => (!repo || r.repo === repo) && (!agentId || r.agentId === agentId) && (!since || (r.endedAt ?? r.startedAt) >= since),
	);
	const runs = receipts.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)).slice(0, limit);
	const totals = runs.reduce((acc, r) => {
		acc.toolCalls += r.toolCalls;
		acc.costUsd += r.costUsd ?? 0;
		acc.tokens += r.tokens?.total ?? 0;
		acc.durationMs += r.durationMs ?? 0;
		return acc;
	}, { toolCalls: 0, costUsd: 0, tokens: 0, durationMs: 0 });
	return {
		runs,
		receipts: runs,
		toolCalls: totals.toolCalls,
		costUsd: totals.costUsd || undefined,
		tokens: totals.tokens || undefined,
		durationMs: totals.durationMs || undefined,
		agents: new Set(receipts.map((r) => r.agentId)).size,
		since,
	};
}

async function heatPayload(managers: SquadManager[], url: URL): Promise<{
	days: string[];
	tree: { id: string; name: string; type: "file"; depth: number; heat: number[] }[];
	hotAreas: { path: string; heat: number }[];
	insights: string[];
	source: string;
	generatedAt: number;
}> {
	const count = boundedNumber(url.searchParams.get("days"), 8, 1, 31);
	const repo = url.searchParams.get("repo") ?? undefined;
	const end = new Date();
	const days = Array.from({ length: count }, (_, i) => {
		const d = new Date(end);
		d.setDate(end.getDate() - (count - i - 1));
		return d.toISOString().slice(0, 10);
	});
	const indexByDay = new Map(days.map((d, i) => [d, i]));
	// Persisted ledger, not the live roster (see usagePayload) — otherwise reaped agents and post-restart
	// history vanish and the panel falsely reads "No receipt-backed file writes in this window".
	const receipts = (await allReceiptsAcross(managers)).filter((r) => !repo || r.repo === repo);
	const byFile = new Map<string, number[]>();
	for (const r of receipts) {
		const day = new Date(r.endedAt ?? r.startedAt).toISOString().slice(0, 10);
		const idx = indexByDay.get(day);
		if (idx === undefined) continue;
		for (const file of r.filesTouched) {
			const heat = byFile.get(file) ?? Array(count).fill(0);
			heat[idx] += 1;
			byFile.set(file, heat);
		}
	}
	const tree = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, heat]) => ({
		id,
		name: path.basename(id),
		type: "file" as const,
		depth: Math.max(0, id.split(/[\\/]/).length - 1),
		heat,
	}));
	const hotAreas = tree.map((n) => ({ path: n.id, heat: n.heat.reduce((a, b) => a + b, 0) })).filter((n) => n.heat > 0).sort((a, b) => b.heat - a.heat).slice(0, 8);
	return {
		days,
		tree,
		hotAreas,
		insights: hotAreas.length ? [`${hotAreas.length} files touched in recent receipts`] : ["No receipt-backed file writes in this window"],
		source: "receipts.filesTouched",
		generatedAt: Date.now(),
	};
}

/**
 * Day×hour activity matrix for the "Activity rhythm" heatmap: for each of the last
 * `days` calendar days, how many file-touches landed in each hour 00–23. Same
 * receipt source as heatPayload (filesTouched), just bucketed by hour-of-day too,
 * so the two views agree on totals.
 *
 * Server-LOCAL time throughout (the daemon runs on the operator's machine, so its
 * wall clock is the rhythm the operator actually lives) — a (day, hour) cell is
 * internally consistent because both come from the same local Date.
 */
async function activityHeatmapPayload(managers: SquadManager[], url: URL): Promise<{
	days: string[];
	hours: number[];
	matrix: { day: string; hourly: number[] }[];
	max: number;
	total: number;
	source: string;
	generatedAt: number;
}> {
	const count = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const repo = url.searchParams.get("repo") ?? undefined;
	const localDay = (d: Date): string =>
		`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	const end = new Date();
	const days = Array.from({ length: count }, (_, i) => {
		const d = new Date(end);
		d.setDate(end.getDate() - (count - i - 1));
		return localDay(d);
	});
	const rowByDay = new Map(days.map((d) => [d, new Array<number>(24).fill(0)]));
	// Persisted ledger, not the live roster (see usagePayload), so the rhythm survives restarts + reaps.
	const receipts = (await allReceiptsAcross(managers)).filter((r) => !repo || r.repo === repo);
	let max = 0;
	let total = 0;
	for (const r of receipts) {
		const touched = r.filesTouched.length;
		if (touched === 0) continue;
		const when = new Date(r.endedAt ?? r.startedAt);
		const row = rowByDay.get(localDay(when));
		if (!row) continue;
		const hour = when.getHours();
		row[hour] += touched;
		total += touched;
		if (row[hour] > max) max = row[hour];
	}
	return {
		days,
		hours: Array.from({ length: 24 }, (_, i) => i),
		matrix: days.map((day) => ({ day, hourly: rowByDay.get(day) ?? new Array<number>(24).fill(0) })),
		max,
		total,
		source: "receipts.filesTouched (per day×hour, server-local)",
		generatedAt: Date.now(),
	};
}

/** Per-adapter config/secrets from OMP_GRAPH_<ADAPTER>_<KEY> env vars → { adapter: { KEY: value } }. */
function graphConfigFromEnv(): Record<string, Record<string, string>> {
	const cfg: Record<string, Record<string, string>> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!v) continue;
		const m = /^OMP_GRAPH_([A-Z0-9]+)_(.+)$/.exec(k);
		if (!m) continue;
		(cfg[m[1].toLowerCase()] ??= {})[m[2]] = v;
	}
	return cfg;
}

/** Short-TTL cache so polling clients (and future slow external adapters) don't recompute every hit. */
const graphCache = new Map<string, { at: number; doc: GraphDoc }>();

/**
 * The normalized omp-graph document (GET /api/graph) — the source-agnostic wire
 * format the living dashboard consumes. Composes the default adapter set (git +
 * receipts + automation + plane) over `days` of history plus `future` days ahead
 * (for upcoming meetings/renewals once those adapters land). Reconstructs the
 * daemon state dir like index.ts, and passes per-adapter secrets from env.
 */
/**
 * Resolve the `?repo=` param against the allowlist (known project repos + the daemon
 * cwd). Returns null when a caller asks for a repo outside it — so an authenticated
 * viewer can't drive `git show` / adapter reads against arbitrary repos on the host.
 * No param → the daemon cwd (the webapp never sends one).
 */
function resolveGraphRepo(url: URL, managers: SquadManager[]): string | null {
	const raw = url.searchParams.get("repo");
	if (!raw) return process.cwd();
	const resolved = path.resolve(raw);
	const allowed = new Set([path.resolve(process.cwd()), ...managers.flatMap((m) => m.projects()).map((p) => path.resolve(p.repo))]);
	return allowed.has(resolved) ? resolved : null;
}

async function graphPayload(url: URL, repo: string): Promise<GraphDoc & { plan: { name: string; monthly: number } | null }> {
	const days = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const future = boundedNumber(url.searchParams.get("future"), 0, 0, 14);
	// explicit window (epoch ms) for history views — the DEPTH massif fetches one
	// window per week row. Bounded to 32 days so a bad param can't walk all of git.
	const range = explicitRange(url);
	const stateDir = resolveStateDir();
	const key = range ? `r${range.start}:${range.end}:${repo}` : `${days}:${future}:${repo}`;
	const ttl = envInt("OMP_GRAPH_CACHE_MS", 10_000);
	const fresh = url.searchParams.get("fresh"); // reload icon bypasses the cache
	const plan = planFromEnv() ?? null;
	const hit = graphCache.get(key);
	if (hit && !fresh && Date.now() - hit.at < ttl) return { ...hit.doc, plan };
	// external-harness ledgers (Claude Code sessions) fold into receipts here,
	// throttled — so the pulse attributes EVERY harness that worked this repo
	await ingestHarnesses(stateDir, repo);
	const doc = await buildGraph({ repo, stateDir, config: graphConfigFromEnv() }, range ? { range } : { days, futureDays: future });
	graphCache.set(key, { at: Date.now(), doc });
	return { ...doc, plan };
}

/** Parse ?start=&end= (epoch ms) into a bounded TimeRange, or null when absent/invalid. */
function explicitRange(url: URL): { start: number; end: number } | null {
	const start = Number(url.searchParams.get("start"));
	const end = Number(url.searchParams.get("end"));
	if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) return null;
	const MAX_SPAN = 32 * 24 * 3_600_000;
	return end - start > MAX_SPAN ? { start: end - MAX_SPAN, end } : { start, end };
}

/** GET /api/graph/attribution — the harness→model spend matrix behind the pulse bands. */
async function attributionPayload(url: URL, repo: string): Promise<ReturnType<typeof buildAttribution>> {
	const days = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const range = explicitRange(url) ?? { start: Date.now() - days * 24 * 3_600_000, end: Date.now() };
	const stateDir = resolveStateDir();
	await ingestHarnesses(stateDir, repo);
	const receipts = (await readAllReceipts(stateDir)).filter((r) => r.repo === repo);
	return buildAttribution(receipts, range, { plan: planFromEnv() });
}

/**
 * The model scoreboard: land-rate (per complexity tier) + $/landed-change per model, joining the
 * model-outcome ledger with receipt cost. Answers the agent-selection rubric from real outcomes.
 * Outcomes are fleet-global (the ledger is not repo-keyed); cost is this repo's receipts.
 */
async function scoreboardPayload(repo: string): Promise<Scoreboard> {
	const stateDir = resolveStateDir();
	await ingestHarnesses(stateDir, repo);
	const receipts = (await readAllReceipts(stateDir)).filter((r) => r.repo === repo);
	return buildScoreboard(receipts, readModelOutcomes(stateDir));
}

/**
 * GET /api/graph/task-class — the task-class × model outcome matrix (model-routing-control-loop
 * concern 05). OBSERVATIONAL, NOT A DECISION ORACLE — see task-class-matrix.ts's module doc; the
 * webapp panel MUST surface `doc.note` prominently, not just tuck it into a tooltip.
 */
async function taskClassPayload(managers: SquadManager[], url: URL): Promise<TaskClassMatrixDoc> {
	const days = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const range = explicitRange(url) ?? { start: Date.now() - days * 24 * 3_600_000, end: Date.now() };
	const stateDir = resolveStateDir();
	const rows = await readTaskOutcomes(stateDir);
	const denominatorPopulation = managers.flatMap((m) => m.landingRosterRouting());
	return buildTaskClassMatrix(rows, denominatorPopulation, range);
}

/** GET /api/graph/provenance?id=OMPSQ-336 — the plan→agent→proof→land thread for one ticket. */
async function provenancePayload(url: URL, repo: string, managers: SquadManager[]): Promise<ProvenanceDoc | { error: string }> {
	const id = (url.searchParams.get("id") ?? "").trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) return { error: "invalid ticket id" };
	const stateDir = resolveStateDir();
	const featureLists = await Promise.all(managers.map((m) => m.features(repo).catch(() => [])));
	const features = featureLists.flat().map((f) => ({
		id: f.id,
		title: f.title,
		planDir: f.planDir,
		issueIdentifiers: f.issueIdentifiers,
	}));
	return buildProvenance({ repo, stateDir, ticket: id, features });
}

// ── commit detail (GET /api/graph/commit?sha=) — the "click a milestone → diff" drilldown ──

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const MAX_DIFF_LINES = 900; // bound the payload; huge refactors get a "truncated" flag

interface CommitLine {
	t: "ctx" | "add" | "del" | "hunk";
	s: string;
}
interface CommitFile {
	path: string;
	status: "added" | "deleted" | "modified" | "renamed";
	additions: number;
	deletions: number;
	lines: CommitLine[];
}
export interface CommitDetail {
	sha: string;
	author: string;
	dateMs: number;
	subject: string;
	files: CommitFile[];
	additions: number;
	deletions: number;
	truncated: boolean;
}

/** Parse a `git show` unified patch into per-file typed lines. Pure. */
function parseUnifiedDiff(patch: string): { files: CommitFile[]; truncated: boolean } {
	const files: CommitFile[] = [];
	let cur: CommitFile | null = null;
	let total = 0;
	let truncated = false;
	const push = (line: CommitLine): void => {
		if (total < MAX_DIFF_LINES) cur?.lines.push(line);
		else truncated = true;
		total++;
	};
	for (const raw of patch.split("\n")) {
		if (raw.startsWith("diff --git")) {
			const m = raw.match(/ b\/(.+)$/);
			cur = { path: m ? m[1] : "?", status: "modified", additions: 0, deletions: 0, lines: [] };
			files.push(cur);
		} else if (!cur) {
			continue;
		} else if (raw.startsWith("new file")) {
			cur.status = "added";
		} else if (raw.startsWith("deleted file")) {
			cur.status = "deleted";
		} else if (raw.startsWith("rename ")) {
			cur.status = "renamed";
		} else if (raw.startsWith("@@")) {
			push({ t: "hunk", s: raw });
		} else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("similarity ") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("Binary files")) {
			// metadata lines — skip
		} else if (raw.startsWith("+")) {
			cur.additions++;
			push({ t: "add", s: raw.slice(1) });
		} else if (raw.startsWith("-")) {
			cur.deletions++;
			push({ t: "del", s: raw.slice(1) });
		} else if (raw.startsWith(" ")) {
			push({ t: "ctx", s: raw.slice(1) });
		}
	}
	return { files, truncated };
}

async function commitDetailPayload(url: URL, repo: string): Promise<CommitDetail | { error: string }> {
	const sha = (url.searchParams.get("sha") ?? "").trim();
	if (!SHA_RE.test(sha)) return { error: "invalid sha" }; // guard against arg injection
	const US = "\x1f";
	const RS = "\x1e";
	try {
		const proc = Bun.spawn(["git", "-C", repo, "show", "--no-color", "--no-notes", "--patch", `--format=format:%H${US}%an${US}%aI${US}%s${RS}`, sha], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0 || !out) return { error: "commit not found" };
		const rsIdx = out.indexOf(RS);
		const header = rsIdx >= 0 ? out.slice(0, rsIdx) : out;
		const patch = rsIdx >= 0 ? out.slice(rsIdx + 1) : "";
		const [hsha = sha, author = "", iso = "", subject = ""] = header.split(US);
		const { files, truncated } = parseUnifiedDiff(patch);
		const additions = files.reduce((a, f) => a + f.additions, 0);
		const deletions = files.reduce((a, f) => a + f.deletions, 0);
		return { sha: hsha, author, dateMs: Date.parse(iso) || 0, subject, files, additions, deletions, truncated };
	} catch {
		return { error: "git show failed" };
	}
}


/**
 * Fleet-wide health across every manager the caller can see. `rssMb`/`load1`/`ncpu`/`freeRatio`/`hosts`
 * are process/host-wide (sampleHealth reads `process.memoryUsage()`/`os.*`, identical no matter which
 * manager answers, since every manager lives in this one daemon process) — so the first manager's own
 * sample already supplies them correctly. Only `agents` (live roster occupancy) differs per manager, so
 * for a multi-manager (bootstrap-admin) view it's summed and the warnings recomputed against the true
 * fleet-wide count — otherwise a WIP-cap warning would only ever reflect one org's agents.
 */
async function aggregateHealth(managers: SquadManager[]): Promise<Awaited<ReturnType<SquadManager["sampleHealth"]>>> {
	const [primary, ...rest] = managers;
	const { sample, warnings, at } = await primary.sampleHealth();
	if (rest.length === 0) return { sample, warnings, at };
	const agents = liveAgentCount(managers.flatMap((m) => m.list()));
	const combined: HealthSample = { ...sample, agents };
	return { sample: combined, warnings: assessHealth(combined, defaultHealthLimits(sample.ncpu, hardAgentCeiling())), at };
}

async function governancePayload(managers: SquadManager[], role: Role, dbMode: boolean, dbRegistry: boolean): Promise<{
	authMode: "db" | "file";
	role: Role;
	wipCap: number;
	maxAgents: number;
	health: Awaited<ReturnType<SquadManager["sampleHealth"]>>;
	federation: { coordinator: boolean; dbRegistry: boolean };
	audit: { available: true };
	compliance: { findings: ComplianceFinding[]; evaluatedAt: number };
}> {
	return {
		authMode: dbMode ? "db" : "file",
		role,
		wipCap: envInt("OMP_SQUAD_WIP_CAP", 3),
		maxAgents: hardAgentCeiling(),
		health: await aggregateHealth(managers),
		federation: { coordinator: !!process.env.OMP_SQUAD_COORDINATOR, dbRegistry },
		audit: { available: true },
		// Epic 3 (leaf 05): real policy findings over the audit + land ledgers, not just RBAC/capacity.
		compliance: { findings: (await Promise.all(managers.map((m) => m.complianceFindings()))).flat(), evaluatedAt: Date.now() },
	};
}
async function actionItemsPayload(managers: SquadManager[], url: URL): Promise<{ items: ActionItem[]; generatedAt: number }> {
	const repo = url.searchParams.get("repo") ?? undefined;
	const agents = managers.flatMap((m) => m.list()).filter((a) => !repo || a.repo === repo);
	const health = await aggregateHealth(managers);
	const items: ActionItem[] = [];
	for (const a of agents) {
		for (const p of a.pending) {
			items.push({
				id: `pending:${a.id}:${p.id}`,
				severity: p.source === "tool" ? "high" : "medium",
				source: p.source,
				subject: `${a.name}: ${p.title}`,
				rootCause: p.message ?? "Agent is waiting for operator input.",
				nextAction: p.source === "tool" ? "Review and answer the host-tool request" : "Answer the pending prompt",
				targetRoute: `#/console/${encodeURIComponent(a.id)}`,
				agentId: a.id,
				requestId: p.id,
			});
		}
		if (a.status === "error") {
			items.push({
				id: `error:${a.id}`,
				severity: "high",
				source: "agent",
				subject: `${a.name} errored`,
				rootCause: a.error ?? "Agent reported an error.",
				nextAction: "Open transcript, then restart or remove the agent",
				targetRoute: `#/console/${encodeURIComponent(a.id)}`,
				agentId: a.id,
			});
		}
		if (a.landReady) {
			items.push({
				id: `land:${a.id}`,
				severity: "medium",
				source: "land",
				subject: `${a.name} is ready to land`,
				rootCause: "Verification passed and auto-land is holding for confirmation.",
				nextAction: "Review proof and land the branch",
				targetRoute: `#/agent/${encodeURIComponent(a.id)}`,
				agentId: a.id,
			});
		}
	}
	for (const warning of health.warnings) {
		items.push({
			id: `health:${warning}`,
			severity: "medium",
			source: "health",
			subject: "Fleet health warning",
			rootCause: warning,
			nextAction: "Open Fleet Health and reduce load before spawning more agents",
			targetRoute: "#/observability",
		});
	}
	items.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
	return { items, generatedAt: Date.now() };
}

type ActionItem = {
	id: string;
	severity: "low" | "medium" | "high";
	source: "ui" | "tool" | "agent" | "land" | "health";
	subject: string;
	rootCause: string;
	nextAction: string;
	targetRoute: string;
	agentId?: string;
	requestId?: string;
};

function severityRank(s: ActionItem["severity"]): number {
	return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

function boundedNumber(raw: string | null, fallback: number, min: number, max: number): number {
	const n = raw === null ? fallback : Number(raw);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
