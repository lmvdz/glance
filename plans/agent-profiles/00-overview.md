# Agent Profiles — per-step (harness × model × skills) configuration

## Outcome
Any glance unit can be created from a named **Agent Profile** = a full `{harness, bin, model, thinking, skills, persona, approval}` bundle, so "this unit runs claude-code+sonnet with the coding skillset" or "omp+fable with the design skillset" is one `profileId`. Profiles come from a shareable project catalog (`.glance/profiles.json`) as well as operator env. Differentiated pipelines are chains of profiled units (the model axis within one stage is already handled by the shipped `model_stylesheet`).

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 — Elevate AgentProfile to a full bundle + secure project catalog | **DONE (PR #92)** — profile selects harness/bin/thinking; `.glance/profiles.json` catalog, capability-restricted (repo can't set bin/unverified-harness = RCE fix). | architectural | src/types.ts, src/agent-profiles.ts, src/squad-manager.ts, tests |
| 02 — Bind a profile to real skills via MCP servers | **DONE (PR #92)** — the user-chosen "skills axis". `profile.mcp` → `<worktree>/.omp/mcp.json` (omp) + ACP session channel; repo-mcp rejected (RCE class); DTO exposes names only. This is what makes "designer" ≠ "coder" for real, not persona text. | architectural | src/types.ts, src/agent-profiles.ts, src/squad-manager.ts, src/acp-agent-driver.ts, src/mcp-config.ts, tests |
| 03 — (DEFERRED, gated on user's container choice) chained-units pipeline + per-branch harness | Multi-harness pipelines as chained profiled units; thread harness/profileId through BranchSpec for parallel fan-out. | architectural | src/workflow-driver.ts, src/squad-manager.ts (spawnFleetBranch) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | The foundation — correct regardless of the container fork. |
| 2 | 02 | The skills axis (user-chosen next slice). Stacks on 01. |
| — | 03 | Gated on the DESIGN.md open-question (chained-units vs graph-nodes). |

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
