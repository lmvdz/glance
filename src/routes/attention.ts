/**
 * Attention / needs-you-ladder / comprehension-fog routes (plans/deepen-modules/05, slice 2) —
 * moved verbatim from server.ts's handle() chain. This lane needed what slice 1's lane did not:
 * SERVER-INSTANCE context (the session-derived viewer identity and the admin bit for
 * redaction). The seam makes that explicit — `AttentionRouteContext` extends the base context
 * with `viewerId`/`isAdmin`, computed ONCE by handle() from the same session/role resolution
 * every branch already trusted, instead of each route re-deriving it or the lane reaching back
 * into the server object.
 *
 * Every incident-bought comment moved with its route; the POST fail-closed rules (server-stamped
 * viewerId/at, actor-visible repo set) are unchanged by construction — the handlers are the
 * same bytes, only the `this.` derivations became explicit context fields.
 */
import { maxLadderPriority, type LadderPriority } from "../attention-ladder.ts";
import { redactAttentionForActor, redactSeenMapForActor } from "../attention.ts";
import { computeFog, repoHasHistory } from "../comprehension-fog.ts";
import { normalizeRepoPath } from "../project-registry.ts";
import { AttentionEventBodySchema, UnitVisitBodySchema, decodeBody } from "../schema/http-body.ts";
import type { SquadManager } from "../squad-manager.ts";
import type { Actor } from "../types.ts";
import { dispatchRoutes, type Route, type RouteContext } from "./table.ts";
import { Result } from "effect";

export interface AttentionRouteContext extends RouteContext {
	/** Session-derived viewer identity — server-stamped, never client-supplied. */
	viewerId: string | undefined;
	/** The SAME resolved role the request's authz already used, not re-derived. */
	isAdmin: boolean;
}

const ATTENTION_ROUTES: readonly Route<AttentionRouteContext>[] = [
	// Operator-attention substrate (comprehension concern 01): a durable, tenant-scoped record of
	// what the human has actually looked at. `viewerId`/`at` are stamped server-side, from the
	// same session-derived identity featureAuthor uses — never accepted from the client body (a
	// client-supplied viewerId would let any actor impersonate another's attention, and a
	// client-supplied `at` would let a flood backdate the seen map). `isAdmin` for redaction is
	// the SAME role this request already resolved, not re-derived.
	{
		method: "POST",
		pattern: "/api/attention",
		handler: async ({ manager, actor, req, viewerId }) => {
			if (manager.attentionDisabled()) return Response.json({ ok: false, disabled: true });
			const decoded = decodeBody(AttentionEventBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("expected { kind, repo }", { status: 400 });
			const body = decoded.success;
			// Fail CLOSED: validated against the actor-visible repo set the same way
			// buildFabricSnapshot derives it (fabric.ts's `actorVisibleRepoSet`) — an actor with no
			// derivable repos (no live agents, no persisted features) rejects EVERY repo, never
			// falls open to "unrestricted".
			if (!manager.attentionVisibleRepos(actor).has(normalizeRepoPath(body.repo))) return new Response("unknown repo", { status: 400 });
			const result = manager.recordAttention({ kind: body.kind, repo: body.repo, file: body.file, agentId: body.agentId, answerId: body.answerId, prNumber: body.prNumber, viewerId }, actor.id);
			if (!result.ok && result.reason === "rate-limited") return new Response("rate limited", { status: 429 });
			return Response.json({ ok: result.ok });
		},
	},
	{
		method: "GET",
		pattern: "/api/attention",
		handler: ({ manager, actor, url, viewerId, isAdmin }) => {
			if (manager.attentionDisabled()) return Response.json({ disabled: true });
			const visible = manager.attentionVisibleRepos(actor);
			const repoParam = url.searchParams.get("repo");
			// A foreign/unresolvable `?repo=` reads as "nothing" rather than a 400 — GETs are
			// lenient (module doc: only the POST fail-closes loudly), but never leak a repo outside
			// the actor's own visible set just because the query string named one.
			const repos = repoParam ? (visible.has(normalizeRepoPath(repoParam)) ? [repoParam] : []) : [...visible];
			const events = manager.attentionEvents(repos);
			const redacted = redactAttentionForActor(events, { viewerId, isAdmin });
			return Response.json({ events: redacted });
		},
	},
	{
		method: "GET",
		pattern: "/api/attention/seen",
		handler: ({ manager, actor, url, viewerId, isAdmin }) => {
			if (manager.attentionDisabled()) return Response.json({ disabled: true });
			const visible = manager.attentionVisibleRepos(actor);
			const repoParam = url.searchParams.get("repo");
			const repos = repoParam ? (visible.has(normalizeRepoPath(repoParam)) ? [repoParam] : []) : [...visible];
			const seen = manager.attentionSeen(repos);
			const redacted = redactSeenMapForActor(seen, { viewerId, isAdmin });
			return Response.json({ seen: redacted });
		},
	},
	// Needs-you ladder roll-up (t3-face concern 06, plans/daily-driver/01-charter-needs-you-ladder.md):
	// the cockpit spine's group headers need a max-priority per project and per daemon, not just
	// the per-unit rung already riding GET /api/agents. Personalized for the requesting viewer
	// exactly like GET /api/agents (same `ladderPriorityFor` call, same `viewerId` derivation) —
	// a foreign/unresolvable identity never sees anyone else's `completed-unseen` state resolve
	// differently.
	{
		method: "GET",
		pattern: "/api/attention/ladder",
		handler: async ({ manager, actor, viewerId }) => {
			const agents = await manager.visibleAgents(actor);
			const units = agents.map((dto) => ({ id: dto.id, repo: dto.repo, priority: manager.ladderPriorityFor(dto, viewerId) }));
			const byRepo = new Map<string, LadderPriority[]>();
			for (const u of units) byRepo.set(u.repo, [...(byRepo.get(u.repo) ?? []), u.priority]);
			const projects = [...byRepo.entries()].map(([repo, priorities]) => ({ repo, priority: maxLadderPriority(priorities) }));
			const daemon = maxLadderPriority(units.map((u) => u.priority));
			return Response.json({ units, projects, daemon });
		},
	},
	// Needs-you ladder mark-seen (t3-face concern 06): the ONE mutation that advances a viewer's
	// per-unit `lastVisitedAt`. `viewerId`/`at` are, like POST /api/attention above, ALWAYS
	// server-stamped from the session — never accepted from the client body (a client-supplied
	// viewerId would let any actor mark a unit seen on another viewer's behalf).
	{
		method: "POST",
		pattern: "/api/attention/ladder/seen",
		handler: async ({ manager, actor, req, viewerId }) => {
			const decoded = decodeBody(UnitVisitBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("expected { agentId }", { status: 400 });
			const dto = manager.getAgent(decoded.success.agentId);
			// Fail CLOSED like POST /api/attention's own repo check: an agentId outside the actor's
			// visible repo set (or that names no live agent at all) is rejected, never silently a
			// no-op 200 that would let a caller probe for the existence of a foreign unit.
			if (!dto || !manager.attentionVisibleRepos(actor).has(normalizeRepoPath(dto.repo))) return new Response("no such agent", { status: 404 });
			const result = manager.markUnitVisited(dto.id, viewerId);
			return Response.json({ ok: result.ok });
		},
	},
	// Comprehension fog (concern 03): a monotone per-file comprehension-debt read, joined from
	// every completed receipt against the attention substrate's seen map. Repos are derived from
	// the actor exactly like the two attention GETs above — NEVER solely from `?repo=` — so a
	// foreign repo named in the query string reads as "nothing" rather than leaking another
	// tenant's debt. `computeFog` itself re-filters both inputs through this same repo list
	// before joining (DESIGN.md's tenant-scoping row: a tested deliverable, not a single call
	// site's discipline), so this route's own pre-filtering is belt-and-suspenders, not the only
	// guard.
	{
		method: "GET",
		pattern: "/api/fog",
		handler: async ({ manager, actor, url }) => {
			if (manager.attentionDisabled()) return Response.json({ entries: [], repoHasHistory: {}, disabled: true });
			const visible = manager.attentionVisibleRepos(actor);
			const repoParam = url.searchParams.get("repo");
			const repos = repoParam ? (visible.has(normalizeRepoPath(repoParam)) ? [normalizeRepoPath(repoParam)] : []) : [...visible];
			const now = Date.now();
			const receipts = await manager.allReceipts();
			const seen = manager.attentionSeen(repos);
			// Concern 08: the "surprised me" chip raises a file's effective change mass without
			// inflating the raw `changesSinceSeen` count (attention.ts's durable, non-rotating
			// `SurpriseCountMap` — never the raw JSONL feed, which rotates). Carries no viewer
			// identity, so it needs no redaction pass unlike `seen` above.
			const surpriseCounts = manager.attentionSurpriseCounts(repos);
			const entries = computeFog({ receipts, seen, repos, now, surpriseCounts });
			const historyByRepo: Record<string, boolean> = {};
			for (const repo of repos) historyByRepo[repo] = repoHasHistory(seen, repo, now);
			return Response.json({ entries, repoHasHistory: historyByRepo });
		},
	},
];

/** The attention lane's route adapter — viewer context computed once by handle(), passed explicitly. */
export async function handleAttentionRoutes(
	url: URL,
	req: Request,
	manager: SquadManager,
	actor: Actor,
	viewer: { viewerId: string | undefined; isAdmin: boolean },
): Promise<Response | undefined> {
	return dispatchRoutes(ATTENTION_ROUTES, { url, req, manager, actor, viewerId: viewer.viewerId, isAdmin: viewer.isAdmin });
}
