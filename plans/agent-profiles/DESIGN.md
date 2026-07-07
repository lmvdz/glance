# Design: Agent Profiles — per-step (harness × model × skills) configuration

## The user's ask
"Instead of locking into omp or auggie, allow complete configuration — certain LLM models are good at coding, others at design/UI-UX — so certain workflows require certain agents with specific skill sets at certain points in their flows." And: the same for certain harnesses running certain models. So: per step, choose the (harness × model × skillset) that fits that step's task class.

## Approach (reframed by the adversarial design pass)
Two independent red teams, verifying against source, found the intuitive shape — "assign a harness per node inside one workflow graph" — **fights the architecture**, and that the real win is 90% already built. The reframe:

**The Agent Profile is the vocabulary of capability — a named bundle `{harness, bin, model, thinking, skills, persona, approval}` — applied at every point an agent is *spawned*. A differentiated pipeline is a chain of profiled units handing off via artifacts, not harness-switching nodes in one shared-context graph.**

Why: workflow context lives *inside* the persistent inner omp `RpcAgent` process (`WorkflowDriver.acquireInner` caches one agent for the whole run; the executor sends only the current node's body per turn, never re-serializing the conversation). `AgentDriver` has live `setModel`/`setThinkingLevel` but **no** `setSystemPrompt`/`setHarness`. So mid-run you can only re-tune *model* and *thinking* on the shared thread — harness, persona, and skills are spawn-time. Switching harness mid-workflow means a fresh process with **zero shared history**, and there is no cross-lineage context channel today (an agent node's output lands in `lastText`, which the executor never injects into any prompt). A "harness switch" is therefore *inherently a process/handoff boundary* — which is exactly what a separate glance unit already is.

glance already has everything the chained-units model needs: per-unit harness selection (`makeDriver` dispatches sandbox/ACP/omp-rpc by harness — fully wired), isolated worktrees, a queryable context fabric, and plan→commission handoff. The **model** axis within a single shared-context stage is already delivered by the shipped `model_stylesheet`.

## What actually ships (v1) vs what the intuition assumed
| Layer | Status | v1 action |
|---|---|---|
| Per-unit harness/model/bin | Wired end-to-end via `CreateAgentOptions.harness` → `makeDriver`, but **a profile can't select it** (dead code) | Elevate `AgentProfile` + wire it |
| Per-step model in ONE shared-context workflow | **Already ships** (`model_stylesheet` + executor `setModel`/`setThinkingLevel`) | Reuse — don't reinvent |
| Per-step harness in ONE graph | Architecturally incoherent (context can't cross the boundary) | **Not built** — expressed as chained units instead |
| Skills that make "designer" ≠ "coder" | Underpowered — soft tool-grant string + persona text; real `CapabilitySkillSpec`/MCP bindings exist but aren't surfaced into profiles | v1 foundation now; deep skill/MCP-per-profile is the next focused slice |

## Key Decisions
| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Unit of configuration | Agent Profile = full `{harness,bin,model,thinking,skills,persona,approval}` bundle, applied at unit create | Per-node fields in the workflow graph | The graph node and a separate unit are the *same thing* once a harness boundary = a process boundary; the profile is the reusable vocabulary |
| Multi-harness pipeline container | **Chained units** handing off via artifacts (branch/PR/plan-doc/fabric) | One workflow graph with per-node harnesses | Context can't cross a harness boundary in-process; chained units is the seam glance already has |
| Per-step *model* (same stage) | Keep the shipped `model_stylesheet` | Rebuild in the profile system | Already works on the omp inner thread; gate it on `CapabilityDescriptor.modelSwitch` so it errors (not silently no-ops) on ACP |
| Config location | `.glance/profiles.json` project catalog (v1) + env `OMP_SQUAD_PROFILES` (operator) | Inline-in-workflow profiles | One durable, shareable source proves it; inline is a v2 convenience only useful for the graph-node route we're not taking |
| Security of repo config | Repo `.glance/profiles.json` may carry ONLY safe axes (model, thinking, persona, approval, capability grants against an allowlist). **`bin` and unverified-`harness` are rejected** from repo files | Trust repo config | `bin` flows unchecked to `Bun.spawn` — a committed profile = RCE on `glance up` in a cloned repo. Those axes stay env/operator-only |

## Risks
- **Skills axis is the real differentiator and is the least built.** A "designer profile" that's just "coder profile + different memory text" won't be meaningfully better at design. v1 lands the bundle foundation; the profile→(skill packs / MCP servers) binding is the highest-value follow-on and needs its own focused design against `src/capabilities/`.
- **Chained-units handoff quality** depends on artifacts + the context fabric being good enough to carry a stage's output to the next. That's an existing seam, but multi-harness pipelines will stress it.
- Model-switch on ACP is a silent no-op today (`setModel(...).catch(()=>{})` on a `modelSwitch:false` driver) — must become a loud capability error.

## Red Team Concerns Addressed
| Concern | Severity | Resolution |
|---|---|---|
| Per-node harness in one graph is incoherent — context can't cross the in-process boundary; no cross-lineage channel | critical | Reframed: differentiated stages = chained units; per-node harness-in-graph **cut** |
| `bin`/unverified-harness in a committed `.glance/profiles.json` = RCE via `Bun.spawn` | critical | Repo config capability-restricted; `bin`/unverified-harness env/operator-only, rejected + warned from repo files |
| Model/thinking switch silently no-ops on ACP inner | critical | Gate on `CapabilityDescriptor`; error, don't swallow |
| Profile-per-unit is 90% shipped — that's the real v1; per-node graph machinery is speculative | significant | v1 = profile-as-bundle at unit level; graph/branch/isolated-lineage harness deferred |
| Skills underpowered — the actual product value | significant | Foundation now; deep skill/MCP-per-profile binding is the named next slice |
| Config "both" = 2 loaders when 1 proves it | minor | v1 = project catalog + env only; inline-workflow profiles deferred |

## Open Question (the one genuine fork for the user)
The intuition was per-node-in-a-graph; the evidence says chained-units. v1 builds the profile-as-bundle foundation (correct either way). The fork for the next slice: **(A)** multi-harness pipelines as chained profiled units (recommended — architecture-aligned) + per-*branch* harness for parallel fan-out; vs **(B)** still pursue per-node harness in one graph, accepting each differentiated step is a context-blind fresh lineage that only sees explicitly-threaded artifacts. Recommend A.
