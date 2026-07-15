# queueInjection completion callback: know when a narration was actually spoken
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/voice/voiceSession.ts, webapp/src/lib/voice/voiceSession.test.ts

## Goal
`VoiceSession.queueInjection` accepts an optional completion callback invoked when the injection
batch's OWN response finishes, with a flag telling the caller whether it completed normally or
was cancelled (barge-in) / never spoken (call torn down first). This is the primitive the debrief
cursor's two-phase commit (concern 04) stands on: commit only on `{cancelled: false}`.

## Approach
- Signature: `queueInjection(items: InjectionItem[], onDone?: (info: { cancelled: boolean }) => void)`.
- The batch already flows: queue → `flushInjectionQueue` (sends items + response.create) →
  `injection-flushed` → the response's `response.created`/`response.done`. Correlate with the
  machinery that already exists: the flush's response.create rides `pendingTriggerQueue` /
  `responseTriggerById`. Carry the callback alongside the batch in `injectionQueue`, move it to a
  "in-flight injection callback" slot at flush time, and resolve it when the response.done whose
  id claimed that flush's trigger arrives. `response.done` events carry `response.status` on the
  wire — treat `'cancelled'` (and an incomplete/failed status) as `cancelled: true`; anything
  else as false. Watch the CRITICAL-1 correlation rules: only forward when outstanding reaches 0
  today — the callback must key off the SPECIFIC response id claimed at `response.created`, not
  the outstanding counter.
- Failure paths that MUST fire `cancelled: true` exactly once: barge-in (`response.cancel` →
  response.done cancelled), `disconnect()` with the batch still queued (queue is cleared at
  voiceSession.ts `disconnect` — invoke pending callbacks there), a batch discarded during
  rotation, and the wedge-watchdog recovery path (reset + reconnect while in flight).
- Never invoke a callback twice; never leave one dangling on teardown.
- Tests: spoken-normally → `{cancelled:false}` after the injection response's done; barge-in
  mid-injection → `{cancelled:true}`; disconnect with batch queued → `{cancelled:true}`; two
  queued batches each get their own callback in order; existing queueInjection call sites
  (dispatcher narrations) compile unchanged (param optional).

## Cross-Repo Side Effects
None.

## Verify
`cd webapp && bun test src/lib/voice/ && bunx tsc --noEmit` green.
