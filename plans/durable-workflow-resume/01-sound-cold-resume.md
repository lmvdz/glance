# Sound cold resume + two-phase checkpoint
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/workflow/engine.ts, src/workflow/executor.ts, src/workflow-driver.ts, src/workflow/types.ts, src/squad-manager.ts, tests/workflow-resume.test.ts, README.md
BLOCKED_BY:

## Goal

Make a workflow that resumes on a **dead inner thread** (cold) re-execute its genuinely-in-flight node
instead of skipping it, and make "completed" unambiguous on disk so finished nodes are never re-run. This is
the soundness prerequisite for C02 (which widens the set of runs that cold-resume).

## Approach

**1. Two-phase checkpoint** — `src/workflow/engine.ts` `run()` loop.
Today one checkpoint fires at node *entry* (`engine.ts:79`), so a persisted `currentNode=X` cannot tell
"X about to run" from "X finished, crashed before the next entry". Keep that entry checkpoint (it preserves
the warm reattach property), and **add** a second checkpoint after `execute()` / `runParallel()` returns,
with `currentNode` advanced to the resolved `next` and `outcome` set:

```ts
// after `this.stage(shared, index, node, "end", ctx);` and `next` is resolved (~engine.ts:92-98)
opts?.checkpoint?.({
  goal, currentNode: next ?? current, visits: { ...shared.visits },
  vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel,
  index: shared.index, resumeAttempts: 0,           // reset on forward progress
});
```

A finished node has advanced `currentNode` on disk → it is never re-entered on cold restart. The only
re-runnable node is one that crashed between its own entry and exit checkpoints = genuinely in-flight.

**2. `cold` boolean, sourced for free** — no computed mode/enum (RTS-F3).
- `reconnectLive` resumes only when the inner host **survived** → warm. `adoptOrphanedAgents` runs only when
  the host is **gone** and `acquireInner` creates a fresh `RpcAgent` → cold.
- Carry `cold` on `WorkflowRunState`/`resumeState` (or one new `SingleAgentExecutorOptions` field). The
  manager's adopt `create()` path sets `cold=true`; the reconnect path leaves it `false` (default).

**3. Cold resume of the in-flight node** — `src/workflow/executor.ts` `resumeAgent`.
Today `resumeAgent` returns `{succeeded,""}` the instant `!isStreaming` (`executor.ts:150`) — fine for a warm
thread (the original turn finished), fatal for a fresh one. When `cold`, delegate to `runAgent` (which sends
the goal) instead of waiting:

```ts
async resumeAgent(node, ctx): Promise<NodeResult> {
  if (this.opts.cold) return this.runAgent(node, ctx);   // fresh thread: re-execute, re-prime the goal
  // …unchanged warm path: reattach, await the in-flight turn WITHOUT re-prompting…
}
```

Decouple `primed` from `initialRollup` (`executor.ts:78-80`): seed the rollup for the progress view as
today, but set `primed = !cold` so a cold thread re-sends `Goal:` on its first `runAgent` while still showing
restored progress (RTC-F11).

**4. Poison cap** — persist `resumeAttempts` in `EngineCheckpoint` (`src/workflow/types.ts`).
On a cold resume that re-enters the same `currentNode`, increment `resumeAttempts` (carried from the restored
checkpoint); when it reaches a cap (3), do not re-run — emit an escalate-to-human via the existing gate/
needs-input path and stop. Forward progress resets it to 0 (see the exit checkpoint above). This is the only
bound on a run that crashes the daemon *before* reaching idle — the engine visit-cap does not cover it
(`engine.ts:63-64` deliberately does not re-count the resumed node).

**5. Feed-forward survival** — persist the pending post-gate fold (RTC-F7).
`gateJustPassed` is an in-memory executor flag (`executor.ts:74`) consumed once by the next `runAgent`'s
`decoratePrompt` fold (`115-119`). On a cold restart whose `currentNode` is the agent node right after a
human gate, a fresh executor has `gateJustPassed=false` → reviewer comments are dropped and the node runs
blind. Persist the resolved fold text (or the boolean) in checkpoint `vars` and re-seed it on resume.

**6. Cosmetic** — when seeding `initialRollup`, dedupe the resumed node's stage-start so it isn't listed
twice in `getState().todoPhases` (RTC-F10).

## Cross-Repo Side Effects
None. Internal to omp-squad. The warm reattach path and its tests stay behavior-identical; only the cold
(dead-thread) path changes, plus one added exit checkpoint per node.

## Known ceilings (mark with `ponytail:` comments in code)
- The single genuinely-in-flight node still re-runs on cold resume → may duplicate non-worktree side effects
  (re-file a Plane issue, re-push). Bounded by `resumeAttempts`; `.fabro` nodes are documented as
  continuation-safe / HEAD-keyed. Upgrade path: per-node idempotency key.
- Command nodes that crashed genuinely mid-run re-run in full; document that `.fabro` command scripts MUST be
  idempotent / HEAD-keyed (the two-phase checkpoint already prevents re-running a *finished* command).

## Docs (ship with behavior — AGENTS.md rule)
README "Workflow engine" section: document that a workflow run now resumes after a full daemon crash (not
just a detached-host survival), and that command/agent nodes in a `.fabro` graph must be idempotent because
a node interrupted mid-execution is re-run on cold resume.

## Verify
Extend `tests/workflow-resume.test.ts` (deterministic, fake `AgentDriver`, no model tokens). The existing
file already exercises the warm path; add:
- **cold resume re-runs the in-flight node**: with `cold=true` and a fresh (non-streaming, messageCount 0)
  fake agent, the in-flight `currentNode` calls `runAgent` (goal re-sent) — assert via a `RecordingExecutor`
  that the node ran fresh, not skipped, and earlier completed nodes did NOT re-run.
- **two-phase: a completed node is not re-run**: drive `run()` to completion of node X (exit checkpoint
  advances `currentNode` to its successor), then resume from that checkpoint — assert X is not re-entered.
- **poison cap**: feed a checkpoint with `resumeAttempts` at the cap and a cold resume — assert it escalates
  (gate raised) and does not call `runAgent` again.
- **warm path unchanged**: the existing "waits for an in-flight turn without re-prompting" and "advances
  immediately when idle" tests stay green byte-for-byte.
- Gate: `bun run check && bun test`.

## Release (dispatch when the operator wants it)
```bash
omp-squad add ~/sui/omp-squad --name cold-resume --thinking high \
  --task "Implement plans/durable-workflow-resume/01-sound-cold-resume.md: two-phase checkpoint in src/workflow/engine.ts, a cold boolean threaded from the adopt path, cold resume re-runs the in-flight node via runAgent (primed=false) in src/workflow/executor.ts, persisted resumeAttempts poison cap, feed-forward survival, README + tests/workflow-resume.test.ts per the doc." \
  --verify "bun run check && bun test"
```
