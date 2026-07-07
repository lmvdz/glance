# Design: Self-Extension Factory (glance)

## Origin
Handoff from `/research` on the GOOP paper (`plans/research-goop/BRIEF.md`). The research isolated one rung glance hasn't climbed: authoring new capabilities from observed demand, gated by execution (Voyager's critic-gate) and selected by a GEPA frontier. Two adversarial red-team passes then attacked the draft against real code and forced a scope collapse — recorded below.

## What changed after red team
The draft was an **autonomous author → execute-to-prove → frontier-select → admit** loop. Three findings, each verified against a specific line, made that non-viable as a first ship:

- **Prove-before-enable is impossible through the reuse seam.** `runCapability` (`src/squad-manager.ts:1647`) throws unless the install is already `enabled`. To execute a candidate you must enable it — the exact human-authority transition the gate exists to protect.
- **The proof measures the wrong thing.** `runProof.ok` (`src/proof.ts:259`) = repo verify command exits 0 AND worktree clean. It has no knowledge of what the candidate was meant to do; no-op and plausible-but-wrong-yet-tests-pass candidates both score green. Systematic confident no-ops.
- **The demand source is on the wrong side of the wire.** The signals (`churnHotspots`, `flappingAgents`, `detectCollisions`) live only in `webapp/src/lib/insights.ts`, which imports React at module top; the daemon can't read them.

Plus: `create()` bypasses the dispatch WIP cap (runaway spend); the frontier is degenerate on a single binary eval instance; `CapabilityInstall` has no field to store provenance and the enable transition re-runs only *static* `verifyCapabilityPack`, never a proof.

**Conclusion:** the value lives in *detect + draft + propose*. The autonomous gate and the frontier depend on prerequisites that don't exist. Building them now ships a factory whose dominant output is confidently-admitted no-ops.

## Approach — v1: Demand → Proposal
The factory **observes** capability-shaped demand from the daemon's own primitives, **drafts** a candidate capability manifest plus a demand-specific acceptance assertion, **statically verifies** it (`verifyCapabilityPack` — real, safe, already exists), and **surfaces** it as a proposal carrying evidence provenance. A human authors/enables it through the existing admin capability flow. No autonomous `runCapability`, no enable-then-prove contradiction, no frontier, no unbounded spend.

What is genuinely new (not already covered by `squad_report`/`opportunity`/`attentionItems`):
- Demand detection specifically for **capability gaps** ("the fleet keeps doing X by hand — here is a drafted capability to proceduralize it"), not work items.
- A **drafted candidate manifest + acceptance assertion**, pre-filled into the capability-install flow — not a to-do.
- **Provenance wired onto `CapabilityInstall`** (origin, demand, evidence) — a real schema improvement needed regardless, and the groundwork v2's gate requires.
- A **daemon-side demand source** extracted from the React-coupled insights module — independently useful (the webapp re-imports the pure module).

## System boundary
| In v1 | Out (v2, documented below) |
|---|---|
| Demand detection (daemon-side) | Autonomous execute-to-prove gate |
| Candidate manifest drafting (dispatch-throttled, budgeted) | GEPA Pareto-frontier candidate selection |
| Static `verifyCapabilityPack` | Multi-instance / continuous acceptance scoring |
| Provenance schema + proposal UI + evidence-only guard | Enable-time proof re-assertion + canary quarantine |
| Human authors + enables | |

## Key Decisions
| Decision | Choice | Rationale |
|---|---|---|
| v1 scope | Detect + draft + propose; human authors/enables | Both red teams: the three criticals all live in the autonomous gate; the value doesn't |
| Artifact type | Not restricted to workflows | Churn/flapping demand implies **skills/docs and profile tunes**, which workflow-only v1 can't serve (red team A-Q3). Human-authored v1 sidesteps the "skills aren't behaviorally gateable" block |
| Demand source | Extract pure ranking fns from `insights.ts` into a React-free `src/` module | Daemon can't import React (red team A#3); webapp re-imports the extraction |
| Queue storage | Records inside the existing capability snapshot; transitions → `automation.jsonl` | Survives restart for free; no net-new store; the durable event journal is unbuilt (`plans/factory-control-plane/05`) |
| Dedup | `dedupKey = hash(kind + targetArea)` | Stop the loop re-emitting the same demand every tick (red team B) |
| Provenance | Add `origin` + `provenance` to `CapabilityInstall`; enforce at the `updateCapabilityInstall` chokepoint | The generic admin PATCH route is factory-unaware; guard at the single choke both CLI+HTTP funnel through (red team B#1/#2) |
| Spawn path | Candidate-drafting agent goes through `dispatch` (WIP cap) + hard per-tick budget + wall-clock kill | `create()` bypasses the cap (red team A-Q1) |
| Frontier engine | **Deferred to v2** | Degenerate on one binary eval instance; earns its keep only with continuous acceptance scores × ≥3 eval instances (red team A-Q4) |
| Default | OFF, flag `OMP_SQUAD_FACTORY=1`; DB-mode = root-manager-only | Matches `resident-planner` precedent + the tenancy-vs-factory constraint |

## v2 — autonomous behavioral gate (documented, NOT built here)
Named prerequisites, each a real gap the red teams surfaced:
- **P1 — disabled-eval run path**: execute an authored workflow file directly via the WorkflowDriver in a throwaway worktree without touching `capabilityStore` state (fixes the `runCapability`-requires-enabled contradiction).
- **P2 — demand-specific acceptance scoring**: continuous 0–1, authored alongside the candidate; `runProof.ok` is a necessary floor, the acceptance assertion is the score. This is the mechanism `src/workflow/commission-executor.ts`'s `GateReport` acceptance step already implements — reuse it, don't reinvent `runProof` as a fitness function.
- **P3 — ≥3 eval instances per demand** (run each candidate against several historical tasks in the hotspot) so a Pareto frontier is non-degenerate; only then write `src/optimize/frontier.ts`.
- **P4 — factory sub-cap** inside `OMP_SQUAD_MAX_WIP` (yield-first); fold candidate id into the `runProof` cache key (avoid cache collision across candidates at the same HEAD); startup reaper for orphan factory worktrees.
- **P5 — enable-time proof re-assertion** for `origin:"factory"` installs + canary-repo quarantine before fleet-wide enable; enable-review UI shows the produced diff + acceptance result, never a bare green check.

## Risks
- **v1 overlaps existing proposal surfaces.** Mitigation: v1's distinct value is the *drafted manifest + provenance schema + daemon demand source*, not "another suggestion." If that distinctness proves thin in practice, v1 collapses further to just the provenance schema + demand extraction as v2 groundwork — an acceptable floor.
- **Circularity** (factory output becomes next round's demand). Bounded in v1 because a human authors/enables every capability; becomes load-bearing only at v2 (P5 canary).

## Red Team Concerns Addressed
| Concern | Severity | Resolution |
|---|---|---|
| `runCapability` throws unless enabled → can't prove-before-enable | critical | Autonomous gate cut from v1; v2-P1 defines the direct-WorkflowDriver run path |
| `runProof.ok` proves "repo builds", not demand-fit → green no-ops | critical | Gate cut from v1; v2-P2 requires a demand-specific acceptance score (commission's GateReport pattern) |
| `insights.ts` React-coupled → daemon can't read demand | critical | Concern 01: extract pure ranking fns into a `src/` module |
| `CapabilityInstall` has no provenance field; enable re-checks only static verify | critical | Concern 05: provenance schema; Concern 06: enforce/re-check at `updateCapabilityInstall` |
| Generic admin PATCH flips factory installs with no proof re-check | high | Concern 06: guard at the `updateCapabilityInstall` chokepoint, not HTTP |
| `create()` bypasses WIP cap → runaway spend | high | Concern 04: drafting spawn routed through `dispatch` + per-tick budget + wall-clock kill |
| No demand dedup; orphan worktrees across restart | med-high | Concern 02: `dedupKey`; queue in capability snapshot (survives restart); v2-P4 reaper |
| Frontier degenerate on one binary instance | significant | Frontier deferred to v2 behind P2+P3 |
| `agent-factory-architect` catalog manifest already exists, unrun | med | Noted as prior art; it's a commission/Flue loop and inherits the same two criticals, so v1 is not based on activating it — but v2-P2 reuses its acceptance mechanism |

## Open Questions (resolved)
- *Author workflows or skills?* → v1 authors whatever the demand implies (skills/docs/profile/workflow); human is the gate, so no per-type behavioral-gateability constraint. Resolved.
- *Is v1 distinct from existing proposals?* → Yes, via drafted-manifest + provenance schema + daemon demand source. Accepted with the risk-mitigation floor above.
