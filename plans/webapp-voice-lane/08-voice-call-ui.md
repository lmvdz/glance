# Voice call UI (affordance, floating pill, pinned-binding banner)
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/chat/VoiceCallButton.tsx, webapp/src/components/chat/Composer.tsx, webapp/src/App.tsx, webapp/src/context/TaskContext.tsx
BLOCKED_BY: 06, 07

## Goal
The user-facing surface of the voice lane: start/end call, push-to-talk, live state, and a call that survives UI navigation instead of dying by unmount semantics.

## Approach
- **Ownership above the chat panel**: the live voice session + dispatcher are held at provider level (in or beside TaskContext), NOT inside AssistantChat — AssistantChat unmounts on Back/close/session-delete (App.tsx:157-158; AssistantChat.tsx:861-949) and must not take the call with it.
- `VoiceCallButton.tsx` in Composer's icon row — visually distinct from 01's plain STT mic (two different capabilities: free transcription vs metered S2S call). Hidden entirely unless `GET /api/voice/config` says enabled (no button that 501s — the old mic scar).
- **In-call floating pill** (rendered from the provider level, survives panel close — same pattern as the existing Agent FAB): PTT button (press-hold / tap-toggle), state indicator (recording/thinking/speaking), live caption line, elapsed time + a running cost estimate (minutes × rate — the operator should see the meter), end-call. Reconnect notice on 06's `reconnected` event ("reconnected — recapping context").
- **Pinned-binding banner**: the pill shows "voice → <session title>"; on session/project switch mid-call the pill banners the pin (voice keeps driving the pinned thread — you can't see which thread you're speaking into the way you can see where you're typing, so the UI must say it); session delete ends the call with a toast.
- Mic-denied / mint-failure / provider-down states per 06's error events: distinct toasts, fall back to the always-present text composer, no retry loops.
- Follow frontend-design-guidelines + brand.md (ember accent); this is a user-facing surface — taste bar applies.

## Cross-Repo Side Effects
None.

## Verify
- `bun test` green (static-markup assertions: button hidden when config disabled, pill renders per state).
- Live end-to-end (scratch daemon, real key): start call from composer → speak → fleet dispatch → close the chat panel mid-call → pill persists, call continues → completion narrated → end call from pill. Switch sessions mid-call → banner shows the pin. Delete the pinned session → call ends with toast.

## Resolution
Shipped (commit 5d6e60a; audit hardening 593bc16). Provider-owned session above the chat panel (survives close/delete), config-gated call button, floating pill (state/caption/elapsed+cost/PTT) clearing the FAB and above a maximized panel, pinned-binding banner, spoken-summary persistence, honor `fallbackToText`, max-duration + idle caps. Pure HUD/store logic tested.
**Live-verification OWED**: real end-to-end (mic + WebRTC + audio) not run (no key).
