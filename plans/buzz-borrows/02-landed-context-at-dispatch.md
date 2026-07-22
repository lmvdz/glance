# Landed-context block at dispatch/steer — siblings learn results when they exist
STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (createWithId prompt assembly ~:5902, steer/redispatch prompt composition), src/land-assessment/store.ts (read API), src/digest.ts (consumers), tests
MODE: afk

## Goal
A newly dispatched or steered unit whose declared `requires` overlaps a recently landed sibling's `produces` receives a manager-authored "Recently landed" context block in its prompt — the result, branch, and outcome of the lands it depends on. This replaces the researched "durable outbox" concept, which the design round killed: the spawn gate (`requiresConflict`, src/squad-manager.ts:5965) forbids a requires-overlapping unit from coexisting with its producer, so dependents spawn AFTER the land and an emit-time outbox targets a structurally empty recipient set. Dispatch is the moment dependents exist; deliver there.

## Approach
1. Read side: a small query over the land-assessment store (src/land-assessment/store.ts month-sharded events + snapshots) and/or `transitions.jsonl` — recent landed/rejected terminals with agentId, name, produces, branch, sha, outcome, within a bounded window (e.g. last 7 days / last N lands). If `OMP_SQUAD_LAND_ASSESSMENT` is off, fall back to transitions + persisted roster fields so the block degrades rather than disappears.
2. Compose at the same join point as the existing prompt layers (appendSystemPrompt join at src/squad-manager.ts:5902, alongside primer/DO_NOT/authored-spec): when the new unit declares `requires`, select lands whose `produces` overlap (write a purpose-built overlap helper alongside src/ownership.ts:122 — do NOT reuse `requiresConflict` verbatim: it skips stopped/error owners and checks the wrong direction, per design review finding). When no `requires` declared, include at most a 3-5 line fleet-recent-lands digest (one line per land) or nothing — do not spam every dispatch.
3. Same injection on the steer path for long-lived units (where the steer prompt is composed), bounded to lands since the unit's last turn.
4. Trust: the block is manager-authored but embeds agent/user-chosen strings (unit names, branch names). Run every such field through `neutralizeDelimiters` + `redact`, or wrap the whole block with `fenceUntrusted` (src/digest.ts) — the existing peer-message path (src/squad-manager.ts:7223) is the precedent. Never interpolate raw.
5. `squad_message` / `deliverPeerMessage` (src/squad-manager.ts:7197) stays exactly as-is — budget, fencing, advisory semantics untouched. This concern adds no agent-to-agent channel and no delivery state; it is pure dispatch-time context.
6. Explicitly out of scope (recorded in 00-overview): durable outbox with watermarks (until a measured coexistence pattern appears), cross-host federation routing, any wake/nudge of idle units.

## Cross-Repo Side Effects
None. UI-invisible.

## Verify
- Scratch daemon: land unit A (produces `src/foo/`), then dispatch unit B (requires `src/foo/`) — B's opening prompt contains the fenced landed-context block naming A's land, branch, sha.
- Dispatch a unit with no requires — block absent or ≤5 lines.
- Land-assessment flag off — block still appears from the transitions fallback.
- Unit named with fence-escape garbage appears neutralized.
- Prompt-size check: block bounded (assert a cap in tests).

## Resolution
Superseded-into plans/the-room 2026-07-22 (see the-room 00-overview + DESIGN.md; this concern's reviewed content was carried/reshaped there).
