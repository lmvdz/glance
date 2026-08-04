/**
 * The lane-route seam (plans/deepen-modules/05, slice 1) — server.ts's handle() is a 2,300-line
 * if-chain where matching, authz and business logic interleave per branch, so the API surface
 * cannot be enumerated and every new route edits the same function everyone else is editing.
 * This module is the seam's interface: a lane declares its routes as DATA (`Route[]`) and
 * handle() dispatches one lane table with one call.
 *
 * Scope discipline (why this is small): the matcher needs nothing but the request
 * (`MatchContext`); everything else a lane's handlers touch is declared on that lane's own
 * context type and passed explicitly at its dispatch site. Manager-tier lanes
 * (feedback-routes.ts, routes/memory.ts, routes/attention.ts) extend `RouteContext`; the
 * org/auth lane (routes/org.ts) dispatches BEFORE manager/actor resolution and extends
 * `MatchContext` directly with its session/role/db trio. Routes needing server-instance
 * context stay in handle() until their lane's own slice moves them with that context made
 * explicit — never smuggled through closures.
 *
 * Authz note: the authz.ts default floor (GET ⇒ viewer, mutation ⇒ operator) has ALREADY run
 * before dispatch — same as every branch of the if-chain. A `Route` here does not weaken or
 * re-derive that; per-route scope tightening stays inside the handler exactly as it did inline.
 */
import type { SquadManager } from "../squad-manager.ts";
import type { Actor } from "../types.ts";

/** What the MATCHER itself needs — nothing but the request. Lanes that run before manager/actor
 *  resolution (the org/auth lane dispatches on session+role, not on a manager) extend THIS;
 *  manager-tier lanes extend `RouteContext` below. */
export interface MatchContext {
	url: URL;
	req: Request;
}

export interface RouteContext extends MatchContext {
	manager: SquadManager;
	actor: Actor;
}

export type RouteHandler<C extends MatchContext = RouteContext> = (ctx: C, params: string[]) => Promise<Response> | Response;

/** Generic over the context so a lane may EXTEND it with explicit extra deps (the attention
 *  lane's viewer identity, the org lane's session/role/db trio) instead of smuggling
 *  server-instance state through closures. */
export interface Route<C extends MatchContext = RouteContext> {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Exact pathname, or a RegExp whose capture groups arrive (decoded) as `params`. */
	pattern: string | RegExp;
	handler: RouteHandler<C>;
}

/** Dispatch one lane's table. `undefined` = no route matched — the caller's chain continues
 *  (the same fall-through contract handleFeedbackRoutes established). First match wins;
 *  registration order is the precedence order, exactly like the if-chain it replaces. */
export async function dispatchRoutes<C extends MatchContext>(routes: readonly Route<C>[], ctx: C): Promise<Response | undefined> {
	for (const route of routes) {
		if (route.method !== ctx.req.method) continue;
		if (typeof route.pattern === "string") {
			if (ctx.url.pathname === route.pattern) return route.handler(ctx, []);
			continue;
		}
		const m = ctx.url.pathname.match(route.pattern);
		if (m) return route.handler(ctx, m.slice(1).map((p) => decodeURIComponent(p ?? "")));
	}
	return undefined;
}

/** Query-param helper shared by lane tables (moved from server.ts's private copy). */
export function boundedNumber(raw: string | null, fallback: number, min: number, max: number): number {
	const n = raw === null ? fallback : Number(raw);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
