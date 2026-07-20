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
		// continue re-animates a TERMINAL run in place: it clears the terminal marker, resets retry
		// budgets, and restarts the agent (more spend). Same destructive-lifecycle class as restart/fork
		// — admin, never the operator default (which would let an operator re-drive a dead run).
		case "continue":
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
	// Reading an answer is a read. ASKING spends model tokens and spawns a unit against a repo, which is
	// everyday driving, not administration — the same tier as creating an agent. (R5)
	if (pathname === "/api/answers" || pathname.startsWith("/api/answers/")) return method === "GET" ? "viewer" : "operator";
	// After-action reports are read-only post-mortems (GET is the only method served) — same read
	// tier as answers; the redacted gate tail is agent output, not operational posture.
	if (pathname === "/api/after-action" || pathname.startsWith("/api/after-action/")) return "viewer";
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
	// Org voice-key admin surface (plans/voice-db-mode/05-admin-endpoints.md): status, set/rotate,
	// remove, and the kill switch are ALL admin-tier — even the GET, unlike the rest of /api/org
	// (whose profile GET is viewer-readable). A voice key's mere presence/last4/enabled state is
	// provider posture (DESIGN.md red-team: "leaks provider posture" — the same reasoning already
	// keeps GET /api/voice/config's `providers` field below operator), so this is stricter than the
	// general /api/org default.
	if (pathname === "/api/org/voice" || pathname === "/api/org/voice-key" || pathname === "/api/org/voice/enabled") return "admin";
	// Harness lifecycle self-reports (fleet-ide-bridge B03) WRITE to the shared presence roster —
	// mint or release a liveness row. That is a mutation, so operator, not viewer: a read-only token
	// must not be able to spoof or clear another session's presence. The shim reads the daemon's
	// access-token (operator-or-higher in practice), so it clears this bar; the scope gate still
	// drops anything outside a registered project on top.
	if (pathname === "/api/harness-events") return "operator";
	// Promoting an issue (adw-factory-borrows concern 05) spawns an ask-mode unit and can write to
	// Plane — everyday driving, same tier as /api/answers and create/commission, not administration.
	if (/^\/api\/issues\/[^/]+\/promote$/.test(pathname)) return "operator";
	// Presence/lease reads are viewer; WRITES (the cockpit registering the human as present /
	// holding a file — fleet-ide-intervention I02) mutate shared machine-wide state, so operator.
	// The route additionally scope-gates writes to a daemon-known workspace and refuses DB mode.
	if (pathname === "/api/presence" || pathname === "/api/leases") return method === "GET" ? "viewer" : "operator";
	// The push-tap beacon is a POST but stays viewer, like push registration above it: anyone who
	// can open the app from a notification tap must be able to have that tap counted (it appends an
	// observability line, gates nothing) — an operator floor would silently zero the push-taps/day
	// adoption counter for viewer-tier devices (daily-dogfood-engine 02). This is a DELIBERATE choice,
	// not an oversight: the tier alone is not the safety boundary here. Lowering the floor to viewer
	// only holds because the write site is expected to pair it with the three guards below (shape,
	// existence, rate) — a viewer token must never be able to grow push-taps.jsonl unbounded with
	// fabricated agentId strings, because that file is the ENTIRE substrate GET /api/adoption reads
	// for the daily-driver adoption-gate verdict (plans/daily-dogfood-engine/02, 03).
	if (pathname === "/api/auth/check" || pathname === "/api/push-tap" || pathname.startsWith("/api/push/")) return "viewer";
	// Operator-attention substrate (comprehension concern 01): recording "I looked at this" is not
	// operational driving — the coarse mutation=operator default would blind fog to every non-operator
	// viewer's own attention, which defeats the point of a per-viewer signal. Explicit viewer tier for
	// BOTH the write and the reads (privacy is enforced by `redactAttentionForActor`/
	// `redactSeenMapForActor`, not by the RBAC tier — registered here anyway per DESIGN.md).
	if (pathname === "/api/attention" || pathname === "/api/attention/seen") return "viewer";
	// Needs-you ladder (t3-face concern 06): reading the roll-up and marking a unit visited are the
	// SAME "record my own attention" shape as /api/attention above, not operational driving — a
	// coarse mutation=operator default would strand every non-operator viewer's own seen-state, which
	// defeats the point of a per-viewer signal (identical reasoning to the comment above).
	if (pathname === "/api/attention/ladder" || pathname === "/api/attention/ladder/seen") return "viewer";
	// Comprehension debt read (concern 03): a per-file "how far behind is the human" number, joined
	// from receipts + the attention substrate above — same read-only, per-viewer-signal reasoning as
	// /api/attention/seen, so the same explicit viewer tier rather than the coarse GET default.
	if (pathname === "/api/fog") return "viewer";
	// Known-symptom cards (comprehension concern 07, RT2-16 "doctor-tier discovery"): reading the
	// symptom index is viewer-tier, same as `/api/fabric/search` — it's the pull-search half of the
	// SAME index the doctor auto-match pushes into a failing check's remedy at operator tier. There is
	// no REST write route here (symptoms are recorded via the `squad_record_symptom` MCP tool only).
	if (pathname === "/api/symptoms") return "viewer";
	// Weekly episode brief (comprehension concern 09): read-only, per-repo, same viewer tier as the
	// fog/symptom reads above — there is no REST write route (episodes are generated by the
	// daemon-owned `EpisodeLoop` only).
	if (pathname === "/api/episodes" || pathname.startsWith("/api/episodes/")) return "viewer";
	return method === "GET" ? "viewer" : "operator";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Push-tap write guards (finding #6, wave-1 fixer D): three independent, pure/stateless bounds the
// `/api/push-tap` write site (`SquadManager.recordPushTap`) is expected to apply BEFORE appending —
// they live next to the tier map that lets this route in at viewer, since the tier decision above
// is only safe in combination with them:
//   1. shape    — `isValidPushTapAgentId` rejects anything that isn't a plausible agent id before
//                 it's ever considered for disk.
//   2. existence — `isKnownPushTapAgentId` takes the live roster (or removed-ledger) ids from the
//                 caller (this module has no manager reference, and must not grow one just to
//                 answer "is this id real" — that would turn a pure tier map into a stateful
//                 dependency on SquadManager) and confirms the tapped id was ever real.
//   3. rate     — `allowPushTap` is a small in-memory token bucket per source key (bearer token /
//                 remote addr — the caller's choice), so even a genuine id can't be hammered into
//                 thousands of lines/sec.
// Without all three, a viewer-tier credential can inflate pushTapsByDay (src/adoption-counters.ts)
// with fabricated taps, corrupting the number Lars's daily-driver adoption-gate verdict reads.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** An agent id must never grow the push-tap ledger past what `SquadManager.recordPushTap`'s own
 *  `.slice(0, 200)` clamp already assumes is reasonable, and must contain no control characters
 *  (a JSONL line is one `JSON.stringify` away from disk either way, but a shape check here means
 *  garbage is rejected before it's even worth writing). Real agent ids are derived from a
 *  free-text `name` (see `newAgentId` in spawn-identity.ts), so the charset is intentionally
 *  permissive — this is a sanity floor, not a slug validator. */
const PUSH_TAP_AGENT_ID_MAX_LEN = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point of this regex IS to detect them
const PUSH_TAP_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function isValidPushTapAgentId(id: unknown): id is string {
	if (typeof id !== "string") return false;
	if (id.length === 0 || id.length > PUSH_TAP_AGENT_ID_MAX_LEN) return false;
	return !PUSH_TAP_CONTROL_CHAR_RE.test(id);
}

/** Pure existence check — the caller supplies the live roster ids (or a removed-agent ledger) it
 *  already holds; this module deliberately has no reference to `SquadManager` (see the class
 *  comment above authz.ts: it is a dependency-free permission map, and must stay that way). */
export function isKnownPushTapAgentId(agentId: string, knownIds: Iterable<string>): boolean {
	for (const id of knownIds) {
		if (id === agentId) return true;
	}
	return false;
}

/** Burst allowance and sustained rate for `allowPushTap` below: 10 taps immediately, refilling at
 *  10/minute after — generous for a real human tapping real notifications, far below what a
 *  scripted loop of forged agentIds could otherwise write. */
const PUSH_TAP_BUCKET_CAPACITY = 10;
const PUSH_TAP_BUCKET_REFILL_MS = 60_000 / PUSH_TAP_BUCKET_CAPACITY;

interface PushTapBucket {
	tokens: number;
	last: number;
}
const pushTapBuckets = new Map<string, PushTapBucket>();

/** Token-bucket rate check, one bucket per `sourceKey` (the write site's choice — a bearer token
 *  and/or remote addr both work; combine them for a tighter bound). Returns `true` and consumes a
 *  token iff a tap from this source is allowed right now. Pass `now` only from tests. */
export function allowPushTap(sourceKey: string, now: number = Date.now()): boolean {
	let bucket = pushTapBuckets.get(sourceKey);
	if (!bucket) {
		bucket = { tokens: PUSH_TAP_BUCKET_CAPACITY, last: now };
		pushTapBuckets.set(sourceKey, bucket);
	}
	const elapsedMs = now - bucket.last;
	if (elapsedMs > 0) {
		bucket.tokens = Math.min(PUSH_TAP_BUCKET_CAPACITY, bucket.tokens + elapsedMs / PUSH_TAP_BUCKET_REFILL_MS);
		bucket.last = now;
	}
	if (bucket.tokens < 1) return false;
	bucket.tokens -= 1;
	return true;
}

/** Test-only: drop all rate-limit state so bucket tests never leak between runs (and so a long
 *  test-process lifetime never pins memory on stale source keys). Not called from product code.
 *  @substrate exported for tests only — tests/authz.test.ts resets the bucket between cases. */
export function _resetPushTapRateLimitsForTests(): void {
	pushTapBuckets.clear();
}
