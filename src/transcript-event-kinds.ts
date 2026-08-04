// Typed transcript event kinds currently emitted by the daemon — THE wire-contract module
// (concern 08): the webapp derives its card-kind union and exhaustive rendering map from a
// type-only import of this file, so a new kind is a webapp COMPILE error until its rendering
// entry exists. Landing-order rule: add the constant AND its TRANSCRIPT_EVENT_KINDS entry in
// the same change — tests/channel-card-kinds-sync.test.ts proves constants ⊆ list at runtime
// (the one gap tsc can't see) plus the local: namespace rule.
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
// Added post-base (main's wave-7 goal-conflict disclosure, `goalConflict`/spawnAgent in
// squad-manager.ts) — discovered by the sweep this reland's registry hardening depends on;
// registered here in the same landing as its webapp reader and schema.
export const TRANSCRIPT_EVENT_GOAL_OVERLAP = "goal-overlap";
// voice-orchestrated-room-integration concern 02: a thread-bound OMP live call, projected from the
// broker/journal into the room. `voice-call` carries the durable call-binding's own lifecycle facts
// (connecting/live/degraded/ended); `voice-decision` carries one arbiter-minted decision's state at
// the moment it was journaled (open/awaiting-confirmation/answered/expired/cancelled/failed). Both
// are bespoke inline emit sites (VoiceCallCoordinator/CallProjectionStore), never routed through the
// per-unit `projectUnitTranscriptEvent` funnel — a call is bound to a thread/channel, not to a fleet
// unit, and the daemon must not pretend the OMP live session is an `AgentDTO` to project it.
export const TRANSCRIPT_EVENT_VOICE_CALL = "voice-call";
export const TRANSCRIPT_EVENT_VOICE_DECISION = "voice-decision";
// voice-orchestrated-room-integration concern 12: one fleet-affecting action taken through a
// call's voice tool surface (steer/spawn/answer-gate), projected from the OMP journal's
// fleet-action records — plus the coordinator-authored deferred-outcome cards (executed/declined)
// for a destructive action the human resolved in the UI. Bespoke inline emit
// (VoiceCallCoordinator), never the per-unit funnel, same as its two voice siblings above.
export const TRANSCRIPT_EVENT_VOICE_FLEET_ACTION = "voice-fleet-action";

/** The canonical wire list (concern 08): the webapp derives its card-kind union and its
 *  exhaustive render-coverage map from THIS module (type-only import — no runtime coupling),
 *  so a new daemon kind is a webapp COMPILE error until its rendering entry exists, replacing
 *  the old two-file text-scrape sync test. */
export const TRANSCRIPT_EVENT_KINDS = [
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
	TRANSCRIPT_EVENT_GOAL_OVERLAP,
	TRANSCRIPT_EVENT_VOICE_CALL,
	TRANSCRIPT_EVENT_VOICE_DECISION,
	TRANSCRIPT_EVENT_VOICE_FLEET_ACTION,
] as const;

export type TranscriptEventKind = (typeof TRANSCRIPT_EVENT_KINDS)[number];

const TRANSCRIPT_EVENT_KIND_SET: ReadonlySet<string> = new Set(TRANSCRIPT_EVENT_KINDS);

/** Runtime narrowing for a `TranscriptEvent.kind` (open string) before it is re-emitted as a
 *  `ManagerChannelPost.event.kind` (closed TranscriptEventKind) — e.g. projecting a per-unit
 *  transcript fact up into a room channel card. */
export function isTranscriptEventKind(value: string): value is TranscriptEventKind {
	return TRANSCRIPT_EVENT_KIND_SET.has(value);
}
