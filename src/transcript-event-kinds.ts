// Typed transcript event kinds currently emitted by the daemon.
// Landing-order rule: do not add a constant until the same change ships a reader/test for it.
// Reserved names for later room-card readers: spawn-proposal, plan-card,
// token-burn-snapshot, design-revised.
export const TRANSCRIPT_EVENT_LAND_ATTEMPT = "land-attempt";
export const TRANSCRIPT_EVENT_LAND_ASSESSMENT = "land-assessment";
export const TRANSCRIPT_EVENT_LAND_MERGE = "land-merge";
export const TRANSCRIPT_EVENT_GATE_VERDICT = "gate-verdict";
export const TRANSCRIPT_EVENT_NEEDS_YOU = "needs-you";
