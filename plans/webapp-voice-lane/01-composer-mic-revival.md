# Composer mic revival (chained STT input)
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/voice/speech.ts, webapp/src/components/chat/Composer.tsx, webapp/src/components/AssistantChat.test.tsx, webapp/src/components/WorkbenchPane.tsx

## Goal
A working mic button on the chat composer: browser Web Speech API transcribes speech into the composer's input state (not auto-send). Default-ON — it restores an input modality, grants no new capability. This is the feature whose stub predecessor was deliberately removed as a "misleading no-op"; the difference this time is real error handling.

## Approach
- New `webapp/src/lib/voice/speech.ts`: a small wrapper over `window.SpeechRecognition || window.webkitSpeechRecognition` (feature-detect like WorkbenchPane.tsx:356). Must wire `onerror` and map `no-speech`, `not-allowed`, `network`, `aborted` to distinct user-facing messages — the predecessor's silent failures are exactly what got the old mic removed. `recognition.abort()` on unmount/cleanup. Handle multi-segment results, not just `event.results[0][0]`.
- Mic button in `Composer.tsx`'s icon row (~659-692, next to Attach/Capture), `aria-label="Voice input"`, listening state styling per WorkbenchPane's button (line 768). Transcript appends to the composer `input` state; user reviews then sends.
- Absent API → disabled button + tooltip (Chrome/Safari only; Firefox flag-disabled as of 2026-07).
- Fix `WorkbenchPane.tsx:355-371` in the same pass: same wrapper, same onerror map (it currently has none).
- Flip `AssistantChat.test.tsx:528-534` from asserting `aria-label="Voice input"` absent to asserting present-and-enabled on Composer's rendered markup. Be honest in the test name: static markup can't assert handlers; behavior is covered by unit tests on the speech.ts wrapper.
- Privacy callout: Chrome's implementation sends audio to Google's servers (this is cloud STT, not on-device). One sentence in the tooltip/help and wherever data handling is documented.

## Cross-Repo Side Effects
None.

## Verify
- `bun test` (webapp) green including the flipped assertion and new speech.ts unit tests.
- Live: `bun run dev`, Chrome — speak into the composer mic, transcript lands in input; deny mic permission → distinct toast, button disabled for session; Firefox → disabled with tooltip.

## Resolution
Shipped (commit 5c8fc5f; review fixes a16b1b2). `webapp/src/lib/voice/speech.ts` wrapper with the full `onerror` map + multi-segment assembly + unmount abort; mic button on Composer; WorkbenchPane refactored onto the same wrapper (it had none); absence assertion flipped to two presence tests. Fully unit-verified (no live key needed).
