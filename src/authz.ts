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
		// fork mirrors restart's tier: a rare, deliberate, operator-initiated action (DESIGN.md), but one
		// that mints a brand-new roster agent from a dead run's checkpoint — same destructive-lifecycle
		// class as restart, not everyday driving.
		case "fork":
			return "admin";
		// prompt / answer / interrupt / create / commission
		default:
			return "operator";
	}
}

/** Minimum tier a REST route requires — supersedes the old requiredRole, adding the destructive
 *  direct-manager mutation routes (agent land/vision, feature land, feature verify) → admin.
 *  Vision drives the daemon's browser off-box (SSRF surface, OMPSQ-152), so it is admin-only.
 *  `/api/upgrade`
 *  re-execs the daemon (admin). Reads are viewer; auth/check + push registration are
 *  any-authenticated (viewer); every other mutation is operator.
 *
 *  Note: `/api/command` stays operator here — it is a REST transport for WS-style commands, so the
 *  per-command tier (incl. admin for kill/restart/remove) is enforced downstream by `commandTier`
 *  inside `applyCommand`, the SAME single chokepoint the WS surface uses. No second authz site. */
export function restActionTier(method: string, pathname: string): Role {
	// Registering a project names a filesystem path the daemon will later create worktrees in and spawn
	// agents against. Reading the list is viewer; adding/removing one is admin — same tier as installing
	// a capability, and for the same reason: it widens what the daemon may touch.
	if (pathname === "/api/projects") return method === "GET" ? "viewer" : "admin";
	// The doctor's facts include autonomy flags and the daemon's cwd — operational posture, not secrets,
	// but not viewer-fodder either: knowing autoland is armed with the gate off is an attacker's shopping
	// list. Operator: the person who could have flipped those flags anyway.
	if (pathname === "/api/doctor") return "operator";
	if (pathname === "/api/upgrade") return "admin";
	if (pathname === "/api/settings/feature-flags") return "admin";
	if (pathname === "/api/policy/rules") return method === "GET" ? "viewer" : "admin";
	if (pathname.startsWith("/api/capability-sources") || pathname.startsWith("/api/capability-installs")) return method === "GET" ? "viewer" : "admin";
	if (pathname.startsWith("/api/capability-packs")) return method === "GET" ? "viewer" : "admin";
	// Destructive direct-manager mutations whose server.ts handlers bypass applyCommand, plus vision
	// (OMPSQ-152): it drives the daemon's browser off-box, so it is admin-only — not operator.
	if (/^\/api\/agents\/[^/]+\/(land|vision)$/.test(pathname) || /^\/api\/features\/[^/]+\/(land|verify)$/.test(pathname)) {
		return "admin";
	}
	// Assignees are the plan-vote substrate: any viewer may read them; only an admin may reassign
	// (a reassignment changes who the future majority-of-assignees vote counts).
	if (/^\/api\/features\/[^/]+\/assignees$/.test(pathname)) return method === "GET" ? "viewer" : "admin";
	// Plan-vote rounds: reading the current round/tally is viewer; calling a vote and casting a
	// ballot are consequential (a cast can auto-close a round and, on pass, hands off to the
	// commit-on-pass seam) so both are admin-gated here, same tier as assignee reassignment — the
	// FINER "is this actor even one of the round's assignees" check happens app-layer, in
	// server.ts, on top of this tier gate (feature-assignees.ts's membership helpers).
	if (/^\/api\/features\/[^/]+\/plan-vote(\/(call|cast))?$/.test(pathname)) return method === "GET" ? "viewer" : "admin";
	if (pathname === "/api/auth/check" || pathname.startsWith("/api/push/")) return "viewer";
	return method === "GET" ? "viewer" : "operator";
}
