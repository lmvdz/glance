# RPI feed-forward: reviewer comments steer the next phase

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/workflow/executor.ts, src/workflow/types.ts, src/workflow-driver.ts, src/squad-manager.ts
BLOCKED_BY: 04-artifact-comment-store
VERIFY_BLOCKER: `grep -q "getUnresolvedComments" src/squad-manager.ts` (04's accessor merged)

## Goal

When a human reviews a plan/research artifact and leaves comments (04/05), feed those unresolved comments into the **next RPI phase's prompt**, so the implementer addresses the review instead of the human re-typing it — "review the plan, not 2,000 lines" (BRIEF Pattern 4).

> **Seam corrected from the draft (RedTeam F8/F9/F10, critical).** The draft injected into `WorkflowDriver`, which never builds a stage prompt. The next stage's task is assembled in `SingleAgentExecutor.runAgent` (executor.ts:89-107). A self-drive agent following the draft would wire a no-op. The correct seam is below; **re-validate it at promote time** (a human is in the loop because Goal 3 waits on `web-framework`).

## Approach

### 1. New injected prompt decorator on the executor (`src/workflow/executor.ts`)
- Add to `SingleAgentExecutorOptions` (executor.ts:31-54): `decoratePrompt?: (node: WorkflowNode, ctx: RunContext) => string | undefined`.
- In `runAgent`, after assembling `parts` (executor.ts:98-107, where `Goal:` and `lastOutput` are appended), append the decorator's output if present:
  ```ts
  const extra = this.opts.decoratePrompt?.(node, ctx);
  if (extra) parts.push(extra);
  ```
- **Guard against re-injection every turn** (RedTeam F10 — agent/prompt nodes share ONE persistent thread, `runAgent` runs per node): the decorator itself must return comments ONLY for the agent node immediately following a just-resolved gate. Use the engine's gate signal: a human gate sets `ctx.preferredLabel` (engine.ts) — gate the decorator on "a gate was just resolved and this is the first agent node after it." Simplest robust approach: have the decorator track the last-seen node id it decorated and a `ctx.vars` flag the engine sets on the post-gate edge; return non-empty at most once per gate resolution.

### 2. Thread `planDir` + phase so the decorator can query comments (RedTeam F9)
The executor knows only `node`, `ctx`, `cwd` — no `planDir`/phase. Provide them:
- Add `planDir?: string` to `WorkflowDriverOptions` (src/workflow-driver.ts) and to the executor options; `SquadManager` sets it when the run targets a plan dir (it already derives plan dirs in `features.ts`/`buildFeatures`; pass the same `planDir` through `create`/`spawnFleetBranch` into the driver).
- Map node → phase from `node.id` / `WF_STAGE` (features.ts:211 maps node labels to stages) to decide which phase's comments are relevant (e.g. comments on `research.md`/`plan.md` feed the Plan/Implement nodes).

### 3. Wire the decorator in the driver (`src/workflow-driver.ts`, executor construction ≈ :104-114)
When constructing the `SingleAgentExecutor`, pass `decoratePrompt: (node, ctx) => buildCommentBlock(this.opts.getUnresolvedComments?.(this.opts.planDir, phaseOf(node)))` where `buildCommentBlock(bodies)` returns `undefined` for an empty list, else:
```
--- Reviewer comments to address (from the plan review) ---
- <comment 1>
- <comment 2>
```
- Inject `getUnresolvedComments` into `WorkflowDriverOptions` (default: `SquadManager`'s `getUnresolvedComments` from 04). Same injection style as the existing `fleet`/`createInnerDriver` deps.

### 4. Which edge consumes comments
Feed comments on the `revise → Plan` edge (re-plan addressing the review) AND the `approve → Implement` edge (implement with the review in mind). Document this in the workflow's gate node. (If only one is wanted for v1, choose `revise → Plan`; note it.)

## Cross-Repo Side Effects

None outside omp-squad. Shares `src/squad-manager.ts` with Goal 2 (03) and Goal 3 (04) — sequence after them. The executor gains an optional, backward-compatible option (absent → today's behavior exactly).

## Verify

- Extend the existing workflow executor test (`tests/*executor*`/`tests/workflow*`): with `decoratePrompt` injected returning a fixed block on the post-gate node, assert the inner agent's turn message contains the block on that node and NOT on subsequent nodes (the re-injection guard). With `getUnresolvedComments` returning `[]`, the message is byte-identical to today (no decoration).
- A small integration-ish test: a fake gate resolution + two unresolved comments → the next `runAgent` message includes both bodies once.
- `bun run check` clean.
