# Noisegate-borrow: signal-preserving output compaction

## Outcome
- Verify-loop steer messages, checkpoint records, and land detail strings keep failure lines, tracebacks, and summaries under the same budgets that today blindly head-truncate them away.
- Raw gate output is redacted before it is persisted; every compaction decision is auditable in `compaction.jsonl`.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 reducer module](01-reducer-module.md) | The shared signal-ranked reducer everything else consumes | architectural | output-reduce.ts, text-util.ts, gate-logs.ts, gate-runner.ts, observer.ts, tests |
| [02 redact hardening + persistence](02-redact-hardening.md) | Fix measured false positives + O(n²) before wiring redact anywhere new | mechanical | redact.ts, gate-logs.ts, tests |
| [03 executor steer path](03-executor-steer.md) | The headline fix: steer messages lose failure tails today | architectural | workflow/executor.ts, workflow/engine.ts, tests |
| [04 checkpoint persistence](04-checkpoint-log.md) | Same head-cut at the resume/fork record | mechanical | workflow/checkpoint-log.ts, tests |
| [05 land call sites + consolidation](05-land-and-consolidation.md) | Five gate-output head-cuts in land.ts + four duplicated truncate helpers | mechanical | land.ts, validator.ts, squad-manager.ts, flue-service-driver.ts, tests |
| [06 product contract doc](06-contract-doc.md) | The boundary that keeps the class list at four and surfaces protected | mechanical | docs/output-compaction-contract.md |
| [07 transcript tool-result offload (deferred)](07-transcript-offload-deferred.md) | BRIEF concept 3 — belongs with cockpit recovery UX | architectural | (deferred to plans/fleet-ide-cockpit) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Everything depends on the module API |
| 2 | 02 | Shares gate-logs.ts with 01; redact must be hardened before 04 wires it |
| 3 | 03, then 04, then 05 | Sequential — single worktree, disjoint files but no parallel isolation needed at this size |
| 4 | 06 | Documents the final shipped API |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 02 | 01 | `git log --oneline -1 -- src/output-reduce.ts` shows the module landed (shared gate-logs.ts edit ordering) |
| 03 | 01 | `grep -q reduceOutput src/output-reduce.ts` |
| 04 | 01, 02 | reduceOutput exists AND `grep -q 'BOUNDED\|{0,20000}' src/redact.ts` (hardened pattern present) |
| 05 | 01 | same as 03 |
| 06 | 01–05 | prior concerns' STATUS done |

## Not yet specified
- (none)

## Out of scope
- Signal-ranking inside `budgetedExcerpt`'s six judge-prompt call sites — judge-evidence drift needs its own reviewed pass ([contract doc](06-contract-doc.md) freezes this boundary).
- Excerpt-side redaction (prompts) — deferred until redact patterns prove clean on the corpus test; persistence-side only for now.
- Transcript tool-result offload — deferred to plans/fleet-ide-cockpit ([07](07-transcript-offload-deferred.md)).

## Decisions so far
- (populated at close)

## Notes
- Proceeded over 13 plans with open work (41 open concerns; scanner run 2026-07-15) — user explicitly commissioned this plan ("lets do it plan and execute").
- Auto-approved checkpoints: headless background session; EXPLORE landscape validated against live source, DESIGN arbitrated from two red-team passes (see DESIGN.md), EXECUTE explicitly authorized by the user in-conversation.
- Trust-critical: concerns 03/05 change what fixup agents and land details contain — blind-review gate required before PR (user-mandated).
