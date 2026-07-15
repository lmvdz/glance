# Push-enable nudge at call start
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/chat/VoiceCallPill.tsx, webapp/src/components/chat/VoiceCallPill.test.tsx, webapp/src/lib/voice/callHud.ts, webapp/src/lib/voice/callHud.test.ts

## Goal
The whole away-loop is inert if notification permission was never granted. When a call is active
and `pushPermission() === 'default'` (never asked), the pill shows a one-line dismissible nudge —
"Enable notifications to get pinged when agents finish" — whose button calls `enablePush()`
(user gesture, existing lib/push.ts helper). Granted/denied/unsupported → render nothing, ever.

## Approach
Pure decision helper in callHud.ts: `shouldShowPushNudge(permission: 'default'|'granted'|'denied'|
'unsupported', dismissedThisCall: boolean): boolean` (+ its copy string) with tests. Pill renders
it above the state row, mirroring the reconnectNotice banner's styling; dismiss is per-call React
state (no persistence — a once-per-call whisper, not a nag). On click: `enablePush()`; on
'granted' hide, on 'denied' hide (the browser said no — respect it). Import `enablePush`/
`pushPermission` from ../../lib/push.

## Cross-Repo Side Effects
None.

## Verify
`cd webapp && bun test src/components/chat/VoiceCallPill.test.tsx src/lib/voice/callHud.test.ts`
green; markup test pins nudge-present (default) and nudge-absent (granted/denied/unsupported/
dismissed) branches.
