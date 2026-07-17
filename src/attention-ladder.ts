/**
 * attention-ladder.ts — the ONE server-computed priority-state cascade for a fleet unit
 * (t3-face concern 06, plans/daily-driver/01-charter-needs-you-ladder.md — "epic H"). Folds the
 * four previously-fragmented signals the charter names — `AgentStatus`, `PendingRequest[]` (split
 * by `gateClass`), land/validation outcome, and a unit's own completion-vs-visited timestamps —
 * into one ranked enum so no surface (webapp roster, cockpit panes, push, OSC lane) ever invents
 * its own ranking. `squad-manager.ts` is the only caller; server.ts never computes a rung itself.
 *
 * Two-tier design (the charter's "single state, per-viewer seen" split):
 *  - `computeLadderPriority` is VIEWER-AGNOSTIC when called with `visitedAt` omitted — the
 *    conservative default `squad-manager.ts`'s `syncLadder` uses for the shared roster object
 *    (`list()`/`getAgent()`/every `emitAgent` broadcast). Fail-closed: with no visit given, a
 *    completed unit reads as `completed-unseen`, never silently downgraded to `idle` just because
 *    nobody asked about one specific viewer yet.
 *  - The SAME function, called again with a real per-actor `visitedAt`
 *    (`SquadManager.ladderPriorityFor`, used only by server.ts's GET handlers, which are the only
 *    layer that knows the REQUESTING actor's identity), personalizes the terminal rung per viewer
 *    WITHOUT ever mutating the shared roster DTO — mutating it there would leak one viewer's
 *    seen-state into every other concurrently-polling viewer's read of the same unit. The WS
 *    broadcast frame's viewer-agnostic value is exactly what the charter calls an "invalidation
 *    hint": a consumer refetches the personalized value from the GET surface, it never trusts the
 *    broadcast field as the final per-viewer answer.
 */

import type { AgentDTO } from "./types.ts";

/** Ranked, highest-urgency first — the t3 cascade adapted to fleet reality (plans/t3-face/06). */
export type LadderPriority = "error" | "pending-approval" | "awaiting-input" | "working" | "plan-ready" | "completed-unseen" | "idle";

/** Same order `computeLadderPriority`'s cascade implements below — exported so a roll-up (max over
 *  a group) never has to re-derive the ranking from the switch statement, and a UI's own legend
 *  can iterate it instead of hardcoding the list a second time. */
export const LADDER_RANK: readonly LadderPriority[] = ["error", "pending-approval", "awaiting-input", "working", "plan-ready", "completed-unseen", "idle"];

/** Structural subset of `AgentDTO` this predicate needs — same narrowing idiom as
 *  `is-landing-unit.ts`'s `LandingUnitCandidate`, so a test fixture never has to construct a full
 *  DTO just to exercise the cascade. */
export type LadderCandidate = Pick<AgentDTO, "status" | "pending" | "landReady" | "prState" | "validation">;

export interface LadderSignals {
	/** Epoch-ms this unit last transitioned INTO `idle` (a genuine turn-end), read from the durable
	 *  transition log — deliberately NOT `dto.lastActivity` (which also moves on non-terminal
	 *  activity, and is a live/run-scoped field with no restart-survival guarantee the way the
	 *  persisted `transitions.jsonl` ring has). `undefined` ⇒ this unit has never completed a turn
	 *  (a fresh/never-run agent) — there is no completion to be "unseen" about yet. */
	completedAt?: number;
	/** Epoch-ms the REQUESTING viewer last visited this unit, or `undefined` if never (the
	 *  fail-closed default — see module doc: absence of a recorded visit is NEVER treated as
	 *  "seen"). Omit entirely for a viewer-agnostic read (the shared roster object's own hint). */
	visitedAt?: number;
}

/**
 * The ranked cascade: `error` > `pending-approval` > `awaiting-input` > `working`/connecting >
 * `plan-ready` > `completed-unseen` > `idle`.
 *
 * - `error`: a genuinely broken unit (`status === "error"`) OR a landing attempt that failed
 *   AFTER a successful spawn — an independent-validator veto (`validation.verdict === "veto"`,
 *   stamped by `runValidatorGate` the moment a land is refused) or a PR closed without merging
 *   (`prState === "closed"` — the pr-reconcile loop's exact "closed without merging" case,
 *   deliberately distinct from `"merged"`). Both are landing-failures the operator must see, not
 *   routine "waiting" states — this is the charter's "land-blocked" rung, folded into `error`
 *   rather than kept as its own rung (a land failure IS an error from the operator's point of view).
 * - `pending-approval` / `awaiting-input`: both fire only when `pending.length > 0` — the ONLY way
 *   `AgentStatus` becomes `"input"` (`deriveStatus`'s own invariant, agent-lifecycle.ts) — split by
 *   `gateClass` (the same flag `gateClassOf`, squad-manager.ts, stamps for a real workflow-gate/
 *   approval boundary vs. an ordinary question/tool-input request). A gate is a stricter ask than
 *   a question, so it outranks it.
 * - `working`: `status` is `"working"` (a turn actively streaming) or `"starting"` (t3's
 *   "connecting" — this fleet's closest analog; there is no literal `AgentStatus` "connecting").
 * - `plan-ready`: `landReady === true` — verified and staged for a one-tap Land, this fleet's
 *   analog of "a plan is ready to review/land".
 * - `completed-unseen` / `idle`: reachable only once nothing above matched. A unit with a
 *   completion (`completedAt` given) the CALLER hasn't visited since
 *   (`visitedAt === undefined || visitedAt < completedAt`) is `completed-unseen`; everything else —
 *   including a fresh unit with no completion yet, one already re-visited since, and a
 *   manually-`"stopped"` unit (the cascade names no dedicated rung for it; folding it into this
 *   terminal pair is the deliberate, documented choice here) — is `idle`.
 */
export function computeLadderPriority(dto: LadderCandidate, signals: LadderSignals = {}): LadderPriority {
	if (dto.status === "error" || dto.validation?.verdict === "veto" || dto.prState === "closed") return "error";
	if (dto.pending.length > 0) return dto.pending.some((p) => p.gateClass === true) ? "pending-approval" : "awaiting-input";
	if (dto.status === "working" || dto.status === "starting") return "working";
	if (dto.landReady === true) return "plan-ready";
	if (signals.completedAt !== undefined && (signals.visitedAt === undefined || signals.visitedAt < signals.completedAt)) return "completed-unseen";
	return "idle";
}

/** Max (most urgent) priority across a group — the cockpit spine's per-project/per-daemon
 *  roll-up (GET /api/attention/ladder). An empty group reads as `"idle"` (nothing to escalate),
 *  never a thrown/undefined case a group-header renderer would have to special-case. */
export function maxLadderPriority(priorities: LadderPriority[]): LadderPriority {
	for (const p of LADDER_RANK) if (priorities.includes(p)) return p;
	return "idle";
}
