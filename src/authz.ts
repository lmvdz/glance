/**
 * authz.ts — the single role↔action permission map (OMPSQ-36 / P3).
 *
 * One source of truth for "which tier may do what", enforced IDENTICALLY at both surfaces:
 *   - WS / in-process commands → `commandTier`, checked at the manager's `applyCommand`
 *     chokepoint (squad-manager.ts).
 *   - REST → `restActionTier`, checked by the single gate
 *     `roleAtLeast(role, requiredRole(method, pathname))` at the top of server.ts `handle()`.
 * auth.ts re-exports these under the legacy `commandRole` / `requiredRole` names so every
 * existing caller picks up the finer map with no scattered edits.
 *
 * Tier model (auth.ts): viewer ⊂ operator ⊂ admin. Reads are viewer; everyday driving
 * (prompt / answer / interrupt, create / commission) is operator; destructive lifecycle ops
 * (kill / restart / remove, land / landFeature / verifyFeature, daemon re-exec) are admin.
 * In file mode `effectiveRole` grants local surfaces admin, so single-tenant keeps doing
 * everything; only DB-mode members (bridgeRole org-member ⇒ operator) lose destructive ops.
 *
 * ponytail: DEFERRED authorization concepts — no backing system exists yet, so they are
 * intentionally NOT modeled here. Faking them would mean authorizing against tables/identities
 * that don't exist. Add each when its backing system lands; until then authz is pure role↔action:
 *   - agent-API-key permissions (agent:interact / agent:create scopes)
 *   - per-resource "creator" ownership (only the creator may kill/land their own agent)
 *   - owner-vs-admin distinction within an org
 *   - org / member / API-key management authz
 */

import type { ClientCommand, Role } from "./types.ts";

/** Minimum tier a `ClientCommand` requires — the finer map that supersedes the old coarse
 *  "every mutation ⇒ operator". Reads (snapshot/subscribe) are viewer; everyday driving
 *  (prompt/answer/interrupt, create/commission) is operator; destructive lifecycle ops
 *  (kill/restart/remove) are admin. */
export function commandTier(cmd: ClientCommand): Role {
	switch (cmd.type) {
		case "snapshot":
		case "subscribe":
			return "viewer";
		case "kill":
		case "restart":
		case "remove":
			return "admin";
		// prompt / answer / interrupt / create / commission
		default:
			return "operator";
	}
}

/** Minimum tier a REST route requires — supersedes the old requiredRole, adding the destructive
 *  direct-manager mutation routes (agent land, feature land, feature verify) → admin. `/api/upgrade`
 *  re-execs the daemon (admin). Reads are viewer; auth/check + push registration are
 *  any-authenticated (viewer); every other mutation is operator.
 *
 *  Note: `/api/command` stays operator here — it is a REST transport for WS-style commands, so the
 *  per-command tier (incl. admin for kill/restart/remove) is enforced downstream by `commandTier`
 *  inside `applyCommand`, the SAME single chokepoint the WS surface uses. No second authz site. */
export function restActionTier(method: string, pathname: string): Role {
	if (pathname === "/api/upgrade") return "admin";
	// Destructive direct-manager mutations whose server.ts handlers bypass applyCommand.
	if (/^\/api\/agents\/[^/]+\/land$/.test(pathname) || /^\/api\/features\/[^/]+\/(land|verify)$/.test(pathname)) {
		return "admin";
	}
	if (pathname === "/api/auth/check" || pathname.startsWith("/api/push/")) return "viewer";
	return method === "GET" ? "viewer" : "operator";
}
