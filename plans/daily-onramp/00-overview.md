# On-ramp (Epic A)

Parent: plans/daily-driver/00-meta.md · Design: plans/daily-driver/DESIGN.md · Evidence: plans/research-t3code/BRIEF.md

## Outcome

`glance here` in any terminal beats typing `claude` at turn one: same brain (claude harness, operator's own login/config), edits that show up in the real checkout without racing the operator, a phone buzz when a long turn finishes or blocks, and a survivable session across daemon restarts. This is the only epic on the adoption path that touches the entry surface itself; B/C/D ride alongside it, E/F/G/H/I do not execute until the adoption gate (00-meta.md) says the on-ramp is being used.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 console-lane-stopwatch | throwaway measurement of the EXISTING console lane's dispatch→first-token cost, cold and warm, to inform 02's prewarm decision before it's built | research | scripts/ (new, throwaway), src/console-prompt.ts, src/server.ts (read-only instrumentation) |
| 02 glance-here-terminal | the on-ramp itself: `glance here` CLI verb, client-mode terminal REPL, claude-harness parity, ephemeral project registration | architectural | src/index.ts, src/tui.ts, src/project-registry.ts, src/harness-registry.ts, src/server.ts |
| 03 boundary-sync | one-directional per-turn patch-apply into the operator's real checkout, precondition-gated, fail-closed on divergence | architectural | src/squad-manager.ts, src/server.ts, webapp/src/components/ (attention affordance), tests/ (new) |
| 04 restart-reattach | casual sessions must survive the daemon restarts Lars does hourly, or the dogfood loop dies before it starts | mechanical | src/squad-manager.ts, src/index.ts (client REPL reconnect) |
| 05 web-flow | `glance here --web` opens the webapp deep-link on the existing token mechanism; records deferred one-time-token hardening findings for later | mechanical | src/index.ts, webapp/src/lib/api.ts (read-only reference) |
| 06 promote-adopt-ui | webapp affordances for the already-shipped server-side promote/adopt (zero callers today) | mechanical | webapp/src/components/chat/, webapp/src/components/AssistantChat.tsx, webapp/src/lib/ (new client calls) |

## Order / batches

| Batch | Concerns | Why together |
|---|---|---|
| 0 | 01 | standalone wave-0 measurement; informs 02 but does not block it (soft dependency only, per arbitration §11/§epic map) |
| 1 | 02 | foundation — every other concern in this epic rides the terminal-attach session and the ephemeral-project registration it creates |
| 2 | 03, 04, 05, 06 | all depend only on 02, disjoint files (git-write path / reconnect logic / URL flag / webapp components) — parallelizable |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 console-lane-stopwatch | none | — |
| 02 glance-here-terminal | none (01 informs, does not block) | — |
| 03 boundary-sync | 02 | `grep -n "cmdHere\|case \"here\"" src/index.ts` returns a match — the terminal-attach verb exists for boundary-sync to hook into at turn end |
| 04 restart-reattach | 02 | same check as above — a `here` session must exist before its restart survival can be built |
| 05 web-flow | 02 | same check as above — the printed-URL flow extends the `here` verb's output |
| 06 promote-adopt-ui | 02 | same check as above — the promote/adopt affordance targets the console/casual session `here` creates |

## Not yet specified

(none)

## Notes

- OMPSQ-40 (squad-manager.ts:4656) stays law for this epic: casual sessions run in standard worktrees. True in-place is the charter at plans/daily-driver/02-charter-true-in-place.md, not built here.
- 03 is a git-write path: cross-lineage review (codex + grok) is mandatory per DESIGN.md and 00-meta.md's model-routing decision.
- The one-time-token hardening surface named in 05 is deliberately deferred (arbitration §2) — recorded as notes in that concern for whoever picks it up next, not built in wave 1.
- Adoption gate lives in plans/daily-driver/00-meta.md, not here: two weeks of real use judged by plans/daily-dogfood-engine counters, sign-off MODE: hitl.
