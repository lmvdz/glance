# Distilled-lesson → future-agent behavior (STUB — belongs to Epic 6)

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
ISLEAF: false
NEEDS-DEEPER: yes

## Why this is not a leaf here

The epic seed lists "Learning-to-agents: distilled-lesson path so a recurring failure changes future
agent behavior, not just retrieval." That is **Epic 6's substrate**, not Epic 5's. DESIGN.md (meta) is
explicit: Epic 6 *executes* the designed-but-unbuilt `plans/agentic-learning-loop` and must respect its
cuts — outcome-driven, boost-only, deterministic proof as the sole land gate. Building a lesson→behavior
path inside Epic 5 would (a) duplicate Epic 6's orchestrator and (b) risk re-opening the capability-match
routing the learning-loop plan deliberately cut as a category error.

## What Epic 5 actually delivers toward it

Epic 5's contribution is the **signal**, not the loop: the `confidence` score (leaf `02`) and the
`AgentReport` channel (leaf `05`) are exactly the recurring-failure evidence a learning orchestrator
consumes. The distillation + re-injection into future agents' cold-start primer is the consumer, and it
lives in Epic 6.

## Handoff

Decompose under `plans/meta-autonomous-fleet/epic-6-learning-orchestrator/` (per the special-case in the
meta-plan: reference the existing `plans/agentic-learning-loop` concerns, add NEW leaves for
outcome-driven model assignment + threshold tuning, and — here — the confidence/report → distilled-lesson
consumer). Do NOT author it in Epic 5.
</content>
