# fork() command: git branch-from-checkpoint, fix-up-tier visit reset, and the checkpoints REST endpoint
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/types.ts, src/server.ts

## Goal
Implement fork(id, {seq?}) on SquadManager: resolve the base sha via git rev-parse HEAD in the original worktree, cut a new branch and reuse addWorktree's existing-branch path, validate the checkpoint's currentNode against the parsed graph, reset visits for every goalGate's retryTarget + overflow closure while carrying other counts forward, seed forkedFrom lineage, mark the original superseded, and spawn via createInternal with bypassCap+cold; add the ClientCommand fork type, wire it through applyCommand, and expose GET /api/agents/:id/checkpoints.

## Approach
**types.ts**
1. Add `{ type: "fork"; id: string; seq?: number }` to the `ClientCommand` union (current line ~887-900).
2. `commandRole(cmd)` / `commandTier` (wherever the RBAC tier map lives — grep for `commandRole` near the `applyCommand` RBAC chokepoint) needs a `fork` entry; treat it the same tier as `restart` (operator-initiated, not admin-only, matching the design's "rare, deliberate, operator-initiated" framing) unless the existing `restart` tier is already `admin` — mirror whatever `restart` uses.

**squad-manager.ts — fork()**
3. `async fork(id: string, opts: {seq?: number} = {}, actor: Actor): Promise<AgentDTO>`:
   - `const rec = this.agents.get(id); if (!rec) throw new Error("agent not found");`
   - Refuse while working: `if (rec.dto.status === "working") throw new Error("cannot fork a running agent — stop or wait for it to finish");`
   - Refuse if no terminal marker / not fork-eligible: `if (!rec.dto.forkAvailable) throw new Error("this agent has no fork point available");`
   - One live fork per source runId: scan `this.agents.values()` for an existing record whose `options.workflowState?.forkedFrom?.runId === rec.options.workflowState!.runId` and whose status isn't stopped/error-superseded; if found, throw "a fork of this run already exists".
   - Resolve the checkpoint: `const runId = rec.options.workflowState!.runId!; const entries = await readCheckpoints(this.stateDir, runId); const chosen = opts.seq !== undefined ? entries.find(e => e.seq === opts.seq) : entries[entries.length - 1]; if (!chosen) throw new Error("no checkpoint found");`
   - Validate `chosen.currentNode` against the parsed graph: re-parse the workflow the same way `makeDriver` does (`parseWorkflow`/`resolveWorkflowPath` on `rec.options.workflow!.path`), `if (!wf.nodes.has(chosen.currentNode)) throw new Error(`checkpoint node "${chosen.currentNode}" no longer exists in the workflow graph (it may have been edited) — pick a different step`);`.
   - Resolve base sha: `if (!existsSync(rec.dto.worktree)) throw new Error("original worktree is gone — cannot fork"); const sha = (await runGitInWorktree(rec.dto.worktree, ["rev-parse", "HEAD"])).stdout.trim(); if (!sha) throw new Error("could not resolve HEAD in the original worktree");` (use the same `Bun.spawn` git pattern as worktree.ts's `runGit`, or import an exported helper if one exists — check `git-harden.ts` for `GIT_HARDEN_ARGS`/`GIT_HARDEN_ENV` to reuse).
   - Name stabilization: `const baseName = rec.dto.name.replace(/-fork(-\d+)?$/,""); const newName = `${baseName}-fork`;`
   - Compute visit reset: parse the workflow (already done above), find every `goalGate` node, collect `retryTarget` and walk its `overflow` chain (`for (let t = node.retryTarget; t; t = wf.nodes.get(t)?.overflow) tiers.add(t);`) across ALL goalGate nodes in the graph. `const visits = {...chosen.visits}; for (const tier of tiers) delete visits[tier];` (deleting = 0 on next read, since `shared.visits[x] ?? 0` — or explicitly `visits[tier] = 0`, whichever the engine's read-path prefers; use `visits[tier] = 0` for clarity).
   - Create the branch off `sha`: `await runGitInWorktree(rec.dto.repo, ["branch", `squad/PLACEHOLDER`, sha])` — actually the id isn't known yet; sequence: compute `const newId = newAgentId(newName);` FIRST, then `await runGitInWorktree(rec.dto.repo, ["branch", `squad/${newId}`, sha]);` (branch off the repo root, not the worktree, matching `addWorktree`'s own `repoRoot` resolution), then call `createInternal({repo: rec.dto.repo, name: newName, branch: `squad/${newId}`, model: rec.dto.model, approvalMode: rec.options.approvalMode, task: rec.options.task, workflow: rec.options.workflow?.path, workflowState: {...chosen, visits, resumeAttempts: 0, rollup: [], forkedFrom: {runId, seq: chosen.seq}, runId: undefined, terminal: undefined}, bypassCap: true, cold: true, explicitId: newId}, actor)` — `addWorktree` (unmodified) takes the existing-branch path since `squad/${newId}` now exists (worktree.ts lines 85-88).
   - Mark the original superseded: `rec.options.workflowState!.terminal!.supersededBy = newId; rec.dto.forkAvailable = false; rec.dto.workflowState = rec.options.workflowState; this.emitAgent(rec); await this.persist();`
   - `void this.recordAudit(actor, "fork", id, "ok", `→ ${newId} @ seq ${chosen.seq}`);`

**applyCommand wiring**
4. In the `switch (cmd.type)` block (concern 02 already adds the `default:` case here — coordinate/rebase against that), add `case "fork": { await this.fork(cmd.id, {seq: cmd.seq}, actor); break; }` inside the existing `const rec = this.agents.get(cmd.id); if (!rec) return;` guard block (fork needs `rec` to exist, matching the other per-agent cases).

**server.ts**
5. Add a new route before the final `return new Response("not found", {status: 404})` in the request handler (near the other `GET /api/...` routes): `if (url.pathname.match(/^\/api\/agents\/[^/]+\/checkpoints$/) && req.method === "GET") { const id = url.pathname.split("/")[3]!; const rec = manager.getAgentRecord?.(id) ?? undefined; /* or however server.ts accesses manager state — grep for an existing per-agent GET route (e.g. /api/agents/:id) and mirror its access pattern */ const runId = rec?.options.workflowState?.runId; if (!runId) return Response.json([]); const entries = await readCheckpoints(manager.stateDirPublic ?? /* whatever accessor exists */, runId); return Response.json(entries.map(e => ({seq: e.seq, at: e.at, currentNode: e.currentNode, outcome: e.outcome}))); }` — the exact accessor for `manager`'s roster/stateDir depends on server.ts's existing per-agent route pattern; grep `url.pathname` handling for an existing `/api/agents/` GET route in server.ts and mirror its manager-access idiom exactly (do not add a new public field to SquadManager if an existing method/getter already exposes what's needed — check for a `getAgent`/`list()` method first). CRITICAL: never include `vars` in the response (the design explicitly says "never vars" — the mapped shape above already omits it).

## Cross-Repo Side Effects
None — single-repo plan.

## Verify
PATH="$PWD/node_modules/.bin:$PATH" bun test src/squad-manager.test.ts src/server.test.ts (confirm exact test filenames via `find src -maxdepth 1 -name '*.test.ts'` first). Required cases: (a) forking a terminal (escalate-exhausted) run resets every fix-up-tier visit count to 0 while carrying forward all non-tier visit counts, and the fork's `resumeAttempts` is 0; (b) fork refuses when `rec.dto.status==="working"`; (c) fork refuses a second time for the same source runId while a live fork exists; (d) fork against a worktree that no longer exists on disk throws a clear error instead of defaulting to repo HEAD; (e) fork with a `seq` pointing at a currentNode absent from a re-parsed (edited) graph throws a clear validation error; (f) `GET /api/agents/:id/checkpoints` never includes a `vars` key in any returned entry; (g) the forked agent's id, branch name, and worktree path are all derived from the SAME `newId` (spawn-identity invariant preserved).

## Resolution
Shipped in ee19c6b (+ 4db83ff TOCTOU double-fork guard + supersededBy self-heal; audit fix 0b85a99: rollback when the fork fails to start, fork→source priorId lineage stitching). Fork validates checkpoint vs parsed graph, resets goalGate retryTarget/overflow visit budgets, inherits the issue per DESIGN RT1#13.
