# Design: Factory-inspired control plane

## Approach

Use a small control-plane overlay, not a Factory clone. Keep `SquadManager` authoritative, keep workflows optional for milestone-heavy work, and add only the state required to make autonomy, proof, land, and replay unambiguous.

The plan adds four primitives:

1. Canonical `autonomyMode` on every run/agent: `observe`, `assist`, `autodrive`.
   - `observe`: read-only inspection; no branch mutation, proof execution, or landing.
   - `assist`: may edit/run commands under guard and approval policy; may reach `ready-to-land`; never lands automatically.
   - `autodrive`: may verify and land only when policy, guard, proof, and freshness checks pass.
2. Verification state before land: `needs-proof`, `verifying`, `verified`, `blocked`, `expired`.
3. Fresh proof fingerprint bound to the exact tree being landed: commit, tree hash, dirty status, base HEAD, command hash/source, runner policy, timestamp/TTL, artifacts.
4. Durable append-only event journal as replay/audit source; snapshots remain cache.

In scope: mode fields, mode transition command/API, DTO visibility, manager/service authorization, fresh proof gating, scoped proof records, serialized verify/land, proof runner boundary, event journal, and workflow milestone integration.

Out of scope: plugin bus, policy DSL, enterprise hierarchy, managed remote compute, model router, DLP platform, deterministic VM replay, or mandatory workflow wrapping for every agent.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Primary shape | Small overlay on manager/orchestrator/proof/land/session seams | Workflow-first runtime; new platform layer | Smallest safe change; avoids a second control plane. |
| Autonomy modes | Persist `observe | assist | autodrive`; expose requested/effective mode | Infer from env vars or `approvalMode` | Hidden inference causes unsafe drift between surfaces. |
| Mode enforcement | Manager/service methods plus proof/land services | Only `applyCommand` | REST, workflow, scheduler, and TUI must not have privileged side doors. |
| Mode transitions | Explicit audited command/API | UI-local booleans | Operators need actor, old mode, new requested mode, effective mode, and reason. |
| Proof freshness | Fingerprint commit, tree hash, dirty status, base HEAD, command hash/source, runner policy | Commit-only freshness | Landing can commit dirty WIP after proof today; proof must bind the exact tree. |
| Dirty WIP before land | Autonomous land first reaches clean committed tree, then verifies that exact tree | Verify dirty tree then commit | Prevents unverified content from being landed. |
| Land invariant | `land()` enforces fresh proof unless explicit audited manual force | Check proof only at callers | Auto-land must not bypass proof via lower-level helper. |
| Orchestrator concurrency | Single-flight tick and per-agent verify/land lock | Current interval-only tick | Prevents duplicate verify/land runs. |
| Proof runner | Minimal env, no daemon secrets, allowlisted command source, resource caps, optional sandbox/network-off | Current `bash -lc` with daemon env | Verification runs branch code and must be treated as hostile. |
| Guards/leasing | Driver capability contract for mutating modes; leases remain advisory | Treat RPC hook and leases as hard safety | ACP/sandbox/helper runtimes can bypass current hook. |
| Proof storage | Manager/org stateDir first; DB only when needed | Global path-hash cache | Proofs need tenant/run identity and replayability. |
| Replay | Append structured events before emit; snapshots cache state | Capped transcript/snapshot replay | Postmortems need ordered state transitions, not best-effort logs. |
| Workflows | Workflows inherit mode/proof/session fields only for milestone-heavy work | Wrap every agent in a workflow | Keeps simple work simple. |

## Risks

| Risk | Mitigation |
|---|---|
| Surface bypass remains | Move checks into manager/service methods and `land()` itself. |
| Proof executes hostile code | Minimal env, scoped credentials, allowlisted commands, optional sandbox/network-off. |
| Driver capability gaps | Deny/downgrade mutating modes when a runtime cannot prove guard/policy support. |
| Verify/land races | Single-flight tick, per-agent lock, durable `verifying` state. |
| Replay leaks secrets | Redact at write time, store structured payloads, cap excerpts, use artifact refs. |
| Mode semantics conflict with existing knobs | Compute/render effective mode; reject contradictory combinations or cap downward. |
| Proof expiry surprises users | Emit `expired`, clear ready state, show `proof expired` blocked reason. |
| Scope creeps into platform clone | Keep plan to modes, proof, replay, scoped policy, and milestone workflows. |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| Proof freshness keyed only to commit; land can commit dirty WIP after proof | critical | Proof fingerprint includes commit, tree hash, dirty status, base HEAD, command hash/source, runner policy, TTL. Autonomous land verifies a clean committed tree. |
| Orchestrator ticks overlap | critical | Add single-flight tick, per-agent verify/land lock, persist `verifying` before awaits. |
| Verification runs hostile code with daemon env | critical | Proof runner becomes its own trust boundary with minimal env and optional sandbox/network-off. |
| Guards miss ACP/sandbox/helper processes | critical | Mutating modes require driver capability contract; missing capability downgrades/refuses mode. |
| REST handlers bypass `applyCommand` | high | Mode checks live at manager/service method boundaries and proof/land services. |
| `land()` lacks proof gate | high | `land()` enforces fresh proof by default for all non-forced land paths. |
| No canonical autonomy/verification fields | high | Add persisted fields, DTO fields, and transition command/API. |
| Persistence is not replayable | high | Add append-only journal with sequence, runId, agentId, actor, causationId. |
| Proof cache is global path-hash | high | Scope proofs to manager/org stateDir with explicit identity. |
| UI cannot show proof/mode state | medium | Expose requested/effective mode, proof state, blocked reason, available actions. |

## Open Questions

| Question | Default for this plan |
|---|---|
| Proof storage: stateDir JSON or DB? | Start with manager/org `stateDir`; DB later only if query/audit needs require it. |
| Is sandbox mandatory for every proof? | No. Minimal-env runner everywhere; sandbox/network-off where available or required by `autodrive` policy. |
| How broad should workflow adoption be? | Only milestone-heavy multi-agent work. |
| First migration slice? | Fresh proof/land invariant and serialized verify/land first. |
