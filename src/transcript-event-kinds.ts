// Typed transcript event kinds currently emitted by the daemon.
// Landing-order rule: do not add a constant until the same change ships a reader/test for it.
// Reserved names for later room-card readers: spawn-proposal, design-revised.
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
export const TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT = "token-burn-snapshot";
