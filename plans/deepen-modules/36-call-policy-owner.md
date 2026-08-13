# CallPolicy — every number owns its copy
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: webapp/src/context/VoiceCallContext.tsx:407-409 (fires at 3 min, toasts "10 minutes"), webapp/src/lib/voice/callHud.ts:216 (CALL_IDLE_TIMEOUT_MS = 3 min, "Tightened 10min→3min Lars 2026-07-15") + :209 (MAX_CALL_DURATION_MS) + :325-349 (PTT state machine — three unrelated modules under one filename), webapp/src/lib/voice/roomCall.ts:278-299 (IDLE_HANGUP_MS 10 min room lane + idlePolicyLine countdown copy), tests/voice-spine-policy.test.ts:12
MODE: afk

## Goal
Includes the round's headline: webapp/src/components/hub/VoiceCallHud.tsx (305 lines,
VoiceCallHudView + callIsIdleCritical) has ZERO production importers — its controls moved to
Composer's icon row and the component was never deleted, taking the idle-hangup warning
(idlePolicyLine's countdown, rendered only at VoiceCallHud.tsx:172) down with it. The shipped
idle policy is invisible on screen while VoiceWorkspace.test.tsx's 24 render sites keep it
green. Disposition in this concern: delete the HUD, and resurrect the idle line as a 4th
precedence tier in VoiceStatusRegion (111 lines, already owns ThreadStatus precedence;
HubShell:451-456 already ticks a minute cadence — exactly what idlePolicyLine needs).

The PTT lane and the room lane mirror each other's policy with no shared boundary — two idle
timeouts, two "ended" copies, two error-copy tables — and the proven failure mode is a
user-facing lie: the idle toast quotes the room lane's 10 minutes while the PTT predicate
fires at 3. Seam: one CallPolicy module holding LANE-TAGGED constants and copy DERIVED from
them (`idleHangupCopy(timeoutMs)`), so no string can name a number it doesn't own. Include the
mechanical callHud.ts split (spendCaps / ptt / formatting-copy — zero internal calls between
the blocks) so the contradiction class is visible on sight. The spine-policy test then pins
the derivation, not a copied literal. Fix the :408 toast in the same slice — it is the
one-line proof the seam works.

## Provenance
Round-3 review, webapp agent items 4 + 9a + 9b; carried from round-2's candidate inventory
(VoiceCallContext copy contradiction).
