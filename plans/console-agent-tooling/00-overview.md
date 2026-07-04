# Console-agent investigation tools

## Outcome
- Asking the webapp chat "what's happening / what needs me?" gets an *investigated* answer: the console agent can read the roster, inspect any unit's worktree diff, look up Plane tickets, and summarize what needs the operator — instead of reformatting the injected snapshot.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 tool-registry-and-console-flag | No read-only classification, no console discriminator, dispatcher is inline branches | architectural | src/console-tools.ts (new), src/agent-driver.ts, src/squad-manager.ts, src/types.ts, src/server.ts, tests |
| 02 fleet-status-tool | Chat can't see the roster/factory/automation state | mechanical | src/console-tools/fleet-status.ts (new), registry, tests |
| 03 worktree-inspect-tool | Chat can't see what a unit actually changed (the ompsq-420 question) | mechanical | src/console-tools/worktree-inspect.ts (new), registry, tests |
| 04 ticket-lookup-tool | Chat can't resolve OMPSQ-N to state/description/duplicates | mechanical | src/console-tools/ticket-lookup.ts (new), registry, tests |
| 05 needs-attention-tool | "What needs me" requires assembly (pending gates, dirty worktrees, idle units, factory) | architectural | src/console-tools/needs-attention.ts (new), registry, tests |
| 06 console-prompt-update | Tools exist but the agent must be taught to investigate before answering | mechanical | src/server.ts (CONSOLE_SYSTEM_PROMPT), tests |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Infrastructure everything else plugs into |
| 2 | 02, 03, 04, 05 | Each is a self-contained registry entry (new file + one registry line + tests); one implementer or sequential — the registry index line is a shared touch |
| 3 | 06 | Prompt written against the tools that now exist |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02-05 | 01 | `ls src/console-tools.ts` exists; registry test green |
| 06 | 02-05 | tool names final (prompt references them) |

## Notes
- WIP snapshot at plan time: 3 plans with 10 open concerns (agentic-learning-loop 5, factory-control-plane 3, change-driven-loops 2) — proceeded, user-directed follow-on from the 2026-07-04 chat dogfood.
- Origin evidence + integration map: DESIGN.md header; explore pass verified every file:line (host-tool pattern, plane.ts helpers, explore.ts, automation log, gate economics).
- Overlaps OMPSQ-422 (observer hygiene) on stranded-work surfacing: concern 05 is the read side; 422's attention-item is the push side. Coordinate, don't duplicate.
- Deploy note: daemon restart required to pick tools up (global install).
