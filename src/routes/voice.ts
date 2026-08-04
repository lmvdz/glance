/**
 * Voice HTTP surface (plans/deepen-modules/05 slice 4 + concern 11) — moved verbatim from
 * server.ts's handle() chain. Two lanes with two context shapes, because the chain dispatches
 * them at two different depths:
 *
 *  - The MINT lane (`/api/voice/config`, `/api/voice/token`) runs BEFORE the `!manager` gate —
 *    minting is independent of any specific fleet manager, and a DB-mode refusal must fire even
 *    for a session with no active org (which would otherwise hit `noFleet` first and never see
 *    the real reason). Its context carries `voiceScope` (the ONE org-aware resolver input both
 *    routes build their key-presence answer from — plans/voice-db-mode/03-org-aware-resolver.md),
 *    the resolved role/actor, a possibly-absent manager (audit only), and the per-actor mint
 *    rate limiter as a thunk.
 *  - The CALL lane (`/api/voice-calls`, `/api/channels/:id/voice-call/*`) is ordinary
 *    manager-tier `RouteContext`: every route re-checks room membership inside
 *    `manager.voiceCall*` (`ChannelStore#canReadChannel`) before touching the binding — the
 *    RBAC tier gate is the FIRST gate; both must pass.
 *
 * The table decodes RegExp captures into `params` exactly as the inline code's
 * `decodeURIComponent(match[n]!)` did — the handlers read `params` instead of re-matching.
 */
import { roleAtLeast } from "../auth.ts";
import { envBool, envInt } from "../config.ts";
import { appendOrgAudit, deleteOrgAuditRow, finalizeOrgAuditDetail, reserveOrgAuditSlot } from "../dal/store.ts";
import {
	decodeBody,
	decodeBodyOrEmpty,
	VoiceCallMuteBodySchema,
	VoiceCallResolveDecisionBodySchema,
	VoiceCallSteerBodySchema,
	VoiceCallStartBodySchema,
	VoiceTokenBodySchema,
} from "../schema/http-body.ts";
import type { SquadManager } from "../squad-manager.ts";
import type { Actor, Role } from "../types.ts";
import {
	isKnownVoiceProvider,
	mintVoiceToken,
	orgHasKey,
	voiceKeyFor,
	voiceProviderMaxSessionWindowMs,
	voiceProviderPublicInfo,
	voiceTokenTtlSeconds,
	VOICE_MINT_AUDIT_ACTION,
	type VoiceKeyScope,
} from "../voice-token.ts";
import { dispatchRoutes, type MatchContext, type Route, type RouteContext } from "./table.ts";
import { Result } from "effect";

const VOICE_MAX_CONCURRENT_PER_ORG_DEFAULT = 5;
let voiceMaxConcurrentWarned = false;

/** OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG — the durable, per-org concurrency cap
 *  (plans/voice-db-mode/04-spend-controls.md, DESIGN.md "Org spend bound" row): count this org's
 *  `voice.mint` audit rows inside the provider's own max-session window and refuse beyond N. Derived
 *  from the `audit` table (see `reserveOrgAuditSlot`, which counts and reserves the row atomically
 *  in one transaction — closing the check-then-act race a separate count-then-insert would have),
 *  so it's restart-safe and correct across replicas — unlike the rejected draft's "second in-memory
 *  map keyed by org", which would have
 *  inherited both defects of `voiceMintRate` (server.ts). Same non-positive clamp-and-warn-once
 *  discipline as `resolveVoiceMintRatePerMin`: a misconfigured `0`/negative must not silently zero
 *  out the cap. */
function resolveVoiceMaxConcurrentPerOrg(): number {
	const configured = envInt("OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG", VOICE_MAX_CONCURRENT_PER_ORG_DEFAULT);
	if (configured > 0) return configured;
	if (!voiceMaxConcurrentWarned) {
		voiceMaxConcurrentWarned = true;
		console.warn(
			`[server] OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG="${configured}" is not a positive cap — falling back to the default (${VOICE_MAX_CONCURRENT_PER_ORG_DEFAULT})`,
		);
	}
	return VOICE_MAX_CONCURRENT_PER_ORG_DEFAULT;
}

/** Maps a `CoordinatorResult` failure reason (voice-call-manager.ts) to an HTTP status. Every reason
 *  is one of the coordinator's own honest, closed set — `forbidden` (room membership/role denied),
 *  `no-active-call` (nothing to act on), `bridge-unavailable` (degraded/no live socket to relay to),
 *  or a free-text broker/bridge failure detail (start-time errors) — never a generic 500. */
function voiceCallErrorResponse(reason: string): Response {
	if (reason === "forbidden") return new Response("forbidden", { status: 403 });
	if (reason === "no-active-call") return new Response(reason, { status: 404 });
	if (reason === "bridge-unavailable") return new Response(reason, { status: 409 });
	if (reason.includes("already has an active call")) return new Response(reason, { status: 409 });
	return new Response(reason, { status: 502 });
}

export interface VoiceMintRouteContext extends MatchContext {
	/** The ONE org-aware resolver input — computed by handle() from dbMode/db/orgId, both routes
	 *  build their key-presence answer from it so they can never drift onto two different notions
	 *  of "does this caller have a voice key". */
	voiceScope: VoiceKeyScope;
	/** The SAME resolved role the request's authz gate already used, not re-derived. */
	role: Role;
	actor: Actor;
	/** Possibly absent (the lane runs before the `!manager` gate) — used for the mint audit only. */
	manager: SquadManager | undefined;
	/** Per-actor mint rate cap (server-instance state, passed as a thunk). */
	voiceMintRateAllowed: (actor: Actor) => boolean;
}

const VOICE_MINT_ROUTES: readonly Route<VoiceMintRouteContext>[] = [
	{
		method: "GET",
		pattern: "/api/voice/config",
		handler: async ({ voiceScope, role }) => {
			if (!envBool("OMP_SQUAD_VOICE_ENABLED", false)) return new Response("not found", { status: 404 });
			// MEDIUM-4, rewritten (concern 03): the old premise — no per-org attribution/budget in v1,
			// so DB mode is refused mode-wide — is gone. Mint now runs against the SESSION ORG's own
			// key under a durable per-org cap (concern 04), so the honest signal is per-org, not
			// per-mode: `enabled` reflects whether `voiceScope` actually resolves a key, in EITHER
			// mode, via the same resolver POST /api/voice/token mints through below — a flag-on daemon
			// with no resolvable key would otherwise advertise a voice button that dies at the very
			// first mint attempt (the "old mic scar" this capability probe exists to prevent).
			if (!(await orgHasKey(voiceScope))) return Response.json({ enabled: false });
			// POST /api/voice/token (the mint route, below) is operator-tier via `restActionTier`'s
			// GET=viewer/POST=operator default — a viewer can never mint. Advertising `enabled: true` to
			// a viewer anyway used to draw a "Start voice call" button that always 403s on click: config-
			// honesty and mint-capability disagreeing by RBAC tier, the same shape `orgHasKey` above
			// exists to prevent for key state. Gate the boolean itself on the SAME floor the mint route
			// enforces (never a viewer, never a hand-picked tier that could drift from it) so a viewer
			// sees `enabled: false` — no button — rather than one that can never succeed. Provider
			// posture (which keys are configured) stays gated to operator+ too (DESIGN.md red-team:
			// "leaks provider posture"), now simply implied by the same check.
			if (!roleAtLeast(role, "operator")) return Response.json({ enabled: false });
			return Response.json({ enabled: true, providers: await voiceProviderPublicInfo(voiceScope) });
		},
	},
	{
		method: "POST",
		pattern: "/api/voice/token",
		handler: async ({ voiceScope, actor, manager, voiceMintRateAllowed, req }) => {
			if (!envBool("OMP_SQUAD_VOICE_ENABLED", false)) return new Response("not found", { status: 404 });
			// MEDIUM-4, rewritten (concern 03): DB mode no longer refuses outright — the uncapped-
			// shared-dollar shape this used to guard against (DESIGN.md "Token mint" row) is gone once
			// mint resolves the SESSION ORG's own key (`voiceScope` below) with no fallback to the
			// operator's env key, ever, and no root-factory bypass. A per-org refusal falls out of the
			// ordinary "no key configured" 501 further down — the SAME path file mode has always used
			// — rather than a mode-wide 403; no active org, no configured row, and a disabled row all
			// read identically as "no key", by design (DESIGN.md Security model).
			// Per-actor mint rate cap: a cheap PRE-FILTER, not the org bound (rewritten, concern 04) — it
			// keys `actor.id` (per USER, per-process, resets on restart) and never bounded an org's
			// spend. The durable per-org bound is the concurrency check below, derived from the audit
			// table this same route writes to on a successful mint.
			if (!voiceMintRateAllowed(actor)) return new Response("rate limited", { status: 429 });
			// A genuinely-empty body (nothing sent) is a lenient default-to-openai case, same as every
			// other `decodeBodyOrEmpty` endpoint. But `req.json().catch(() => null)` used to collapse a
			// body that WAS sent but is malformed/unparseable into that exact same `null` — silently
			// minting a cost-bearing default-provider token off a request that was actually broken. Read
			// the raw text first so "nothing sent" and "sent but broken" are distinguishable: only the
			// former may fall through to the empty-body default.
			const rawBody = await req.text();
			let bodyJson: unknown = null;
			if (rawBody.trim().length > 0) {
				try {
					bodyJson = JSON.parse(rawBody);
				} catch {
					return new Response("malformed request body", { status: 400 });
				}
			}
			const decoded = decodeBody(VoiceTokenBodySchema, bodyJson);
			if (rawBody.trim().length > 0 && Result.isFailure(decoded)) {
				// Valid JSON but not struct-shaped (e.g. a bare string/array/number) — still a body that
				// was sent and is invalid, not a legitimately-absent one.
				return new Response("invalid voice token request body", { status: 400 });
			}
			const body = Result.isSuccess(decoded) ? decoded.success : ({} as { provider?: unknown });
			const providerId = typeof body.provider === "string" && body.provider ? body.provider : "openai";
			// Mint via the SAME resolver `orgHasKey`/`GET /api/voice/config` already consulted — a
			// newline/space-padded env value (file mode) used to make the config probe advertise
			// `enabled:true` while every mint 502s against the untrimmed, invalid key (config-honesty
			// and mint disagreeing on the same key). Routing both through `voiceKeyFor` keeps that
			// impossible by construction, in either mode.
			const apiKey = isKnownVoiceProvider(providerId) ? await voiceKeyFor(voiceScope, providerId) : undefined;
			// Durable per-org concurrency cap (plans/voice-db-mode/04-spend-controls.md, DESIGN.md "Org
			// spend bound" row): count this ORG's own `voice.mint` audit rows inside the provider's
			// max-session window and refuse beyond N — restart-safe and correct across replicas because
			// it's derived from the `audit` table, not an in-memory map (the rejected draft's "second
			// in-memory map keyed by org"). File mode has no org concept and is exempt — its only
			// daemon-side bound is the per-actor pre-filter above.
			//
			// The slot is RESERVED (row written) here, BEFORE `mintVoiceToken`'s network round trip —
			// not counted-then-written-after like the earlier draft. That earlier shape let every
			// request in flight during the mint's latency window see the same stale pre-mint count,
			// so N+K parallel mints could all pass; reserving first closes that race (proven with a
			// parallel-mint regression test, tests/voice-spend.test.ts). `reserveOrgAuditSlot` counts
			// and inserts inside one transaction (Postgres additionally advisory-locks per org+action —
			// see its doc comment for why SQLite doesn't need to).
			const dbAuditable = voiceScope.mode === "db" && voiceScope.ctx && voiceScope.orgId ? { ctx: voiceScope.ctx, orgId: voiceScope.orgId } : undefined;
			let reservedAuditId: number | undefined;
			if (apiKey && dbAuditable && isKnownVoiceProvider(providerId)) {
				// The window a mint counts as "possibly still live" is the provider's own session cap
				// PLUS the token's establishment TTL (`voiceTokenTtlSeconds`, already clamped there) — a
				// token isn't established the instant it's minted; the caller has up to the TTL to open
				// the WebRTC connection, and only then does the provider's own session clock start.
				// Counting only `maxSessionWindowMs` from mint time let a session established late
				// (mint + up to TTL) stay live until mint + TTL + maxSessionWindowMs, while its
				// reservation dropped out of the count at mint + maxSessionWindowMs — a gap of up to the
				// TTL during which the cap undercounts genuinely-live sessions (plans/voice-db-mode/
				// 04-spend-controls.md concern 02 fix).
				const windowMs = voiceProviderMaxSessionWindowMs(providerId) + voiceTokenTtlSeconds() * 1000;
				const cap = resolveVoiceMaxConcurrentPerOrg();
				const reservation = await reserveOrgAuditSlot(dbAuditable.ctx, dbAuditable.orgId, { actor: actor.id, action: VOICE_MINT_AUDIT_ACTION, target: providerId, source: "voice" }, cap, Date.now() - windowMs);
				if (!reservation.reserved) {
					// The refusal is itself auditable — a DISTINCT action so a burst of refusals can never
					// inflate the very count they're a consequence of.
					await appendOrgAudit(dbAuditable.ctx, dbAuditable.orgId, { actor: actor.id, action: "voice.mint.refused", target: providerId, detail: { cap, windowMs } });
					// Named honestly as a rate cap, not a "someone else is on a call" concurrency signal: it's
					// mints-per-window (the daemon can't see a session end), so a burst of short calls can trip
					// it with nobody else active. DESIGN.md "Cap tuning": "a rate cap is not a budget, and must
					// not be described as one" — the flip side holds too, it must not be described as presence.
					return new Response(`this organization has reached its voice mint limit (${cap} per ${Math.round(windowMs / 60_000)} minutes); try again later`, { status: 429 });
				}
				reservedAuditId = reservation.auditId;
			}
			const result = await mintVoiceToken(providerId, apiKey);
			if (!result.ok) {
				// Compensate: the mint never happened, so the reserved slot must not count against the
				// org's cap — a provider 502 must not permanently consume a concurrency slot.
				if (dbAuditable && reservedAuditId !== undefined) await deleteOrgAuditRow(dbAuditable.ctx, dbAuditable.orgId, reservedAuditId);
				return new Response(result.message, { status: result.status });
			}
			// Mint audit, in BOTH modes (mints are unaudited today, everywhere) — actor `db:<userId>` in
			// DB mode (never role-derived: `actor` was already resolved that way above, not re-derived
			// here), provider, and the provider's OWN session id (previously discarded). Awaited (not
			// `void`, unlike most other `recordAudit` call sites in server.ts) so the response the
			// browser receives is only sent once the audit trail actually reflects the mint that
			// produced it — `recordAudit` itself still swallows a disk failure rather than throwing.
			if (manager) await manager.recordAudit(actor, VOICE_MINT_AUDIT_ACTION, providerId, "ok", result.providerSessionId ? `provider session ${result.providerSessionId}` : undefined, "voice");
			if (dbAuditable) {
				const detail = result.providerSessionId ? { providerSessionId: result.providerSessionId } : undefined;
				if (reservedAuditId !== undefined) {
					// The common path: the reserved row already exists (id/actor/action/target/at) —
					// finalize just overwrites its detail with the provider session id now that the mint
					// actually happened.
					await finalizeOrgAuditDetail(dbAuditable.ctx, dbAuditable.orgId, reservedAuditId, { detail, source: "voice" });
				} else {
					// No reservation was made (apiKey/provider gating above didn't match — can only
					// happen if mintVoiceToken succeeded despite that, which its own no-apiKey/unknown-
					// provider guards make unreachable in practice). Fall back to the old direct write
					// rather than silently dropping the audit row.
					await appendOrgAudit(dbAuditable.ctx, dbAuditable.orgId, { actor: actor.id, action: VOICE_MINT_AUDIT_ACTION, target: providerId, detail, source: "voice" });
				}
			}
			return Response.json(result.token);
		},
	},
];

const VOICE_CALL_ROUTES: readonly Route<RouteContext>[] = [
	// ── Voice calls surface (concern 10, plans/voice-orchestrated-room-integration) ─────────────
	// Org-wide, NOT channel-scoped — a person needs to see (and end) a call they cannot otherwise
	// reach through any one room, which is exactly the orphan case this surface exists for. The
	// binding half is still filtered to channels `actor` can read (`listVoiceCallsSurface`); the
	// orphan half has no channel to filter by at all, by definition.
	{
		method: "GET",
		pattern: "/api/voice-calls",
		handler: async ({ manager, actor }) => Response.json(await manager.listVoiceCallsSurface(actor)),
	},
	{
		method: "POST",
		pattern: /^\/api\/voice-calls\/orphans\/([^/]+)\/end$/,
		handler: async ({ manager }, [callId]) => {
			const result = await manager.endOrphanVoiceCall(callId!);
			return result.ok ? Response.json(result.value) : voiceCallErrorResponse(result.reason);
		},
	},
	// ── Voice call (concern 02, plans/voice-orchestrated-room-integration) ─────────────────────
	// Every route is channel-scoped: `manager.voiceCall*` re-checks room membership itself
	// (`ChannelStore#canReadChannel`) before touching the binding, and the mutating routes pass
	// that same authorization down into the coordinator as the LAST gate before any bridge frame
	// is relayed (voice-call-manager.ts). The RBAC tier above (`restActionTier`'s coarse GET=viewer/
	// mutation=operator default — no bespoke entry needed, these paths don't match any of the
	// more specific rules) is the FIRST gate; both must pass.
	{
		method: "GET",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call$/,
		handler: async ({ manager, actor }, [channelId]) => {
			try {
				const state = await manager.voiceCallState(channelId!, actor);
				return state ? Response.json(state) : new Response("no call for this channel", { status: 404 });
			} catch (err) {
				if (err instanceof Error && err.message === "channel forbidden") return new Response("forbidden", { status: 403 });
				throw err;
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call$/,
		handler: async ({ manager, actor, req }, [channelId]) => {
			const decoded = decodeBodyOrEmpty(VoiceCallStartBodySchema, await req.json().catch(() => null));
			const sessionRoot = typeof decoded.sessionRoot === "string" ? decoded.sessionRoot : undefined;
			const retention = decoded.retention === "full" || decoded.retention === "tails" || decoded.retention === "off" ? decoded.retention : undefined;
			const resumeSessionId = typeof decoded.resumeSessionId === "string" ? decoded.resumeSessionId : undefined;
			const agentId = typeof decoded.agentId === "string" && decoded.agentId.trim() ? decoded.agentId.trim() : undefined;
			const result = await manager.startVoiceCall(channelId!, actor, { sessionRoot, retention, resumeSessionId, agentId });
			return result.ok ? Response.json(result.value, { status: 201 }) : voiceCallErrorResponse(result.reason);
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call$/,
		handler: async ({ manager, actor }, [channelId]) => {
			const result = await manager.endVoiceCall(channelId!, actor);
			return result.ok ? Response.json(result.value) : voiceCallErrorResponse(result.reason);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/decisions$/,
		handler: async ({ manager, actor }, [channelId]) => {
			try {
				return Response.json({ decisions: await manager.voiceCallDecisions(channelId!, actor) });
			} catch (err) {
				if (err instanceof Error && err.message === "channel forbidden") return new Response("forbidden", { status: 403 });
				throw err;
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/decisions\/([^/]+)\/resolve$/,
		handler: async ({ manager, actor, req }, [channelId, decisionId]) => {
			const decoded = decodeBody(VoiceCallResolveDecisionBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response(`bad resolve decision: ${decoded.failure.message}`, { status: 400 });
			const result = await manager.resolveVoiceCallDecision(channelId!, actor, { decisionId: decisionId!, ...decoded.success });
			return result.ok ? Response.json(result.value) : voiceCallErrorResponse(result.reason);
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/steer$/,
		handler: async ({ manager, actor, req }, [channelId]) => {
			const decoded = decodeBody(VoiceCallSteerBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response(`bad steer: ${decoded.failure.message}`, { status: 400 });
			const result = await manager.steerVoiceCall(channelId!, actor, decoded.success.text);
			return result.ok ? Response.json({ ok: true }) : voiceCallErrorResponse(result.reason);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/transcript$/,
		handler: async ({ manager, actor }, [channelId]) => {
			try {
				return Response.json({ transcript: await manager.voiceCallTranscript(channelId!, actor) });
			} catch (err) {
				if (err instanceof Error && err.message === "channel forbidden") return new Response("forbidden", { status: 403 });
				throw err;
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/artifacts$/,
		handler: async ({ manager, actor }, [channelId]) => {
			try {
				return Response.json({ artifacts: await manager.voiceCallArtifacts(channelId!, actor) });
			} catch (err) {
				if (err instanceof Error && err.message === "channel forbidden") return new Response("forbidden", { status: 403 });
				throw err;
			}
		},
	},
	// One artifact's immutable snapshot bytes (concern 03's room Markdown viewer). Every failure the
	// store names gets a DISTINCT answer, because the viewer renders each one differently — a
	// `ready` row whose snapshot file has vanished must never arrive as an empty document.
	{
		method: "GET",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/artifacts\/([^/]+)$/,
		handler: async ({ manager, actor }, [channelId, artifactId]) => {
			try {
				const result = await manager.voiceCallArtifact(channelId!, actor, artifactId!);
				if (result.ok) return Response.json({ artifact: result.record, content: result.content });
				if (result.reason === "not-found") return new Response("no such artifact for this channel", { status: 404 });
				return Response.json({ artifact: result.record, error: result.reason, detail: result.detail }, { status: result.reason === "too-large" ? 413 : 409 });
			} catch (err) {
				if (err instanceof Error && err.message === "channel forbidden") return new Response("forbidden", { status: 403 });
				throw err;
			}
		},
	},
	// Visible mute (concern 03's HUD). A SET, not the wire's own toggle — see
	// `VoiceCallCoordinator#setMuted` for why the daemon owns the idempotence.
	{
		method: "POST",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/mute$/,
		handler: async ({ manager, actor, req }, [channelId]) => {
			const decoded = decodeBody(VoiceCallMuteBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response(`bad mute: ${decoded.failure.message}`, { status: 400 });
			const result = await manager.setVoiceCallMuted(channelId!, actor, decoded.success.muted);
			return result.ok ? Response.json(result.value) : voiceCallErrorResponse(result.reason);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/gaps$/,
		handler: async ({ manager, actor }, [channelId]) => {
			try {
				return Response.json({ gaps: await manager.voiceCallGaps(channelId!, actor) });
			} catch (err) {
				if (err instanceof Error && err.message === "channel forbidden") return new Response("forbidden", { status: 403 });
				throw err;
			}
		},
	},
	// Concern 10 (call-management-ui): the user-triggered reconnect — see
	// `VoiceCallCoordinator#reattach`. No body: there is nothing to negotiate, only whether the
	// binding's own callId can be corroborated against the broker right now.
	{
		method: "POST",
		pattern: /^\/api\/channels\/([^/]+)\/voice-call\/reattach$/,
		handler: async ({ manager, actor }, [channelId]) => {
			const result = await manager.reattachVoiceCall(channelId!, actor);
			return result.ok ? Response.json(result.value) : voiceCallErrorResponse(result.reason);
		},
	},
];

/** The voice MINT lane's adapter — dispatched BEFORE the `!manager` gate (see module doc). */
export async function handleVoiceMintRoutes(url: URL, req: Request, ctx: Omit<VoiceMintRouteContext, "url" | "req">): Promise<Response | undefined> {
	return dispatchRoutes(VOICE_MINT_ROUTES, { url, req, ...ctx });
}

/** The voice CALL lane's adapter — ordinary manager-tier dispatch, same fall-through contract. */
export async function handleVoiceCallRoutes(url: URL, req: Request, manager: SquadManager, actor: Actor): Promise<Response | undefined> {
	return dispatchRoutes(VOICE_CALL_ROUTES, { url, req, manager, actor });
}
