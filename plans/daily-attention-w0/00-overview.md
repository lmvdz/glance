# Attention wave-0 (Epic C)

Parent: plans/daily-driver/00-meta.md · Design: plans/daily-driver/DESIGN.md · Evidence: plans/research-t3code/BRIEF.md

## Outcome

A casual session (console chat today — `POST /api/console`, src/server.ts:2375 — the same channel Epic A's `glance here` on-ramp extends) pages the operator's phone when a long turn finishes, not just when it needs input or errors (escalationPayload already covers those, unchanged). Fleet units stay quiet on completion by default — a dispatched unit finishing is not the away-from-keyboard signal a casual chat's idle transition is. This is the wave-0 "reason to switch" named in 00-meta.md's north star, delivered by widening the already-shipped voice-done push latch rather than building the full needs-you ladder (charter, 00-meta.md Epic H) three epics early.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 casual-completion-push | generalizes the voice-only completion latch (arm-on-prompt, fire-on-idle) into a per-session-category push — casual ON, fleet OFF by default, approval/input unchanged — using the existing global settings mechanism, not a new per-viewer store | architectural | src/types.ts, src/squad-manager.ts, src/push.ts, src/server.ts, src/runtime-settings.ts |
| 02 transition-subscription | retires maybePushAlert's/maybePushAlertOrg's private `lastStatus` diff map in favor of reading `from`/`to` straight off the canonical `{type:"transition"}` SquadEvent (transitions.jsonl's own guarded write path) — the lifecycle-truth follow-up named in the landscape doc | mechanical | src/server.ts, src/types.ts (read-only reference) |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | ships first — casual/fleet push categories land on today's `agent`-diff plumbing, unchanged by 02 |
| 2 | 02 | same-file sequential with 01 (both rewrite `maybePushAlert`/`maybePushAlertOrg` in src/server.ts) — run after 01 lands so 02 refactors the post-rename (`completionPushArmed`/`completionPayload`) function body, not the pre-rename one. Not a real dependency (01's category logic and 02's event-source swap are logically independent), just a same-lines merge-conflict avoidance — hence BLOCKED_BY: none on 02's own frontmatter, sequencing recorded here instead.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 casual-completion-push | none | — |
| 02 transition-subscription | none (sequenced after 01, not blocked by it) | `grep -n "completionPushArmed\|sessionCategory" src/squad-manager.ts src/push.ts` returns matches — 01's rename/category-arm landed, so 02 edits `maybePushAlert`/`maybePushAlertOrg` post-rename instead of racing 01's own edit of the same lines |

## Not yet specified

(none)

## Notes

- Per-category defaults (00-meta.md / DESIGN.md "Push spam under fleet load" risk): casual sessions completion ON, fleet units completion OFF, approval/input ON everywhere — no exceptions, no ladder dependency.
- The needs-you attention ladder (00-meta.md Epic H, charter) is explicitly NOT built here — wave-0 push is the whole of Epic C's adoption-path scope. Ladder expansion trigger (friction-ledger evidence or a committed cockpit consumer) is unaffected by anything in this sub-plan.
- Neither concern touches glance-desktop (cockpit). The cockpit's terminal-native attention lane (src/osc-notify.ts, fleet-ide-bridge PR #177) rides `escalationPayload` only, which this epic does not modify — no cross-repo coordination needed.
