# Voice delivery of the weekly episode + debrief-heard emission
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 09
MODE: afk
TOUCHES: webapp/src/lib/voice/tools.ts, webapp/src/hooks or context per post-#186 layout, webapp/src/lib/chat/sessionStore.ts, webapp/src/lib/attention.ts

## Goal
Calling in after a week away opens with the spoken state-of-the-codebase brief, and "heard" is recorded honestly — only after narration actually completed uncancelled.

## Approach
PR #186 (voice-loop) merged to main 2026-07-15 — unblocked. Nothing in concerns 01–10 may import `webapp/src/lib/voice/*` or sessionStore debrief code; this concern is the only voice-touching one.
1. Extend the connect-time debrief flow: when a new episode exists that the session's voice cursor predates, prepend a spoken episode summary (≤4 sentences: top deltas + top debt files + symptom count) to the `buildVoiceDebrief` injection, following its fencing/no-tools/truncation-honesty conventions exactly (strip `[\r\n\t]`, 400-char truncation, explained-truncation prefix).
2. **debrief-heard**: in the existing two-phase `queueInjection` completion callback (`{cancelled:false}` — the same place the ts-cursor advances), emit `reportAttention({kind:'debrief-heard', repo, ...})`. Served ≠ heard; only the uncancelled completion counts.
3. Follow the episode with the standing "what do you want to do next" prompt; barge-in repeats next call (cursor discipline already handles this).

## Cross-Repo Side Effects
None.

## Verify
`cd webapp && bun test && bunx tsc --noEmit` green. Manual voice loop: generate an episode, call in → spoken brief; barge in mid-episode, call again → repeats; let it finish → debrief-heard event exists and next call is silent about it.

## Resolution
Shipped in the `comprehension` worktree (branch continuing `worktree-agent-a3c35c5e2a8c60de8`).
`webapp/src/lib/voice/tools.ts` gained `buildVoiceEpisodeBrief`/`buildEpisodeSummaryText`/
`countEpisodeSymptoms` — pure, tested, following `buildVoiceDebrief`'s exact fencing/no-tools/
truncation conventions. `webapp/src/lib/api.ts` gained `fetchEpisodes`/`fetchEpisode` (GET
`/api/episodes[?repo=]` and `/api/episodes/:id?repo=`). `VoiceCallContext.tsx`'s `runDebrief` now
fetches the latest episode meta for the active project's repo, fetches the full episode only when
its `generatedAt` postdates the session's existing `voiceDebrief.cursorTs` (defaulting an absent
cursor to 0 — deliberately NOT gated on the transcript debrief's stricter "cursor must already
exist" rule, since the episode is a standalone artifact, never typed work the operator was live
for), and prepends its DATA-fenced summary to the transcript debrief's items in one combined
`queueInjection` call. `debrief-heard` fires from that same `{cancelled:false}` branch via
`reportAttention` — served ≠ heard, a barge-in never emits.

Design decision beyond the concern's literal text: the two-phase commit's cursor value is NOT the
episode's own `generatedAt` (a real but stale past timestamp) — committing it verbatim would leave
the shared cursor stuck in the past and let the NEXT call's transcript debrief over-report typed
work done during THIS call as "while you were away". The commit instead folds in wall-clock `now`
whenever an episode was included (`Math.max(debrief?.maxCompletionTs ?? -Infinity, episodeResult ?
Date.now() : -Infinity)`), which both retires the episode correctly and seeds the transcript
debrief's baseline exactly like `stampVoiceCallEnded`'s existing "collapse to now" idiom already
does for a session's very first call. No second cursor field was added — `sessionStore.ts`'s
existing `voiceDebrief.cursorTs` covers both artifacts, per the concern's own instruction.

`cd webapp && bun test` (1358 pass / 0 fail) and `bunx tsc --noEmit` (clean) both green.
