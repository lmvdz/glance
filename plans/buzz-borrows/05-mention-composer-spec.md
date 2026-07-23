# @mention-as-steer in the chat composer — spec-first, t3-face lane
STATUS: cancelled
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: webapp/src/components/chat/Composer.tsx, webapp/src/hooks/chat/useTriggerMenu.ts, webapp/src/lib/chat/sendCore.ts, webapp/src/lib/agent-control.ts
BLOCKED_BY: 04
MODE: afk

## Goal
@mentioning a unit in the chat composer steers it — chat becomes the control plane (buzz's mention-as-dispatch, the loved daily-driver ergonomic; reinforces "steer stays our lead" from t3code research). This concern is SPEC-FIRST and belongs to the t3-face lane's sequencing (2026-07-18 directive: desktop look/feel to LOVED state before new surfaces). It is filed here so the design round's findings aren't lost; execute it inside the t3-face plan.

## Approach
Design questions the spec must answer BEFORE wiring (each killed the naive version in review):
1. **Reply routing**: glance has no shared room — `{type:"prompt"}` appends to the TARGET's transcript. If Lars mentions unit B from a surface bound to unit A, where does B's reply render? Options: the current surface renders cross-unit reply cards (needs t3-face card work), or mention navigates to B's room, or a true multi-unit room view. This is a product-taste call for the t3-face lane (Lars reviews the spec like any t3-face concern).
2. **Trigger collision**: `@` is already bound to task mentions (Composer.tsx:628-636, search over tasks). Pick: merged ranked source under `@`, or a distinct trigger for units. Reuse useTriggerMenu's multi-trigger machinery (verified extensible); don't hand-roll matching.
3. **Semantics**: mention steers existing roster entries only (running or idle — `ensureConnected` resumes idle fine); it NEVER spawns new units (spawn-time scope checks + worktree creation don't belong in a text box typo path). Non-resident/removed targets surface the 04 nack.
4. Wiring once specced: detectTrigger source addition; submit routes `steerCommand(mentionedId, message)` over the existing WS path (webapp/src/lib/ws.ts) — daemon accepts today unchanged; ack/nack from concern 04 drives the pending/failure UI state.

## Cross-Repo Side Effects
None.

## Verify
- Spec reviewed and approved within the t3-face lane before any wiring PR.
- After wiring: mention → target steered (transcript shows the prompt), ack renders; mention of removed unit → visible failure state, no silent drop; task-mention behavior unregressed (Composer tests).

## Resolution
Superseded-into plans/the-room 2026-07-22 (see the-room 00-overview + DESIGN.md; this concern's reviewed content was carried/reshaped there).
