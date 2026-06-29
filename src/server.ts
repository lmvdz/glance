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
import type { ArtifactCommentDTO, ClientCommand, FeatureCriterion, FeatureDecision, FeatureDTO, FeatureRelationship, FeatureStage, IssueRef, PlanAnnotationTarget, SquadEvent } from "./types.ts";
import { worktreeDiff, worktreeTree } from "./explore.ts";
import { appendConcernDecision, listPlanDirs, parsePlanConcerns, parsePlanDocuments } from "./features.ts";
import { searchFabric, type KbDocType } from "./fabric-search.ts";
import { fetchIssueDetail, listPlaneIssues, planeRepos } from "./plane.ts";
import { runVisionPass } from "./vision.ts";
import { checkVisionUrl } from "./ssrf.ts";
import { all, claim, release, who } from "./presence.ts";
import { type LeaseEntry, leasesFor } from "./leases.ts";
import { discoverRepos, planSpawn } from "./smart-spawn.ts";
import { gitState, pullLatest, reexecDaemon } from "./upgrade.ts";
import type { SquadManager } from "./squad-manager.ts";
import type { ManagerRegistry } from "./manager-registry.ts";
import { actorForRole, type AuthPolicy, RbacDenied, requestToken, requiredRole, resolveRole, roleAtLeast, tokenOk } from "./auth.ts";
import type { DbHandle } from "./db/index.ts";
import type { PushPayload, PushService } from "./push.ts";
import type { Actor, AgentDTO, AgentStatus, OperatorPresence, Role, RunReceipt } from "./types.ts";
import { type FederationSnapshot, federationView, PeerPresenceTracker } from "./federation.ts";
import { workflowSnapshot } from "./workflow-catalog.ts";
import { validateRequestedMode } from "./autonomy.ts";
import { featureFlagStates, isFeatureFlagKey, type RuntimeSettingsStore } from "./runtime-settings.ts";
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
	return process.env.OMP_SQUAD_WEBAPP === "1" && existsSync(WEBAPP_INDEX);
}

export function feedbackEnabled(): boolean {
	return process.env.OMP_SQUAD_FEEDBACK === "1";
}
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
	return { planPath, lineStart, lineEnd, quote };
}

function planAnnotationPrompt(feature: FeatureDTO, comment: ArtifactCommentDTO): string {
	const a = comment.annotation;
	const where = a ? `${a.planPath}${a.lineStart ? `:${a.lineStart}${a.lineEnd && a.lineEnd !== a.lineStart ? `-${a.lineEnd}` : ""}` : ""}` : "the linked plan";
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
	/** Coordinator URL to listen on for peer presence. Defaults to OMP_SQUAD_COORDINATOR; unset ⇒ federation surface stays inert. */
	coordinator?: string;
	/** Pre-shared token presented to the coordinator's auth gate. Defaults to OMP_SQUAD_COORDINATOR_TOKEN. */
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
	/** Runtime feature-flag settings persisted under the state dir and applied to process.env. */
	runtimeSettings?: RuntimeSettingsStore;
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
	/** Coordinator URL backing the peer-presence feed; null ⇒ federation surface inert. */
	private readonly coordinator: string | null;
	/** Pre-shared token presented to the coordinator; undefined ⇒ no auth. */
	private readonly coordinatorToken?: string;
	/** Listener-only peer-presence feed; created on start() only when a coordinator is configured. */
	private peerPresence?: PeerPresenceTracker;
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
		this.opts = opts;
		this.onEvent = (e: SquadEvent) => this.broadcast(e);
		// Mirror index.ts's daemon resolution so self's operator id matches what the daemon gossips.
		this.operator = opts.operator ?? { id: process.env.OMP_SQUAD_OPERATOR || os.userInfo().username || "local", origin: "local" };
		this.coordinator = opts.coordinator ?? process.env.OMP_SQUAD_COORDINATOR ?? null;
		this.coordinatorToken = opts.coordinatorToken ?? process.env.OMP_SQUAD_COORDINATOR_TOKEN ?? undefined;
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
		const limit = Number(process.env.OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN) || 30;
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

	/** Resolve the fleet a request/socket acts on. Single-manager mode: the root manager. DB-registry
	 *  mode: the caller's org manager (org is session-derived, never request-supplied), or none when the
	 *  actor has no active org. This is the ONLY way to reach a manager. */
	private async managerFor(actor: Actor): Promise<SquadManager | undefined> {
		if (!this.registry) return this.singleManager;
		return actor.orgId ? await this.registry.get(actor.orgId) : undefined;
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
		return ws.data.orgId ? await this.registry.get(ws.data.orgId) : undefined;
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
					let cmd: ClientCommand;
					try {
						cmd = JSON.parse(typeof raw === "string" ? raw : raw.toString());
					} catch {
						return;
					}
					// Route to the socket's org fleet (registry mode) or the single manager; org never from the wire.
					const actor = this.actorForSocket(ws);
					const m = await this.managerFor(actor);
					if (!m) return;
					// Transcript replay is unicast to the requesting socket.
					if (cmd.type === "subscribe") {
						for (const entry of m.getTranscript(cmd.id)) {
							ws.send(JSON.stringify({ type: "transcript", id: cmd.id, entry } satisfies SquadEvent));
						}
						return;
					}
					// Carry the socket's granted tier; applyCommand denies a command above it (logged there).
					void m.applyCommand(cmd, actor).catch((err) => {
						if (!(err instanceof RbacDenied)) throw err;
					});
				},
			},
		});

		if (this.registry) {
			// DB-registry mode: per-org fan-out via the registry's event sink. No global presence/federation (risk #6).
			this.registry.onEvent = (orgId, e) => this.broadcastTo(orgId, e);
		} else {
			this.singleManager?.on("event", this.onEvent);
			void this.syncPresence();
			this.presenceTimer = setInterval(() => void this.syncPresence(), 25_000);
			this.presenceTimer.unref?.();
			// Best-effort: only when a coordinator is configured do we open a read-only feed for peer presence.
			if (this.coordinator) {
				this.peerPresence = new PeerPresenceTracker({ coordinatorUrl: this.coordinator, operator: this.operator, token: this.coordinatorToken });
				void this.peerPresence.start();
			}
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
			if (this.auth) {
				// DB mode: loopback admin token bootstraps; otherwise the session cookie rides the upgrade headers.
				if (this.loopbackBootstrapAdmin(req, server)) {
					role = "admin";
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
				? server.upgrade(req, { data: { id: ++this.sockSeq, role, orgId } })
				: server.upgrade(req, { data: { id: ++this.sockSeq, role, orgId }, headers: { "Sec-WebSocket-Protocol": "ompsq-token" } });
			if (upgraded) return undefined;
			return new Response("websocket upgrade failed", { status: 426 });
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8" } });
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
				return new Response(Bun.file(resolved), { headers: { "content-type": type } });
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
			const campaignId = body && typeof body === "object" && !Array.isArray(body) && "campaignId" in body && typeof body.campaignId === "string" ? body.campaignId : "";
			if (!this.feedbackRateAllowed(req, server, campaignId)) return new Response("rate limited", { status: 429 });
			try {
				const item = await this.singleManager.submitFeedbackItem(body, req.headers.get("origin"));
				return Response.json({ item }, { status: 201 });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = /token|origin/.test(message) ? 403 : 400;
				return Response.json({ error: message }, { status });
			}
		}
		// Public mode probe — lets the SPA pick its auth style before any login. No auth required.
		if (url.pathname === "/api/auth/mode") return Response.json({ mode: this.dbMode ? "db" : "file" });
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
		if (!roleAtLeast(role, requiredRole(req.method, url.pathname))) return new Response("forbidden", { status: 403 });
		if (url.pathname === "/api/me") {
			if (!this.auth || session === null) return Response.json({ mode: "file" });
			const u = session.user;
			return Response.json({ mode: "db", user: { id: u.id, name: u.name, email: u.email, image: u.image ?? null }, activeOrganizationId: session.session.activeOrganizationId ?? null, role });
		}
		if (url.pathname === "/api/auth/check") return Response.json({ ok: true });
		if (url.pathname === "/api/push/key") return Response.json({ publicKey: this.opts.push?.publicKey ?? "" });
		if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
			if (!this.opts.push) return new Response("push unavailable", { status: 501 });
			const sub: unknown = await req.json().catch(() => null);
			if (!sub || typeof sub !== "object" || !("endpoint" in sub) || typeof sub.endpoint !== "string") return new Response("invalid subscription", { status: 400 });
			if (!("keys" in sub) || typeof sub.keys !== "object" || !sub.keys) return new Response("invalid subscription", { status: 400 });
			const keys = sub.keys;
			if (!("p256dh" in keys) || typeof keys.p256dh !== "string" || !("auth" in keys) || typeof keys.auth !== "string") return new Response("invalid subscription", { status: 400 });
			await this.opts.push.subscribe({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/settings" && req.method === "GET") {
			const flags = this.opts.runtimeSettings ? await this.opts.runtimeSettings.states() : featureFlagStates();
			return Response.json({ featureFlags: flags });
		}
		if (url.pathname === "/api/settings/feature-flags" && req.method === "POST") {
			if (!this.opts.runtimeSettings) return new Response("settings persistence unavailable", { status: 501 });
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("key" in body) || typeof body.key !== "string" || !isFeatureFlagKey(body.key) || !("enabled" in body) || typeof body.enabled !== "boolean") {
				return new Response("feature flag key and enabled boolean required", { status: 400 });
			}
			const flags = await this.opts.runtimeSettings.setFeatureFlag(body.key, body.enabled);
			return Response.json({ featureFlags: flags });
		}
		// Resolve the caller's fleet. Single-manager mode: the root manager. DB-registry mode: the
		// org's manager (org from the session, never the request). No active org ⇒ empty reads / 403 mutations.
		const orgId = this.registry ? (session?.session.activeOrganizationId ?? undefined) : undefined;
		const actor: Actor =
			this.registry && session
				? { id: `db:${session.user.id}`, displayName: session.user.name, origin: "local", role, orgId }
				: actorForRole(role);
		const manager = await this.managerFor(actor);
		if (!manager) return this.noFleet(req, url);
		if (url.pathname === "/api/feedback/campaigns" && req.method === "GET") return Response.json(await manager.listFeedbackCampaigns());
		if (url.pathname === "/api/feedback/campaigns" && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object") return new Response("campaign body required", { status: 400 });
			if (!("name" in body) || typeof body.name !== "string" || !("repo" in body) || typeof body.repo !== "string" || !("token" in body) || typeof body.token !== "string") return new Response("name, repo, token required", { status: 400 });
			const allowedOrigins = "allowedOrigins" in body && Array.isArray(body.allowedOrigins) ? body.allowedOrigins.filter((x): x is string => typeof x === "string") : undefined;
			const rewardCents = "rewardCents" in body && typeof body.rewardCents === "number" ? body.rewardCents : undefined;
			const rewardCurrency = "rewardCurrency" in body && typeof body.rewardCurrency === "string" ? body.rewardCurrency : undefined;
			const id = "id" in body && typeof body.id === "string" ? body.id : undefined;
			return Response.json(await manager.seedFeedbackCampaign({ id, name: body.name, repo: body.repo, token: body.token, allowedOrigins, rewardCents, rewardCurrency }));
		}
		if (url.pathname === "/api/feedback/items" && req.method === "GET") return Response.json(await manager.listFeedbackItems());
		const mfitem = url.pathname.match(/^\/api\/feedback\/items\/([^/]+)(?:\/(.+))?$/);
		if (mfitem) {
			const id = decodeURIComponent(mfitem[1]);
			const action = mfitem[2] ?? "";
			try {
				if (!action && req.method === "GET") {
					const list = await manager.listFeedbackItems();
					const item = list.raw.find((x) => x.id === id);
					return item ? Response.json(item) : new Response("feedback item not found", { status: 404 });
				}
				if (action === "validate" && req.method === "POST") {
					const body: unknown = await req.json().catch(() => ({}));
					const input = body && typeof body === "object" ? {
						respondent: "respondent" in body ? body.respondent : undefined,
						vote: "vote" in body ? body.vote : undefined,
						wouldUse: "wouldUse" in body ? body.wouldUse : undefined,
						pain: "pain" in body ? body.pain : undefined,
						note: "note" in body ? body.note : undefined,
					} : {};
					return Response.json(await manager.addFeedbackValidation(id, input, actor));
				}
				if (action === "reward/approve" && req.method === "POST") return Response.json(await manager.approveFeedbackReward(id, actor));
				if (action === "reward/void" && req.method === "POST") return Response.json(await manager.voidFeedbackReward(id, actor));
				if (action === "reward/mark-paid" && req.method === "POST") {
					const body: unknown = await req.json().catch(() => ({}));
					const provider = body && typeof body === "object" && "provider" in body && typeof body.provider === "string" && ["manual", "stripe", "tremendous"].includes(body.provider) ? body.provider : undefined;
					const externalRef = body && typeof body === "object" && "externalRef" in body && typeof body.externalRef === "string" ? body.externalRef : undefined;
					return Response.json(await manager.markFeedbackRewardPaid(id, { provider, externalRef }, actor));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return new Response(message, { status: /not found/.test(message) ? 404 : 400 });
			}
		}
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
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object") return new Response("manifest or catalogId required", { status: 400 });
			const rec = body as Record<string, unknown>;
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
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("packId" in body) || typeof body.packId !== "string") return new Response("packId required", { status: 400 });
			const rec = body as Record<string, unknown>;
			const overrides = rec.overrides && typeof rec.overrides === "object" && !Array.isArray(rec.overrides) ? rec.overrides as Record<string, unknown> : undefined;
			const enable = typeof rec.enable === "boolean" ? rec.enable : undefined;
			return Response.json(manager.installCapability({ packId: body.packId, overrides, enable }, actor));
		}
		const mcinstall = url.pathname.match(/^\/api\/capability-installs\/([^/]+)(?:\/(run))?$/);
		if (mcinstall && req.method === "PATCH" && !mcinstall[2]) {
			const body: unknown = await req.json().catch(() => null);
			const patch = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
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
			const body: unknown = await req.json().catch(() => ({}));
			const rec = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
			const bindingKey = typeof rec.bindingKey === "string" ? rec.bindingKey : undefined;
			const repo = typeof rec.repo === "string" && rec.repo ? rec.repo : undefined;
			const prompt = typeof rec.prompt === "string" && rec.prompt.trim() ? rec.prompt.trim() : undefined;
			const agent = await manager.runCapability(decodeURIComponent(mcinstall[1]), bindingKey, { repo, prompt }, actor);
			return Response.json({ agent, installId: decodeURIComponent(mcinstall[1]), bindingKey });
		}
		if (url.pathname === "/api/features" && req.method === "GET") return Response.json(await manager.features(url.searchParams.get("repo") ?? undefined));
		if (url.pathname === "/api/features/archived" && req.method === "GET") return Response.json({ features: manager.archivedFeatures(url.searchParams.get("repo") ?? undefined) });
		if (url.pathname === "/api/features" && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("title" in body) || typeof body.title !== "string") return new Response("title required", { status: 400 });
			const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const planDir = "planDir" in body && typeof body.planDir === "string" ? body.planDir : undefined;
			manager.createFeature({ title: body.title, repo, planDir });
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/features/from-plan" && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("planDir" in body) || typeof body.planDir !== "string") return new Response("planDir required", { status: 400 });
			const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const planDir = body.planDir.replace(/\/+$/, "");
			const planTitle = (await listPlanDirs(repo)).find((pd) => pd.dir === planDir)?.title;
			const fallbackTitle = "title" in body && typeof body.title === "string" && body.title.trim() ? body.title.trim() : path.basename(planDir).replace(/[-_]+/g, " ");
			const title = planTitle ?? fallbackTitle;
			const existing = (await manager.features(repo)).find((f) => f.planDir === planDir);
			const pf = existing ?? manager.createFeature({ title, repo, planDir });
			return Response.json(pf);
		}
		if (url.pathname === "/api/features/auto" && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("goal" in body) || typeof body.goal !== "string" || !body.goal.trim()) return new Response("goal required", { status: 400 });
			const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const title = "title" in body && typeof body.title === "string" && body.title.trim() ? body.title.trim() : body.goal.trim().slice(0, 48);
			const model = "model" in body && typeof body.model === "string" && body.model ? body.model : undefined;
			const { feature, agent } = await manager.createAutoFeature({ title, repo, goal: body.goal.trim(), model });
			return Response.json({ feature, agentId: agent.id });
		}
		const mfpatch = url.pathname.match(/^\/api\/features\/([^/]+)$/);
		if (mfpatch && req.method === "PATCH") {
			const body: unknown = await req.json().catch(() => null);
			const patch: { title?: string; stageOverride?: FeatureStage | null; archived?: boolean; repo?: string; description?: string; acceptanceCriteria?: FeatureCriterion[]; decisions?: FeatureDecision[]; relationships?: FeatureRelationship[] } = {};
			if (body && typeof body === "object") {
				if ("repo" in body && typeof body.repo === "string") patch.repo = body.repo;
				if ("title" in body && typeof body.title === "string") patch.title = body.title;
				if ("description" in body && typeof body.description === "string") patch.description = body.description;
				if ("archived" in body && typeof body.archived === "boolean") patch.archived = body.archived;
				if ("stageOverride" in body) patch.stageOverride = typeof body.stageOverride === "string" ? (body.stageOverride as FeatureStage) : null;
				if ("acceptanceCriteria" in body) patch.acceptanceCriteria = featureCriteria(body.acceptanceCriteria);
				if ("decisions" in body) patch.decisions = featureDecisions(body.decisions);
				if ("relationships" in body) patch.relationships = featureRelationships(body.relationships);
			}
			const pf = await manager.updateFeature(decodeURIComponent(mfpatch[1]), patch);
			return pf ? Response.json(pf) : new Response("no such feature", { status: 404 });
		}
		if (mfpatch && req.method === "DELETE") {
			const repo = url.searchParams.get("repo") ?? undefined;
			const plane = url.searchParams.get("plane") === "detach" ? "detach" : "keep";
			const result = await manager.deleteFeature(decodeURIComponent(mfpatch[1]), { repo, plane });
			return result.deleted ? Response.json(result) : new Response("no such feature", { status: 404 });
		}
		const mflink = url.pathname.match(/^\/api\/features\/([^/]+)\/agents$/);
		if (mflink && req.method === "POST") {
			const id = decodeURIComponent(mflink[1]);
			const body: unknown = await req.json().catch(() => null);
			if (body && typeof body === "object" && "task" in body && typeof body.task === "string" && body.task.trim()) {
				const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
				const name = "name" in body && typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
				const feature = await manager.updateFeature(id, { repo });
				if (!feature) return new Response("no such feature", { status: 404 });
				const dto = await manager.create({ repo, name, task: body.task.trim(), featureId: feature.id, approvalMode: "yolo", track: true }, actor);
				manager.linkAgent(feature.id, dto.id);
				return Response.json({ agent: dto });
			}
			if (!body || typeof body !== "object" || !("agentId" in body) || typeof body.agentId !== "string") return new Response("agentId required", { status: 400 });
			const unlink = "unlink" in body && body.unlink === true;
			return Response.json({ ok: manager.linkAgent(id, body.agentId, unlink) });
		}
		const mfconcern = url.pathname.match(/^\/api\/features\/([^/]+)\/concerns$/);
		if (mfconcern && req.method === "PATCH") {
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("file" in body) || typeof body.file !== "string" || !body.file.trim()) {
				return new Response("file required", { status: 400 });
			}
			const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : undefined;
			const opts: { repo?: string; file: string; status?: string; blockedBy?: number[] } = { repo, file: body.file };
			if ("status" in body && typeof body.status === "string" && body.status.trim()) opts.status = body.status.trim();
			if ("blockedBy" in body && Array.isArray(body.blockedBy)) opts.blockedBy = body.blockedBy.map((n) => Number(n)).filter((n) => Number.isFinite(n));
			if (opts.status === undefined && opts.blockedBy === undefined) return new Response("nothing to update", { status: 400 });
			const concern = await manager.updateConcern(decodeURIComponent(mfconcern[1]), opts);
			return concern ? Response.json({ concern }) : new Response("no such concern", { status: 404 });
		}
		const mfanswer = url.pathname.match(/^\/api\/features\/([^/]+)\/answers$/);
		if (mfanswer && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("file" in body) || typeof body.file !== "string" || !body.file.trim()) {
				return new Response("file required", { status: 400 });
			}
			const prompt = "prompt" in body && typeof body.prompt === "string" ? body.prompt.trim() : "";
			const value = "value" in body && typeof body.value === "string" ? body.value.trim() : "";
			if (!prompt || !value) return new Response("prompt and value required", { status: 400 });
			const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
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
			const body: unknown = await req.json().catch(() => null);
			const force = !!(body && typeof body === "object" && "force" in body && body.force === true);
			const reason = body && typeof body === "object" && "reason" in body && typeof body.reason === "string" ? body.reason.trim() : undefined;
			return Response.json(await manager.landFeature(decodeURIComponent(mfland[1]), force, actor, reason));
		}
		const mftickets = url.pathname.match(/^\/api\/features\/([^/]+)\/tickets$/);
		if (mftickets && req.method === "GET") return Response.json(await withTimeout(manager.featurePlaneTickets(decodeURIComponent(mftickets[1])), 1500, { tickets: null }));
		const mfmodule = url.pathname.match(/^\/api\/features\/([^/]+)\/module$/);
		if (mfmodule && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			const repo = body && typeof body === "object" && "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : undefined;
			const createTickets = !!(body && typeof body === "object" && "tickets" in body && body.tickets === true);
			const out = await manager.createFeatureModule(decodeURIComponent(mfmodule[1]), { repo, createTickets });
			return out ? Response.json(out) : new Response("module create failed (Plane not configured?)", { status: 501 });
		}
		const mfmoduleRepair = url.pathname.match(/^\/api\/features\/([^/]+)\/module\/repair$/);
		if (mfmoduleRepair && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			const repo = body && typeof body === "object" && "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : undefined;
			const closeOrphans = !!(body && typeof body === "object" && "closeOrphans" in body && body.closeOrphans === true);
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
			return Response.json({ feature: f, readiness: f.readiness, concerns, documents, issues, comments, agentIds: f.agentIds });
		}
		if (url.pathname === "/api/info") return Response.json({ cwd: process.cwd() });
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
			const body: unknown = await req.json().catch(() => null);
			const text = body && typeof body === "object" && "body" in body && typeof body.body === "string" ? body.body.trim() : "";
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
			const body: unknown = await req.json().catch(() => null);
			const mode = body && typeof body === "object" && "mode" in body && body.mode === "agent" ? "agent" : "planner";
			const feature = (await manager.features(repo)).find((x) => x.id === featureId);
			if (!feature) return new Response("no such feature", { status: 404 });
			const comment = (await manager.listComments({ repo, subject: featureId })).find((item) => item.id === annotationId);
			if (!comment || comment.kind !== "plan-annotation") return new Response("annotation not found", { status: 404 });
			const message = planAnnotationPrompt(feature, comment);
			if (mode === "agent") {
				const agentId = body && typeof body === "object" && "agentId" in body && typeof body.agentId === "string" ? body.agentId : "";
				if (!agentId) return new Response("agentId required", { status: 400 });
				await manager.applyCommand({ type: "prompt", id: agentId, message }, actor);
				return Response.json({ agentId, mode });
			}
			const dto = await manager.create({ repo, name: "plan-reviser", task: message, featureId, approvalMode: "write", autoRoute: false, track: true, owns: feature.planDir ? [feature.planDir] : undefined }, actor);
			return Response.json({ agentId: dto.id, mode });
		}
		if (url.pathname === "/api/version") return Response.json({ version: this.uiVersion });
		if (url.pathname === "/api/health") {
			const h = await manager.sampleHealth();
			return Response.json({ ok: h.warnings.length === 0, warnings: h.warnings, ...h.sample, projects: manager.projects().length, uptimeSec: Math.round(process.uptime()), at: h.at });
		}
		if (url.pathname === "/api/usage") return Response.json(await usagePayload(manager, url));
		if (url.pathname === "/api/heat") return Response.json(await heatPayload(manager, url));
		if (url.pathname === "/api/action-items") return Response.json(await actionItemsPayload(manager, url));
		if (url.pathname === "/api/governance") return Response.json(await governancePayload(manager, role, this.dbMode, !!this.registry));
		if (url.pathname === "/api/presence") {
			// risk #6: the global presence registry is machine-wide; never serve it in DB-registry mode.
			if (this.registry) return Response.json([]);
			const repo = url.searchParams.get("repo");
			return Response.json(repo ? await who(repo) : await all());
		}
		if (url.pathname === "/api/leases") {
			const repo = url.searchParams.get("repo");
			// Single-manager / file mode: serve the requested repo (or cwd) directly.
			// DB-registry mode: the lease registry is machine-wide, so scope to repos THIS org's
			// fleet actually works on — never blanket-empty, never leak another org's leases.
			if (!this.registry) return Response.json(await leasesFor(repo ?? process.cwd()));
			return Response.json(await this.orgScopedLeases(manager, repo));
		}
		if (url.pathname === "/api/fabric") {
			const repo = url.searchParams.get("repo");
			// fabric is org-safe in both modes: leases are keyed to the manager's own agents/repos,
			// so includeLeases never leaks cross-org. Always include them (real data, even in DB mode).
			return Response.json(await manager.fabric(actor, { repos: repo ? [repo] : undefined, includeLeases: true }));
		}
		if (url.pathname === "/api/fabric/search") {
			// Ranked search over the SAME scoped snapshot — never widens what the actor can see.
			const repo = url.searchParams.get("repo");
			const q = url.searchParams.get("q") ?? "";
			const topK = boundedNumber(url.searchParams.get("topK"), 20, 1, 100);
			const type = (url.searchParams.get("type") ?? undefined) as KbDocType | undefined;
			const snapshot = await manager.fabric(actor, { repos: repo ? [repo] : undefined, includeLeases: true });
			const results = q.trim() ? searchFabric(snapshot, q, { topK, type }) : [];
			return Response.json({ query: q, results, counts: { agents: snapshot.agents.length, digests: snapshot.digests.length, hotAreas: snapshot.hotAreas.length, scout: snapshot.scout.length, leases: snapshot.leases.length, decisions: snapshot.decisions.length } });
		}
		if (url.pathname === "/api/opportunities") {
			const repos = url.searchParams.get("repo") ? [url.searchParams.get("repo") as string] : (planeRepos().length ? planeRepos() : manager.projects().map((p) => p.repo));
			const issues = (await Promise.all(repos.map((repo) => listPlaneIssues(repo).catch(() => null)))).flatMap((x) => x ?? []);
			return Response.json(issues.filter((i) => i.name.includes("[opportunity]")));
		}
		if (url.pathname === "/api/federation") return Response.json(this.federationSnapshot(manager));
		if (url.pathname === "/api/audit") {
			const q = url.searchParams;
			const limit = Number(q.get("limit"));
			return Response.json(
				await manager.auditLog({
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
				manager.automationActivity({
					loop,
					limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
					windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined,
					sinceMs: Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined,
					meaningfulOnly: q.get("meaningful") === "1",
				}),
			);
		}
		const mtrace = url.pathname.match(/^\/api\/trace\/([^/]+)$/);
		if (mtrace && req.method === "GET") {
			const trace = await manager.trace(decodeURIComponent(mtrace[1]));
			if (trace.receipts.length === 0 && trace.root.children.length === 0) return new Response("trace not found", { status: 404 });
			return Response.json(trace);
		}
		if (url.pathname === "/api/spawn" && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			const prompt = body && typeof body === "object" && "prompt" in body && typeof body.prompt === "string" ? body.prompt.trim() : "";
			if (prompt.length === 0) return new Response("empty prompt", { status: 400 });
			const profileId = body && typeof body === "object" && "profileId" in body && typeof body.profileId === "string" ? body.profileId : undefined;
			const tracked = manager.projects().map((p) => p.repo);
			const plan = await planSpawn(prompt, { cwd: process.cwd(), candidates: discoverRepos(process.cwd(), tracked) });
			try {
				const dto = await manager.create({ ...plan, profileId, track: true }, actor);
				return Response.json({ agent: dto, plan });
			} catch (err) {
				return new Response(err instanceof Error ? err.message : String(err), { status: 409 });
			}
		}
		if (url.pathname === "/api/console" && req.method === "POST") {
			const body: unknown = await req.json().catch(() => null);
			const repo = body && typeof body === "object" && "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const model = body && typeof body === "object" && "model" in body && typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
			const profileId = body && typeof body === "object" && "profileId" in body && typeof body.profileId === "string" ? body.profileId : undefined;
			const dto = await manager.create({ repo, name: "chat", model, profileId, autoRoute: false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT }, actor);
			return Response.json({ agentId: dto.id });
		}
		const mt = url.pathname.match(/^\/api\/agents\/([^/]+)\/transcript$/);
		if (mt) return Response.json(manager.getTranscript(decodeURIComponent(mt[1])));
		const msub = url.pathname.match(/^\/api\/agents\/([^/]+)\/subagents$/);
		if (msub) return Response.json(manager.subagents(decodeURIComponent(msub[1])));
		const mrec = url.pathname.match(/^\/api\/agents\/([^/]+)\/receipts$/);
		if (mrec) return Response.json(await manager.receipts(decodeURIComponent(mrec[1])));
		const mcmd = url.pathname.match(/^\/api\/agents\/([^/]+)\/commands$/);
		if (mcmd) return Response.json(manager.commandsFor(decodeURIComponent(mcmd[1])) ?? []);
		const mdiff = url.pathname.match(/^\/api\/agents\/([^/]+)\/(diff|tree)$/);
		if (mdiff) {
			const dto = manager.getAgent(decodeURIComponent(mdiff[1]));
			if (!dto) return new Response("no such agent", { status: 404 });
			return Response.json(mdiff[2] === "diff" ? await worktreeDiff(dto.worktree) : await worktreeTree(dto.worktree));
		}
		const mland = url.pathname.match(/^\/api\/agents\/([^/]+)\/land$/);
		if (mland && req.method === "POST") {
			const id = decodeURIComponent(mland[1]);
			const dto = manager.getAgent(id);
			if (!dto) return new Response("no such agent", { status: 404 });
			let message = `squad(${dto.name}): ${dto.issue?.name ?? "agent changes"}`;
			const body: unknown = await req.json().catch(() => null);
			const force = !!(body && typeof body === "object" && "force" in body && body.force === true);
			const reason = body && typeof body === "object" && "reason" in body && typeof body.reason === "string" ? body.reason.trim() : undefined;
			if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message.trim()) {
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
			const body: unknown = await req.json().catch(() => null);
			const mode = validateRequestedMode(body && typeof body === "object" && "mode" in body ? (body as { mode?: unknown }).mode : undefined);
			if (!mode) return new Response("invalid mode", { status: 400 });
			const reason = body && typeof body === "object" && "reason" in body && typeof body.reason === "string" ? body.reason : undefined;
			const dto = await manager.transitionMode(decodeURIComponent(mmode[1]), mode, actor, reason);
			if (!dto) return new Response("no such agent", { status: 404 });
			return Response.json(dto);
		}
		const mvision = url.pathname.match(/^\/api\/agents\/([^/]+)\/vision$/);
		if (mvision && req.method === "POST") {
			const dto = manager.getAgent(decodeURIComponent(mvision[1]));
			if (!dto) return new Response("no such agent", { status: 404 });
			const body: unknown = await req.json().catch(() => null);
			const target = body && typeof body === "object" && "url" in body && typeof body.url === "string" && body.url.trim() ? body.url.trim() : process.env.OMP_SQUAD_APP_URL;
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
			const body: unknown = await req.json().catch(() => null);
			const repo = body && typeof body === "object" && "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
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
			const body: unknown = await req.json().catch(() => null);
			if (!body || typeof body !== "object" || !("subject" in body) || typeof body.subject !== "string" || !body.subject || !("body" in body) || typeof body.body !== "string" || !body.body.trim()) {
				return new Response("subject and body required", { status: 400 });
			}
			const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
			const urgent = "urgent" in body && body.urgent === true;
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
			let cmd: ClientCommand;
			try {
				cmd = (await req.json()) as ClientCommand;
			} catch {
				return new Response("bad json", { status: 400 });
			}
			if (cmd.type === "create") {
				const dto = await manager.create({ ...cmd.options, track: true }, actor);
				return Response.json(dto);
			}
			if (cmd.type === "commission") {
				const result = await manager.commission(cmd.spec, { install: true }, actor);
				return Response.json(result);
			}
			// kill/restart/remove are admin-tier (commandTier); applyCommand is the single authority.
			// Surface its denial as 403 here (the WS handler swallows the same throw) — not a 2nd authz site.
			try {
				await manager.applyCommand(cmd, actor);
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
		const peers = this.registry ? [] : (this.peerPresence?.live() ?? []);
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

	stop(): void {
		this.singleManager?.off("event", this.onEvent);
		if (this.registry) this.registry.onEvent = () => {};
		clearInterval(this.presenceTimer);
		clearTimeout(this.presenceDebounce);
		for (const [id, repo] of this.claimed) void release(id, repo);
		this.claimed.clear();
		void this.peerPresence?.stop();
		this.server?.stop(true);
	}
}

async function usagePayload(manager: SquadManager, url: URL): Promise<{
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
	const agents = manager.list().filter((a) => (!repo || a.repo === repo) && (!agentId || a.id === agentId));
	const receipts = (await Promise.all(agents.map((a) => manager.receipts(a.id)))).flat().filter((r) => !since || (r.endedAt ?? r.startedAt) >= since);
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
		agents: agents.length,
		since,
	};
}

async function heatPayload(manager: SquadManager, url: URL): Promise<{
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
	const agents = manager.list().filter((a) => !repo || a.repo === repo);
	const receipts = (await Promise.all(agents.map((a) => manager.receipts(a.id)))).flat();
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


async function governancePayload(manager: SquadManager, role: Role, dbMode: boolean, dbRegistry: boolean): Promise<{
	authMode: "db" | "file";
	role: Role;
	wipCap: number;
	maxAgents: number;
	health: Awaited<ReturnType<SquadManager["sampleHealth"]>>;
	federation: { coordinator: boolean; dbRegistry: boolean };
	audit: { available: true };
}> {
	return {
		authMode: dbMode ? "db" : "file",
		role,
		wipCap: Number(process.env.OMP_SQUAD_WIP_CAP) || 3,
		maxAgents: Number(process.env.OMP_SQUAD_MAX_AGENTS) || Math.max(os.cpus().length || 2, 3),
		health: await manager.sampleHealth(),
		federation: { coordinator: !!process.env.OMP_SQUAD_COORDINATOR, dbRegistry },
		audit: { available: true },
	};
}
async function actionItemsPayload(manager: SquadManager, url: URL): Promise<{ items: ActionItem[]; generatedAt: number }> {
	const repo = url.searchParams.get("repo") ?? undefined;
	const agents = manager.list().filter((a) => !repo || a.repo === repo);
	const health = await manager.sampleHealth();
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
