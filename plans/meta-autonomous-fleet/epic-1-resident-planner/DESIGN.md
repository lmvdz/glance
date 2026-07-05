# Design: Epic 1 — Resident planner

The autonomous complement to the human `/plan` skill: a standing daemon loop that
ingests a high-level objective and emits/maintains a living concern-DAG under
`plans/<name>/`, re-planning as verified reality shifts. It is the **inverse of
`plan-sync.ts`**: plan-sync reconciles STATUS *downward* (open→done) off Plane
state; the resident planner reconciles the *frontier* — it creates and
re-decomposes concerns from an objective, never touching a concern's STATUS.

## Ground truth (verified against the current tree)

| Attach point | Symbol / line | Role in this epic |
|---|---|---|
| `src/plan-sync.ts` | `syncPlanStatuses` (:66), `PlanSyncDeps` (:46) | The inverse to mirror in shape; its one-directional discipline is the template for "never rewrite a terminal STATUS". |
| `src/features.ts` | `listPlanDirs` (:150), `parsePlanConcerns` (:360), `PlanConcern` (:284) | Read existing plan state; frontmatter conventions the writer must emit. |
| `src/features.ts` | `validatePlanConcerns(repo, planDir)` (:410) | **The DAG gate already exists** — it maps concerns → `GraphConcernInput` and returns `buildPlanGraph(...).issues`. The writer calls it after writing; refuse/rollback on any issue. Do NOT re-implement cycle detection. |
| `webapp/src/lib/planGraph.ts` | `buildPlanGraph` (:116), `parseDependencyTable` (:65), `PlanGraphIssue` (:40) | The overview table the writer emits (`## Dependency graph` heading, `\| Concern \| BLOCKED_BY \|` rows with concern numbers) is what `parseDependencyTable` reads back. Already imported by features.ts. |
| `src/done-proof.ts` | `hasProof(stateDir, id)` (:88), `getDoneProofByIssue` (:81) | **The verified-state oracle for Epic 1.** A concern is verified-done iff its `PLANE:` id has a recorded DoneProof — the exact predicate plan-sync uses to gate `done` writes. |
| `src/opportunity.ts` | `Opportunity` class (:108) | The loop template: `start(intervalMs)`/`stop()`/`tick()`, JSON seen-map persistence in `stateDir`, `AutomationRecorder` heartbeat per tick, `OMP_SQUAD_*` env gate. Copy this shape. |
| `src/squad-manager.ts` | `start()` plan-sync block (:739–757) + Opportunity block (:797–813); `stop()` teardown (:918, :922); `this.stateDir` (:536), `this.bin` (:541), `emitFeaturesChanged`, `this.opportunities` (:482), automation status (:4559) | Where the loop is constructed behind the flag and torn down. |
| `src/intake.ts` | `routeIntake` (:43), `IntakeDecision` (:17), `ompClassify` (:92) | Per-concern process choice + the injected-`Classify` pattern the decompose LLM call copies. |
| `src/omp-call.ts` | `decideTyped` (:53), `ompOneShot` (:16), `extractJsonObject` (:35) | One-shot LLM decode with guaranteed fallback — how `decompose` calls the model. |
| `src/index.ts` | `cmdPlanValidate` (:597), dispatch (:745), help (:74) | Template for the `plan-decompose` CLI leaf. |

## Decisions already made (leaves inherit these — no re-litigation)

1. **Objective ingestion = a file, not a UI/API.** A planner-owned plan is any
   `plans/<name>/` dir that contains an `OBJECTIVE.md` file. Its text is the
   high-level goal; the dir basename is the plan name. This marker is what
   distinguishes planner-owned plans from human `/plan` output, is
   operator-authorable with zero new surface, and is idempotent. The writer
   MUST NEVER overwrite or delete `OBJECTIVE.md`.

2. **`ConcernDraft` schema** (defined once in `src/planner.ts`, imported by the
   writer and loop):
   ```ts
   interface ConcernDraft {
     num: number;            // NN ordering / filename prefix
     slug: string;           // kebab filename stem, e.g. "resident-loop"
     title: string;          // "# " heading
     priority: "p0"|"p1"|"p2"|"p3";
     complexity: "mechanical"|"architectural"|"research";
     touches: string[];      // TOUCHES: line
     blockedBy: number[];    // concern numbers → overview dependency table
     goal: string;           // "## Goal" prose
     approach: string;       // "## Approach" prose
     acceptance: string[];   // "## Acceptance Criteria" bullets
   }
   ```
   The planner emits **STATUS: open only** and **no `PLANE:` line** — filing to
   Plane and STATUS collapse are owned by existing pipelines (plane-curator /
   `/plan-to-plane` + plan-sync), explicitly out of scope here.

3. **Frontier collapse is distributed, each slice decision-made:**
   - The prompt (leaf 01) lists verified-done concerns as *already complete — do
     not re-emit*, so the model plans only the remaining frontier.
   - The writer (leaf 02) is one-directional like plan-sync: it updates an
     existing concern file's body in place but **never rewrites a terminal
     STATUS back to open**, and never deletes a concern whose STATUS is terminal.
   - The loop (leaf 03) builds the verified set from `hasProof(stateDir, planeId)`
     ORed with a terminal STATUS in the doc.

4. **Idempotence + WIP discipline.** One objective per tick. Re-decompose only
   when the decomposition inputs changed: the loop stores a hash of
   `(objective text + sorted verified-concern ids)` in its state file and skips
   the LLM call + write when the hash is unchanged. This is what makes a second
   tick a no-op and a verified-done event trigger exactly one re-plan.

5. **DAG gate = write-then-validate-then-rollback.** The writer snapshots the
   plan dir's current planner-authored files, writes the new set, calls
   `validatePlanConcerns`; if `issues.length > 0` it restores the snapshot,
   logs the `PlanGraphIssue[]`, and reports failure. A cyclic/dangling plan is
   never left on disk.

6. **Gate behind `OMP_SQUAD_RESIDENT_PLANNER`** (default OFF — opt-in, unlike the
   other loops which default ON). This is a new, LLM-cost-bearing writer of
   source-tree files; it stays off until explicitly armed.

## What Epic 1 does NOT own

- Filing concerns to Plane (existing plane-curator / `/plan-to-plane`).
- Dispatching concerns to agents (existing autodispatch / Orchestrator).
- Writing STATUS transitions (plan-sync owns downward; the planner is upward-only
  on *structure*, never on STATUS).
- The Stop-hook / convergence driver (Epic 7).
- The independent validator's verified-state (Epic 3) — Epic 1 uses the DoneProof
  ledger as its oracle today; if Epic 3 lands a richer verified signal, only the
  loop's injected `verified()` predicate changes (leaf 03), nothing else.
