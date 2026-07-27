// Typed transcript event kinds currently emitted by the daemon.
// Landing-order rule: do not add a constant until the same change ships a reader/test for it —
// enforced by tests/channel-card-kinds-sync.test.ts, which reads this file and the webapp
// registry (webapp/src/lib/channelTimeline.ts) and fails if they drift apart.
// Reserved names for later room-card readers: spawn-proposal.
// Event issuer namespace: the attesting authority stamped on every event envelope by the
// emitting chokepoint (never taken from client/caller input). "manager" is the only issuer
// today; foreign attestors (federated fleets, vendor capabilities) get namespaced values
// (e.g. "federated:<vendor>") if/when cross-org projection exists.
export const EVENT_ISSUER_MANAGER = "manager";

export const TRANSCRIPT_EVENT_LAND_ATTEMPT = "land-attempt";
export const TRANSCRIPT_EVENT_LAND_ASSESSMENT = "land-assessment";
export const TRANSCRIPT_EVENT_LAND_MERGE = "land-merge";
export const TRANSCRIPT_EVENT_GATE_VERDICT = "gate-verdict";
export const TRANSCRIPT_EVENT_NEEDS_YOU = "needs-you";
export const TRANSCRIPT_EVENT_PLAN_CARD = "plan-card";
export const TRANSCRIPT_EVENT_RETURN_EMIT = "return-emit";
export const TRANSCRIPT_EVENT_DESIGN_REVISED = "design-revised";
export const TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT = "token-burn-snapshot";
export const TRANSCRIPT_EVENT_UNIT_SPAWNED = "unit-spawned";
export const TRANSCRIPT_EVENT_UNIT_TURN_FINISHED = "unit-turn-finished";
export const TRANSCRIPT_EVENT_UNIT_FAILED = "unit-failed";
export const TRANSCRIPT_EVENT_PR_OPENED = "pr-opened";
export const TRANSCRIPT_EVENT_VERIFICATION_RAN = "verification-ran";
export const TRANSCRIPT_EVENT_MENTION_STEER = "mention-steer";

const TRANSCRIPT_EVENT_KINDS = [
	TRANSCRIPT_EVENT_LAND_ATTEMPT,
	TRANSCRIPT_EVENT_LAND_ASSESSMENT,
	TRANSCRIPT_EVENT_LAND_MERGE,
	TRANSCRIPT_EVENT_GATE_VERDICT,
	TRANSCRIPT_EVENT_NEEDS_YOU,
	TRANSCRIPT_EVENT_PLAN_CARD,
	TRANSCRIPT_EVENT_RETURN_EMIT,
	TRANSCRIPT_EVENT_DESIGN_REVISED,
	TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT,
	TRANSCRIPT_EVENT_UNIT_SPAWNED,
	TRANSCRIPT_EVENT_UNIT_TURN_FINISHED,
	TRANSCRIPT_EVENT_UNIT_FAILED,
	TRANSCRIPT_EVENT_PR_OPENED,
	TRANSCRIPT_EVENT_VERIFICATION_RAN,
	TRANSCRIPT_EVENT_MENTION_STEER,
] as const;

export type TranscriptEventKind = (typeof TRANSCRIPT_EVENT_KINDS)[number];

const TRANSCRIPT_EVENT_KIND_SET: ReadonlySet<string> = new Set(TRANSCRIPT_EVENT_KINDS);

/** Runtime narrowing for a `TranscriptEvent.kind` (open string) before it is re-emitted as a
 *  `ManagerChannelPost.event.kind` (closed TranscriptEventKind) — e.g. projecting a per-unit
 *  transcript fact up into a room channel card. */
export function isTranscriptEventKind(value: string): value is TranscriptEventKind {
	return TRANSCRIPT_EVENT_KIND_SET.has(value);
}
