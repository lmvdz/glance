# Epic 2 — Execution roles: sub-plan design

Two role-specialized agents on top of today's single general coder:

1. **Testing agent** — authors the acceptance test (red) BEFORE the coder implements, so the
   gate isn't the coder grading its own homework. The workflow already exists
   (`buildTddVerifyWorkflow`, verify-workflow.ts:73, fully built + tested); it is simply never
   selected. Epic 2 is **wiring**, not construction.
2. **Observing agent** — reproduces behavioral truth against the running system in its own
   worktree. The reproduce logic exists as the Observer's `confirmedGate` daemon loop
   (observer.ts:500), but only FILES an issue. We give it a workflow (`buildObserveWorkflow`,
   new) and a dispatch seam so a confirmed regression spawns a worktree agent that reproduces
   and reports, instead of the Observer merely filing.

## Decisions already made (do NOT re-open these in a leaf)

### 1. Role field is named `executionRole`, type `ExecutionRole`, NOT `role`
`role` is already taken: `types.ts:1027 export type Role = "viewer"|"operator"|"admin"` (RBAC),
used as `Actor.role` (types.ts:1039). Introducing a second `role` would collide and confuse.
Use:
```ts
/** Specialization of a coding unit. Absent = general coder (today's default). */
export type ExecutionRole = "tester" | "observer";
```
Field name `executionRole?: ExecutionRole` on `CreateAgentOptions`, `PersistedAgent`, `AgentDTO`,
and the webapp DTO mirror. `AgentKind` ("omp-operator"|"flue-service"|"workflow") is **runtime
class** and is NOT extended — a tester and an observer are both `kind:"workflow"`; `executionRole`
is an orthogonal display/behavior dimension. This matches the epic's "add a role dimension keyed
to task character" without overloading `kind`.

### 2. Workflow variant is selected by `VerifySpec.mode`, NOT by three parallel booleans
`VerifySpec` (types.ts:843) already backs the synthesized loop via `WorkflowMemberConfig.verify`
(types.ts:851). Add ONE discriminator:
```ts
/** Which synthesized loop to build. Default "verify". */
mode?: "verify" | "tdd" | "observe";
```
`makeDriver` (squad-manager.ts:2925) currently does
`p.workflow.verify ? buildVerifyWorkflow(p.workflow.verify) : undefined`. It becomes a 3-way
switch on `p.workflow.verify.mode`. This keeps ONE place that maps mode→builder, and the fork
re-parse path (squad-manager.ts:3596) mirrors the exact same switch. Do not add `tdd?:boolean`
+ `observe?:boolean` — a single `mode` is unambiguous and the fork path only has to mirror one
expression.

### 3. The intake carries the mode, not a bespoke tester flag
`IntakeDecision` (intake.ts:17) gains `mode?: "tdd"` (only value it ever emits; "observe" is
Observer-initiated, never router-initiated). `CreateAgentOptions` gains `verifyMode?:
"verify"|"tdd"|"observe"` threaded alongside the existing `verify?:string`. At the route
merge site (squad-manager.ts:2738) `verifyMode: decision.mode` is threaded; at the persisted
build (squad-manager.ts:2806) `verify: { command: opts.verify, mode: opts.verifyMode }`.

### 4. Router rule for TDD: verify-routed code change that looks behavior-adding, not trivial
Deterministic, testable heuristic in `heuristicRoute` (intake.ts:52). When the decision would be
the `verify` branch (a real code change with a detected verify command) AND the task matches a
behavior-adding signal AND is not TRIVIAL, set `mode:"tdd"`. Signal:
```ts
const TDD_SIGNAL = /\b(add|implement|feature|support|endpoint|api|handler|route|behaviou?r|new )\b/i;
```
Env override: `OMP_SQUAD_TDD=0` disables globally (never emit tdd); `OMP_SQUAD_TDD=force` sets
tdd on EVERY verify-routed task. Default (unset): the signal heuristic. Mirror the same rule in
`llmRoute` (intake.ts:69) on its `verify` branch. This is boost-only: tdd never changes the gate,
only prepends a write-test node — a false positive costs one extra red-test turn, never a wrong
land. That bounded downside is why a heuristic is acceptable here.

### 5. Observer dispatch is opt-in and does NOT replace filing on failure
New `ObserverDeps.spawnObserver?: (finding: Finding) => Promise<boolean>` (observer.ts:54).
In `tick()` (observer.ts:383 loop), for a `regression:`-fingerprinted finding (the confirmedGate
output, observer.ts:529) when `spawnObserver` is present AND
`OMP_SQUAD_OBSERVE_REPRODUCE=1`: call `spawnObserver(f)`; on success mark it reproduced/seen so
the normal file path is skipped this tick; on failure fall through to the existing file path.
Default OFF (env-gated) so no behavior change until explicitly armed — same discipline as
`OMP_SQUAD_OBSERVE_AUTODISPATCH`/`OMP_SQUAD_OBSERVE_AUTOFIX`. The manager wires `spawnObserver`
to `this.create({ repo, task, verify: <gate cmd>, verifyMode:"observe", executionRole:"observer",
autoRoute:false, track:false })`.

## Dependency spine
```
01 executionRole plumbing ─┐
02 buildObserveWorkflow ────┼─→ 03 VerifySpec.mode + driver selection ─→ 04 router emits tdd
                            └─────────────────────────────────────────┴─→ 05 observer dispatch seam
```
01 and 02 are independent and can run in parallel. 03 needs 02 (builder to switch to). 04 and 05
both need 03 (the `verifyMode`/`mode` field and the driver switch). 05 also needs 01
(`executionRole`) and 02.
