# Design: Agentic learning loop for omp-squad

Handoff from `/research` on arXiv:2606.24937 (*The Hitchhiker's Guide to Agentic AI*). The paper's agentic-systems chapters map almost 1:1 onto omp-squad, which already **captures** the raw signals a learning agent needs — digests (trajectories), proof (execution reward), observer/scout (failure events) — but never **feeds them back**. This plan closes that loop, borrowing the patterns and adopting no dependencies and no model training.

## Approach

Turn existing agent exhaust into a bounded, measured learning loop. Four moves, each behind an `OMP_SQUAD_*` flag so it can be A/B-compared against the current system:

1. **Reflexion** — between fixup attempts, generate a short natural-language root-cause note and inject it into the next attempt. Learning across attempts with no weight updates.
2. **Reward-boost** — tag session digests with their verified proof outcome and let confirmed first-try passes rank higher in the retrieval that primes future agents.
3. **Retrieval provenance** — attach source + timestamp to retrieval results and move the untrusted-content fence inside the primer builders so it can't be forgotten.
4. **Failure memory (downscoped)** — when the *same* failure recurs (by the observer's existing fingerprint), surface its root cause as a warning; not similarity-matched guesswork.

A measurement concern ships **first** and is load-bearing: without a baseline, a learning loop is indistinguishable from noise that costs tokens.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Reward semantics | Proof outcome **boosts** memory weight; absence never penalises | Drop/down-weight low-signal docs below a threshold τ | `proof.ok` is a strong land gate but a weak learning reward — it is absent for branchless runs and swept at 24h. Dropping on absence gates on worktree topology, not signal, and starves novel cold-starts. |
| Reflection placement | At **fixup-entry**, reading the latest command output; generation in the orchestrator/workflow, best-effort, never throws | At verify-fail time, off `proof.detail`; inside `resolver.ts` | The graph is `verify→codefix→fixup`; codefix mutates the tree first, so verify-time context is stale. `resolver.ts` is pure — an LLM call there breaks purity and an unhandled reject crashes the daemon tick. |
| Reflection accumulation | Refutation: one most-recent note; if failure output is unchanged, drop the last hypothesis; reflect only from the 2nd fixup on | Stack all reflections across attempts | Reflections are generated when evidence is weakest; stacking amplifies confidently-wrong lessons. Refutation + a cost gate keeps the loop honest and cheap. |
| Retrieval confidence | Provenance is additive; **weak matches are labelled, not dropped** | CRAG-style drop-below-confidence floor for the primer | A novel task scores low across the board; a hard floor turns "3 weak leads" into an empty primer exactly when orientation matters most. |
| New store layout | **One file per worktree/agent**, merged and per-actor-scoped at read; tolerate a torn trailing line | Single shared append-only JSONL | The codebase already got burned by shared-append corruption (scout-seen defense) and already solved it right (`proof.ts` per-worktree files). Every fact source is scoped through `scopeFor`; a flat store leaks cross-repo/tenant failures into primers. |
| Failure retrieval key | Observer's existing **fingerprint streak** (same failure recurring) | BM25 similarity over failure text | In a varied factory the most-similar failure is usually same-*subsystem*, different-*mistake*; negative-priming on a false analogy is actively harmful. Fingerprint match is high-precision and near-zero new machinery. |
| Rollout | Every concept behind an `OMP_SQUAD_*` flag; A/B by flag against measured baseline | Ship on by default | A learning loop you cannot attribute is indistinguishable from model drift or task-mix change. Flags make each concept falsifiable. |

## Cut / deferred / moved (from the adversarial design pass)

| Item | Disposition | Why |
|---|---|---|
| Capability-match routing (orig #5) | **Cut** | The 8 catalog entries are workflow *recipes*, not task classifiers; matching free-text tasks against them mis-routes silently and emits a label the executor consumes nowhere. |
| Trajectory-pool exemplars (orig #6) | **Deferred** to a follow-up plan | In a varied factory the "most-similar successful trajectory" is usually irrelevant; "task-shape" has no field to key on; inherits every reward-signal flaw and contradicts the provenance concern's confidence policy. |
| MCP/A2A timeout-retry split (orig #7) | **Moved** to the reliability/resolver backlog | Sound, but a reliability-policy change with no connection to the learning loop; stateful-delegation retry also needs resume/reconcile, not blind retry. |

## Risks

- **Reward hacking propagation** — a green-but-goal-missing run could be boosted. Mitigation: boost only on *fresh-checked* proof (`isFresh`) with zero fixup visits (first-try green), and never treat absence as negative.
- **Reflection cost at fleet scale** — a haiku call per fixup × parallel agents. Mitigation: reflect only from the 2nd fixup on; best-effort and non-blocking so fixup runs even if the call fails.
- **Cross-type primer flooding** — the same failure surfacing as digest + failure-doc + scout issue. Mitigation: dedup across types by `(repo, fingerprint)` before ranking; one surface per underlying failure.
- **No headroom** — if baseline first-try-green is already very high, the loop solves a non-problem. Mitigation: the measurement concern ships first and gates the rest.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| `proof.ok` is a weak learning reward, absent for many runs | critical | Boost-only; absence = unknown; require fresh + first-try-green for exemplar-grade signal |
| New stores bypass per-actor `scopeFor` invariant | critical | Every store source-tagged and scope-filtered on read, like `loadScoutFacts` |
| Shared-JSONL corruption under parallel worktree writers | significant | One file per worktree (proof pattern); per-line tolerant read |
| Reflection generated with least evidence, injected most forcefully | critical | Refutation not accumulation; latest output not `proof.detail`; 2nd-fixup gate; orchestrator-level, never throws |
| Confidence-drop starves novel cold-starts | significant | Provenance additive; label weak matches, never drop from primer |
| Fencing is a per-call-site convention (`buildContextPrimer` returns bare markdown) | significant | Move `fenceUntrusted` inside the builders; test asserts every injection path is fenced |
| τ-drop at corpus-build perturbs IDF for all docs | significant | No corpus-time drop; reward is a `KbDoc.weight` contribution folded by existing BM25 |
| No baseline / no metric | critical | Measurement concern ships first; five metrics from existing exhaust; A/B by flag |
| Capability routing is a category error | significant | Cut |
| Whole-trajectory exemplars mislead in a varied factory | significant | Deferred |
