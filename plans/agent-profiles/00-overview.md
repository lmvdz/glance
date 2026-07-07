# Agent Profiles — per-step (harness × model × skills) configuration

## Outcome
Any glance unit can be created from a named **Agent Profile** = a full `{harness, bin, model, thinking, skills, persona, approval}` bundle, so "this unit runs claude-code+sonnet with the coding skillset" or "omp+fable with the design skillset" is one `profileId`. Profiles come from a shareable project catalog (`.glance/profiles.json`) as well as operator env. Differentiated pipelines are chains of profiled units (the model axis within one stage is already handled by the shipped `model_stylesheet`).

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 — Elevate AgentProfile to a full bundle + secure project catalog | A profile can't select a harness today (dead `runtime` field; no `harness`/`bin`/`thinking`). Profiles load only from env. Wire the bundle into unit create; load a repo `.glance/profiles.json` — capability-restricted (no `bin`/unverified-harness from repo files, RCE fix). | architectural | src/types.ts, src/agent-profiles.ts, src/squad-manager.ts, src/harness-registry.ts (capability check), tests |
| 02 — (NEXT, gated on user's container choice) chained-units pipeline + per-branch harness | Multi-harness pipelines as chained profiled units; thread harness/profileId through BranchSpec for parallel fan-out. | architectural | src/workflow-driver.ts, src/squad-manager.ts (spawnFleetBranch) |
| 03 — (NEXT, highest product value) skills/MCP-per-profile binding | Make "designer" actually good at design: bind a profile to real capability skill-packs / MCP servers, not just persona text. Needs its own design against src/capabilities/. | research | src/capabilities/, src/agent-profiles.ts, src/types.ts |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | The foundation — correct regardless of the container fork. Build now. |
| — | 02, 03 | Gated on the DESIGN.md open-question (chained-units vs graph-nodes) + a focused skills design. Present to user first. |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | none | `grep -n 'harness' src/agent-profiles.ts` = 0 (profile has no harness axis) |
| 02 | 01 + user confirms container = chained-units | `BranchSpec` in workflow-driver.ts carries no `harness` field |
| 03 | 01 + focused skills design | `AgentProfile.capabilities` is a soft string[] only |

## Notes
- Reframed by 2 red teams: per-node harness in ONE workflow graph is incoherent (context lives in the persistent inner omp process; can't cross a harness/process boundary). Differentiated stages = chained units. See DESIGN.md.
- Branch `feat/agent-profiles` off origin/main (has harness registry + Intervene View). Cmux attention work stays on PR #83.
- WIP snapshot at plan time: 79 plans with open concerns (oldest meta-autonomous-fleet 2026-07-05); proceeded per the user's active direction on this design chain.
