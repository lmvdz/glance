# Continuous in-session context durability (Mastra OM, reframed)

## Outcome
- A cold-adopted plain unit comes back with its **prior-session digest** surfaced (fenced
  system entry) instead of amnesia — closing the daemon-fragility / stranded-context hole.
- Its original **system prompt** (tool grants, profile memory, fabric primer) is restored on
  the spawned child instead of being silently dropped.
- Optionally (opt-in, measured): a validator **veto reason is fed back** into the unit's next
  turn so it iterates instead of blind-retrying against an unchanged diff, then parking.

## Work
| Concern | Why it exists | Complexity | Touches |
| 01 cold-adopt digest surfacing + system-prompt restore | Cold-adopted plain units get no task, no system prompt, no digest today — they resume with amnesia | mechanical | `src/squad-manager.ts` (`adoptOrphanedAgents`) |
| 02 validator veto → next-turn reprompt (flagged off, measured) | Vetoed units blind-retry then hold; feeding back the reason lets them iterate — but recovery value is unproven, so opt-in + metered | architectural | `src/orchestrator.ts`, `src/squad-manager.ts` |
| 03 observer-log DROP (documentation only) | Record why the Mastra observation log was NOT built (duplicates digest/reflection/fabric) so it isn't re-proposed | mechanical | `plans/research-mastra-code/` (doc) |

## Status
**2/2 code concerns closed** (01, 02); 03 is a deliberate drop (cancelled). Shipped on branch
`worktree-research-mastra-code` (PR #69). Typecheck clean; full suite **1545 pass / 0 fail**; 6 new
tests added (`tests/resume-digest-surface.test.ts` ×3, `tests/veto-reprompt.test.ts` ×3).

## Order
| Batch | Concerns | Why together |
| 1 | 01 | Standalone, highest value, lowest risk — ship first |
| 2 | 02 | Independent of 01; opt-in feature, larger surface |
| — | 03 | Documentation; no code |

## Dependency graph
| Concern | Blocked by | 30s check |
| 01 | — | `grep -n "adopted: p.kind" src/squad-manager.ts` returns the adopt create() call |
| 02 | — | `grep -n "continueAgent\|OrchestratorDeps" src/orchestrator.ts` (new dep to add) |
| 03 | — | n/a (doc) |

## Notes
- Proceeded over **20 plans with open concerns** (WIP scan 2026-07-06; oldest
  `meta-plan-autonomous-fleet` 2026-07-05) — this is a research→plan pipeline continuation, so
  the Phase-0 forcing question was recorded rather than blocked. Much of that count is worktree
  duplication of the same plans.
- Design collapsed from a 3-pattern / 2-new-store proposal to this 2-concern cut by an
  adversarial pass (designer → 2 red teams → arbiter). See `DESIGN.md` for the full rationale
  and every red-team concern's resolution. Research provenance: `BRIEF.md` (PR #69).
- Hard constraint driving the whole shape: the daemon cannot touch a child `omp` process's
  live context window — this is a turn-boundary / cross-process durability layer, not in-window
  compaction.
