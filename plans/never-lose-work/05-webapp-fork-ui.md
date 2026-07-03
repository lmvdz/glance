# Webapp: Fork-from-step-N control in TaskDetail
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/dto.ts, webapp/src/lib/agent-control.ts, webapp/src/components/TaskDetail.tsx

## Goal
Mirror the daemon's ClientCommand fork type and forkAvailable DTO field into the webapp, add a forkCommand() + checkpoints-fetch helper, and render a 'Fork from step N' control beside Restart in TaskDetail — default latest checkpoint, earlier steps labeled 'routing state only — code stays at the branch tip' — gated on dto.forkAvailable so an old daemon (which never sets the field) never shows the button.

## Approach
1. `webapp/src/lib/dto.ts` (current `ClientCommand` mirror around line 344): add `| { type: "fork"; id: string; seq?: number }` to the union; add `forkAvailable?: boolean;` and `workflowState?: {runId?: string; terminal?: {reason: string; forkPoint?: {seq: number}}}` (or reuse whatever existing `workflowState` shape dto.ts already mirrors — grep first, likely already present given `rec.dto.workflowState` is referenced elsewhere in the daemon) to the `AgentDTO`-mirroring interface.
2. `webapp/src/lib/agent-control.ts` (mirror the existing `restartCommand` at line ~42): add `export function forkCommand(agentId: string, seq?: number): ClientCommand { return {type: "fork", id: agentId, seq}; }`. Add a fetch helper `export async function fetchCheckpoints(agentId: string): Promise<{seq:number; at:number; currentNode:string; outcome?:string}[]> { const r = await fetch(`/api/agents/${agentId}/checkpoints`); if (!r.ok) return []; return r.json(); }` — mirror whatever base-URL/fetch convention the rest of `webapp/src/lib` already uses for REST calls (grep for an existing `fetch(` call in `webapp/src/lib` to match the pattern, e.g. relative path vs. an env-configured API base).
3. `webapp/src/components/TaskDetail.tsx`: near the existing `restartTargets`/`handleRestartAgents` (lines ~399, ~475-477) and the Restart button JSX (line ~1169-1172), add a `forkTargets = React.useMemo(() => activeAgents.filter(a => a.forkAvailable), [activeAgents])`. Render a "⑂ Fork" button beside Restart, visible only when `forkTargets.length > 0`. On click, fetch checkpoints via `fetchCheckpoints(forkTargets[0].id)`, render a small picker (dropdown or inline list) showing each entry as `Step {seq} — {currentNode}` with the LATEST entry pre-selected and labeled "latest", and every earlier entry annotated with the exact string "routing state only — code stays at the branch tip" (per the design's Candidate-A semantics — no code rewind this slice). Confirming the picker sends `sendConsoleCommand(forkCommand(agentId, selectedSeq))` (mirror the existing `sendConsoleCommand(restartCommand(agentId))` call pattern at line ~476) and shows a toast (mirror `showToast(...)` calls already present, e.g. line 477's pattern) — success message e.g. `Forking ${agent.name} from step ${selectedSeq}…`.
4. If TaskDetail has more than one place rendering agent-level action buttons (it appears to, given lines ~1169-1172 AND ~1404-1405 both render a Restart button in different list contexts), mirror the Fork button into both locations for consistency, gated the same way on `agent.forkAvailable`.

## Cross-Repo Side Effects
None — single-repo plan.

## Verify
PATH="$PWD/node_modules/.bin:$PATH" bun test webapp/src/components/TaskDetail.test.tsx webapp/src/lib/agent-control.test.ts (confirm exact test filenames first via `find webapp/src -name '*.test.ts*'`). Required cases: (a) `forkCommand('a1', 3)` returns `{type:'fork', id:'a1', seq:3}`; (b) TaskDetail does NOT render the Fork button for an agent with `forkAvailable` undefined/false; (c) TaskDetail renders the Fork button for an agent with `forkAvailable: true`, and clicking it + selecting an earlier checkpoint sends a `fork` command with that checkpoint's `seq` and shows the 'routing state only' label for non-latest entries.
