# Web push signals — close the doomscrolling gap
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01 (shared file src/web/index.html only — no logical dependency)
VERIFY_BLOCKER: `git log --oneline -1 -- src/web/index.html` shows concern 01 landed
TOUCHES: src/web/index.html
PLANE: OMPSQ-4 — https://app.plane.so/inkwell-finance/browse/OMPSQ-4/

## Goal
Turn agent state *transitions* into out-of-band pull signals so the operator can look away and be
summoned back: a browser desktop notification + a `document.title`/favicon badge (count waiting)
when an agent crosses into `input`/`error`, and a "done" notification when one returns to `idle`
after working. Today the dashboard is pure poll (BRIEF §B; confirmed no Notification/title/favicon
code exists).

## Approach
1. **Transition detection.** The only place statuses update is `handle()` on `agent`/`roster`
   events (`index.html:272-282`). Before overwriting `agents.set(...)`, read the prior status and
   compute `prev → next` per agent. Fire a signal on:
   - `* → input` ("⛔ <name> needs you: <request title>")
   - `* → error` ("⚠ <name> errored: <error>")
   - `working → idle` ("✓ <name> finished")
   Guard the very first `roster` snapshot (no priors) so a reconnect doesn't spam.
2. **Desktop notification (native, rung 3).** A `notify(title, body, tag)` helper using
   `Notification` API. Request permission lazily on first user gesture (e.g. the mute toggle or
   first Spawn), never on load. Use `tag` = agent id so repeated signals for one agent collapse.
   Clicking a notification focuses the tab and `openAgent(id)` (or opens the queue for `input`).
   No-op gracefully when permission denied / API absent.
3. **Title + favicon badge.** Maintain a derived "waiting" count (same fold as concern 01). When
   the tab is hidden (`document.hidden`) or N>0, set `document.title = "(N) omp-squad …"`; reset to
   the base title when N=0 and focused. Draw a small favicon badge via a canvas-generated data-URL
   `<link rel="icon">` (red dot with N), or fall back to the title prefix only. Reset on `focus`.
4. **Optional sound + mute.** A short WebAudio beep (oscillator, no asset file) on `→input`. A
   persisted mute toggle in the header (`localStorage` key `squad.mute`, default muted for sound,
   notifications on) — mirror the existing `navCollapsed`/`showChanges` localStorage pattern
   (`:194,995`). Honor mute for sound; notifications respect browser permission.
5. **Throttle.** Coalesce bursts (e.g. a `roster` replay) — at most one notification per agent per
   ~2s via a `Map<id, lastNotifyTs>`.

ponytail: Notification API, WebAudio, and canvas-favicon are all platform-native — no library.
Reuses the concern-01 waiting fold; don't duplicate it (extract a `waitingAgents()` helper).

## Cross-Repo Side Effects
None — client-only.

## Verify
- Spawn an agent with `--approval always-ask`; switch to another browser tab; trigger a tool
  approval → desktop notification fires, the tab title shows "(1) …", favicon shows a dot.
- Click the notification → tab focuses and lands on the queue/agent.
- Let an agent finish a turn → "finished" notification; kill one → "errored" notification.
- Toggle mute → no sound on next `→input`; notification still respects browser permission.
- Reconnect the WebSocket (restart daemon) → no notification storm from the replayed roster.
