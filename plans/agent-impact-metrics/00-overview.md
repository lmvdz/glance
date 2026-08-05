# Agent Realized-Impact Metrics

## Outcome
- Every landed unit gets an honest impact read: was its code referenced by later cross-feature work, did its lines survive (churn-adjusted, modifier-classified), what did it truly cost (feature-level), and how much of the unit the lane could even see. Rendered as vectors and declared gaps — never a composite score, never a verdict word.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 landed-units ledger](01-landed-units-ledger.md) | The commit→unit join doesn't exist durably; everything reads it | architectural | land.ts, land-pr.ts, squad-manager.ts, src/impact/ |
| [02 history backfill](02-history-backfill.md) | First cohorts shouldn't be empty; naive done-proof backfill is systematically wrong | mechanical | src/impact/, scripts/ |
| [03 survival engine](03-survival-engine.md) | blame --reverse survival with modifier classes; log -L measures the wrong lines | architectural | src/impact/ |
| [04 reference index seam](04-reference-index-seam.md) | codegraph edges behind per-file usability gates; confident zeros are the failure mode | architectural | src/impact/ |
| [05 snapshot loop + cost](05-snapshot-loop.md) | Fixed-offset measurement, land-identity keyed; featureId cost rollup | architectural | src/impact/, squad-manager.ts, types.ts |
| [06 deletion credit](06-deletion-credit.md) | The only vector where cleanup wins; counterweight to accretion gradient | mechanical | src/impact/ |
| [07 API + cohorts](07-api-and-cohorts.md) | (repo, week) rollups with measurability floors and gap fractions | mechanical | server.ts, src/impact/ |
| [08 ImpactSurface](08-impact-surface.md) | Operator read that can't be misread as execution/quality | architectural | webapp/ |
| [09 firewall + first cohort](09-firewall-and-first-cohort.md) | Gameable numbers must not reach agent feedback loops; lane proves itself on real data | mechanical | src/impact/, tests/ |
| [10 runtime sampler](10-runtime-sampler.md) | Deferred execution axis (realized-line rate) | research | TBD |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Spine; everything else joins through it |
| 2 | 03, 04, 02 | Independent consumers of the ledger; parallelizable (disjoint TOUCHES) |
| 3 | 05, 06 | Loop composes 03+04; deletion credit rides the same snapshot |
| 4 | 07, 09 | Read side + exposure guard, both on snapshots |
| 5 | 08 | UI last, after the first-cohort report validates the format |
| 6 | 10 | Research concern; after the static lane is proven |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 02 | 01 | `src/impact/ledger.ts` exports append/read and a ledger line exists in a scratch state dir |
| 03 | 01 | same |
| 04 | 01 | same |
| 05 | 01, 03, 04 | survival.ts and reference-index.ts export their gather functions |
| 06 | 01 | ledger entry carries first-parent diff stats |
| 07 | 05 | a snapshot JSON file exists under `<stateDir>/impact/` |
| 08 | 07 | `curl /api/metrics/impact` returns a decoded payload |
| 09 | 05 | snapshot files exist |
| 10 | 05, 07 | snapshot schema live; API serving |

## Not yet specified
- (none)

## Out of scope
- Whole-task cost benchmark lane + KNOWN-UNPROVEN.md ledger (Tura research concepts 1+4) — user chose to keep this plan impact-only; they remain in plans/research-tura/BRIEF.md for a later /plan.
- Trailer-based attribution — red team proved land-site commits are WIP-sweeps; ledger is self-sufficient.
- `^Revert`-based rejection detection — dead sensor in a fix-forward fleet; deleted-within-window replaces it.

## Decisions so far
- [DESIGN.md](DESIGN.md) — adversarial round complete 2026-07-28; 8 critical red-team findings resolved (see Red Team Concerns Addressed)

## Notes
- Phase 0 WIP gate: user chose "proceed" over resuming meta-autonomous-fleet (37 open) / the-room (18) / land-assessment (11, 1 hitl).
- Scope gates: sampler = final concern, not this execution wave; impact lane only (no Tura fold-in).
- Flag: `OMP_SQUAD_IMPACT_METRICS=1`, off by default. Ledger writes must never fail a land.
- DECOMPOSE complete; execution not started — say "execute" to run batches (Workflow-orchestrated, worktree-isolated), or file to Plane via /plan-to-plane.
