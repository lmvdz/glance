# Voice delivery of the weekly episode + debrief-heard emission
STATUS: open
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
