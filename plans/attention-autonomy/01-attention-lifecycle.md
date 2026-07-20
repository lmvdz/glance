# 01 — Attention-item lifecycle: birth, TTL, resolution state

STATUS: open
PRIORITY: p0
COMPLEXITY: architectural
BLOCKED_BY: p0
TOUCHES: src/attention-lifecycle.ts (new), src/squad-manager.ts, src/attention-ladder.ts, src/server.ts

## Goal
"An attention item" becomes a first-class record with a lifecycle, not a derived view over live DTO
state. New pure module `attention-lifecycle.ts`: AttentionItem projection unifying the three
sources (pending requests split by gateClassOf, error-rung units, attentionEvents) with
{origin, tier, createdAt, state}, state ∈ open | auto-resolved | absorbed | expired-to-digest |
answered-by-human. Janitor sweep in SquadManager (Opportunity.tick shape; automation-log loop
`attention-ttl`) evaluates the 00-overview TTL table each tick. Expiry ≠ deletion: expiry emits a
durable AttentionResolution record (<stateDir>/attention-resolutions.jsonl, JsonlLog idiom) with
provenance — Concern 05's input. Ladder excludes expired/absorbed; /api/attention/ladder reflects
lifecycle state.

## Verify
Pure-policy unit tests with the tier→TTL table pinned. Scratch-daemon: seed a stuck input unit
with backdated createdAt; observe it leave the lane with a resolution record.
