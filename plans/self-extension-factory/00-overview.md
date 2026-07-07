# Self-Extension Factory (v1: Demand → Proposal)

## Outcome
glance observes capability-shaped demand from its own fleet activity (repeated manual work, churn hotspots, flapping agents), drafts a candidate capability manifest with evidence provenance, and surfaces it as a proposal a human can author and enable through the existing admin flow. Ships the observed-demand → capability value without the autonomous behavioral gate that two red-team passes proved non-viable today. Also lands the provenance schema and daemon-side demand source that a v2 autonomous gate would require.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 Daemon-side demand source | Signals live in a React-coupled webapp module the daemon can't import | architectural | `webapp/src/lib/insights.ts`, new `src/demand-signals.ts`, webapp re-import sites |
| 02 DemandSignal model + durable queue | Typed demands, deduped, persisted across restart with no net-new store | architectural | new `src/factory/queue.ts`, `src/capabilities/index.ts`, `src/dal/store.ts`, `src/automation-log.ts` |
| 03 `factory` automation loop (default OFF) | The tick that detects demand and emits signals, flag-gated | architectural | `src/types.ts`, new `src/factory.ts`, `src/scheduler.ts`, `src/factory-status.ts` |
| 04 Candidate drafting (throttled) | Draft a manifest + acceptance assertion; dispatch-capped, budgeted, wall-clock-killed | architectural | new `src/factory-author.ts`, `src/dispatch.ts`, `src/architect.ts`/`src/smart-spawn.ts` (reuse), `src/capabilities/index.ts` (static verify) |
| 05 Provenance schema + proposal UI | `CapabilityInstall` can't store origin/demand today; audit is too thin | architectural | `src/capabilities/index.ts`, `src/dal/store.ts`, `src/server.ts` (audit), new webapp proposal card |
| 06 Evidence-only guardrail | Enforce provenance for factory-origin installs at the single chokepoint | mechanical | `src/capabilities/index.ts` (`installCapability`/`updateCapabilityInstall`) + tests |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Foundation — every other concern needs a daemon-readable demand source |
| 2 | 02 → 05 | Both are capability data-model work on the SAME files (`capabilities/index.ts`, `dal/store.ts`); run sequentially on one agent to avoid clobber |
| 3 | 03 | Loop wiring; needs 01 (source) + 02 (queue) |
| 4 | 04 → 06 | Both touch `capabilities/index.ts`; 04 needs 03, 06 needs 05; sequential on one agent |

Four batches. Concerns 02/05 and 04/06 are same-file pairs — deliberately not parallelized.

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | `grep -n "import.*react" webapp/src/lib/insights.ts` confirms React coupling to extract away |
| 02 | 01 | `src/demand-signals.ts` exports the signal types 02 stores |
| 03 | 01, 02 | `DemandSignal` type + `src/factory/queue.ts` exist |
| 04 | 03 | `src/factory.ts` emits signals for the author to consume |
| 05 | 02 | queue provides `demandId` that provenance references |
| 06 | 05 | `CapabilityInstall.provenance` field exists to enforce |

## Notes
- **WIP snapshot (headless proceed):** started over 107 plans with open concerns (mostly `:console-agent-tooling` STATUS-drift stubs, 6 open/0 closed each; oldest real: `meta-plan-autonomous-fleet` 2026-07-05, recorded shipped in memory but STATUS never closed). The debt is logged; forcing function fires at next interactive `/plan` or `/wip`.
- **Scope was cut by adversarial design.** The autonomous author→execute-to-prove→frontier→admit loop is deferred to v2 behind five named prerequisites (see `DESIGN.md` §v2) — chiefly a disabled-install eval-run path and a demand-specific acceptance score. The GEPA frontier (research borrow #2) is degenerate without them.
- **This plan shares branch `worktree-research-goop`** with the research brief (draft PR #95) — research + plan land together.
