# Service-worker visibility gate: no buzz while the operator is looking
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/web/sw.js

## Goal
A push arriving while a glance window is visible on this device shows no OS notification — the
operator is already watching the screen the push points at. Applies to ALL push categories
(fixes the existing buzz-while-watching for input/error escalations too) and is the designed
replacement for the cut live-call beacon: during a call, the glance tab is normally visible, so
completion pushes stay silent on that device and still fire on pocket devices.

## Approach
In sw.js's `push` handler (line ~39), before `showNotification`: `await self.clients.matchAll({
type: 'window', includeUncontrolled: true })` and skip the notification when any client has
`visibilityState === 'visible'`. Keep everything inside the existing `event.waitUntil` chain.
Guard defensively (matchAll rejects → show the notification; fail toward notifying, never toward
silence). Keep the file dependency-free plain JS matching its current style. Note: iOS/Safari
must still show *something* in some UA policies when a push arrives — if `showNotification` is
skipped, do nothing else; Chrome tolerates this and the subscription is unaffected.

## Cross-Repo Side Effects
None.

## Verify
Manual (sw.js has no test harness): with the daemon running and push subscribed, trigger a push
(e.g. drive an agent to `input`) with the glance tab focused → no OS notification; minimize the
window / switch apps and trigger again → notification appears. Confirm notificationclick focusing
still works.

## Resolution
Shipped on branch voice-loop, commit 19f0f0e. sw.js push handler skips showNotification when any window client is visible; fail-toward-notifying on matchAll failure; node --check clean.
