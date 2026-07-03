# Webapp lifecycle timeline + insights rollup

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts, src/types.ts, webapp/src/lib/dto.ts, webapp/src/hooks/useSquad.ts, webapp/src/lib/insights.ts, webapp/src/lib/insights.test.ts, webapp/src/components/TaskDetail.tsx

## Goal

An operator looking at an agent in the webapp sees its recent lifecycle transitions inline (last 5 significant, excluding hot-path turn-progress noise), can pull the full history from the new endpoint, and the fleet-wide "Needs you" / hotspot surfaces (`insights.ts`) can rank agents by how often they've been erroring — computed server-side over the full ring, never under-counted by a capped client-side tail.

## Approach

### 1. `AgentDTO.transitions` tail + `errorTransitions1h` rollup (`src/squad-manager.ts`, `src/types.ts`)

Add to `AgentDTO` (`src/types.ts`, near `pending: PendingRequest[]` at line ~479):

```ts
/** Last 5 SIGNIFICANT lifecycle transitions (turn-progress excluded) — a compact inline strip.
 *  Full history via GET /api/agents/:id/transitions. Capped deliberately: this rides emitAgent's
 *  broadcast (per RPC-frame on the hot path), so it must never carry the full ring. */
transitions?: TransitionEntry[];
/** Count of error-class transitions (to:"error", reason "fail"|"catastrophe"|"exit-error") in the
 *  trailing 1h, computed over the FULL ring server-side — NOT derived from `transitions` above,
 *  which is capped and would undercount a busy/flapping agent. Feeds insights.ts hotspot ranking. */
errorTransitions1h?: number;
```

Implement `pushTransitionEvent` (the hook concern 02 left as a stub call inside `recordTransition`) in `src/squad-manager.ts`:

```ts
private pushTransitionEvent(rec: AgentRecord, entry: TransitionEntry): void {
	if (entry.reason !== "turn-progress") {
		const tail = [...(rec.dto.transitions ?? []), entry];
		rec.dto.transitions = tail.length > 5 ? tail.slice(-5) : tail;
	}
	rec.dto.errorTransitions1h = this.countErrorTransitions1h(rec.dto.id);
}

private countErrorTransitions1h(agentId: string): number {
	const cutoff = Date.now() - 3_600_000;
	return this.transitionLog.recent().filter(
		(e) => e.agentId === agentId && e.at >= cutoff && e.to === "error" && (e.reason === "fail" || e.reason === "catastrophe" || e.reason === "exit-error"),
	).length;
}
```

`countErrorTransitions1h` walks the `JsonlLog`'s in-memory ring (not the file) — cheap enough to call on every transition since it's a linear scan over ≤500 entries, and only fires on the already-low-frequency `transition()` path, never on `turn-progress`'s hot early-return. Do NOT call it from `emitAgent`'s hot path — it is set once per `pushTransitionEvent` call and rides the DTO snapshot from there.

Do not call `pushTransitionEvent`/emit an extra broadcast here beyond what `transition()` already does in concern 02 — the field lands on `rec.dto` and rides the next `emitAgent()` the calling site already performs (every status-changing call site calls `emitAgent(rec)` right after, per the concern 01 site table).

### 2. `webapp/src/lib/dto.ts` mirror (hand-maintained, easy to silently miss — do it here)

Add to `AgentDTO` (webapp/src/lib/dto.ts:165-196):

```ts
export interface TransitionEntry {
  agentId: string;
  from: AgentStatus;
  to: AgentStatus;
  reason: string; // widen from the backend's literal union — the webapp only displays it, never branches on exhaustive cases
  at: number;
  cause?: { error?: string; priorId?: string; [k: string]: unknown };
  denied?: true;
}
```

```ts
export interface AgentDTO {
  ...
  pending: PendingRequest[];
  transitions?: TransitionEntry[];
  errorTransitions1h?: number;
  lastActivity: number;
  ...
}
```

Add `"transition"` to the webapp's `SquadEvent` union mirror if one exists in `dto.ts` (check for `export type SquadEvent =` in `webapp/src/lib/dto.ts` — if the webapp mirrors the backend union verbatim, add `| { type: "transition"; entry: TransitionEntry }`; if the webapp only ever consumes `roster`/`agent`/`removed`/`transcript`/`commands` today and has no catch-all default, confirm `useSquad.ts`'s `switch` has a `default: break` (it does, line 161-162 as read) so an unhandled event type is safely ignored — wiring an explicit case is optional polish, not required for correctness, since the DTO tail already rides the `agent` event).

### 3. `TaskDetail.tsx` — lifecycle timeline strip

Add a collapsible section mirroring the existing "Live transcript panel" pattern (webapp/src/components/TaskDetail.tsx:1457-1490), placed just before it so status history reads above the live text:

```tsx
{/* Lifecycle timeline strip */}
{(agent.transitions?.length ?? 0) > 0 && (
  <div className="border-t border-gray-100 dark:border-gray-800">
    <button
      type="button"
      onClick={() => toggleTimeline(agent.id)}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900/50 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500"
    >
      <ChevronRight className={`h-3 w-3 flex-shrink-0 transition-transform ${timelineOpenIds.has(agent.id) ? 'rotate-90' : ''}`} />
      <span>Lifecycle</span>
      <span className="ml-auto rounded-full bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500 dark:text-gray-400">{agent.transitions!.length}</span>
    </button>
    {timelineOpenIds.has(agent.id) && (
      <div className="px-3 pb-3 pt-1 space-y-1">
        {agent.transitions!.slice().reverse().map((t, i) => (
          <div key={`${t.at}-${i}`} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
            <span className="font-mono text-[10px] text-gray-400">{new Date(t.at).toLocaleTimeString()}</span>
            <StatusPill status={t.from} /><span className="text-gray-300">→</span><StatusPill status={t.to} />
            <span className="text-gray-400">{t.reason}</span>
            {t.cause?.error && <span className="truncate text-red-500 dark:text-red-400">{t.cause.error}</span>}
            {t.denied && <span className="text-amber-500 text-[10px] uppercase">denied</span>}
          </div>
        ))}
        <button
          type="button"
          onClick={() => void loadFullTimeline(agent.id)}
          className="text-[10px] text-amber-600 hover:underline"
        >
          Load full history
        </button>
      </div>
    )}
  </div>
)}
```

`StatusPill` — reuse whatever small status-color badge component `TaskDetail.tsx`/`TaskListView.tsx` already renders for `agent.status` in the roster row (grep for the status-dot/badge render in `TaskListView.tsx` before inventing a new one — the codebase already has status→color mapping, do not duplicate it).

State additions alongside the existing `transcriptOpenIds` state (TaskDetail.tsx:356-357):

```tsx
const [timelineOpenIds, setTimelineOpenIds] = React.useState<Set<string>>(new Set());
const [fullTimelines, setFullTimelines] = React.useState<Map<string, TransitionEntry[]>>(new Map());
const toggleTimeline = (id: string) => setTimelineOpenIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
const loadFullTimeline = async (id: string) => {
  const full = await apiJson<TransitionEntry[]>(`/api/agents/${encodeURIComponent(id)}/transitions?full=1`);
  setFullTimelines((prev) => new Map(prev).set(id, full));
};
```

When `fullTimelines.has(agent.id)`, render that instead of `agent.transitions` in the list above (swap the `.slice().reverse()` source). Follow the existing `apiJson` import/usage pattern already in this file (grep for other `apiJson<...>` calls in `TaskDetail.tsx` for the exact import path and error-handling convention — likely wrapped in a try/catch with `showToast` on failure, matching the `handleAnswer` pattern visible at TaskDetail.tsx:1450).

### 4. `insights.ts` — flapping/error-prone ranking

Add a new export near `churnHotspots` (webapp/src/lib/insights.ts:276-307), consuming `errorTransitions1h` directly — never re-deriving a count from the capped `agent.transitions` tail (that undercounts a busy agent, the exact S4 red-team finding):

```ts
export interface FlappingAgent {
  agentId: string;
  name: string;
  errorTransitions1h: number;
}

/** Agents that have errored/caught-fire repeatedly in the last hour — a signal a capped client-side
 *  transitions tail cannot produce (it truncates at 5 entries and would undercount exactly the
 *  busiest/most error-prone agents). Server computes this over the full ring; we just rank it. */
export function flappingAgents(agents: AgentDTO[] | null | undefined, minCount = 2): FlappingAgent[] {
  return (agents ?? [])
    .filter((a) => (a.errorTransitions1h ?? 0) >= minCount)
    .map((a) => ({ agentId: a.id, name: a.name, errorTransitions1h: a.errorTransitions1h ?? 0 }))
    .sort((a, b) => b.errorTransitions1h - a.errorTransitions1h);
}
```

Wire one row into `attentionItems` (insights.ts:456+, alongside the existing `error`/`land-ready` cases in the per-agent loop, insights.ts:484-498) so a flapping agent (≥2 errors/hour) surfaces as its own `critical`-severity item distinct from the plain single-error case already there — reuse the existing `a.status === 'error'` branch's shape but only fire this NEW branch when `a.errorTransitions1h >= 2` and route it to a `kind: 'flapping'` (extend the `AttentionKind` union) so the UI can visually distinguish "errored once, needs a look" from "errored repeatedly, something is structurally wrong."

## Cross-Repo Side Effects

None. Pure webapp + DTO-mirror + one manager-side rollup addition.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test` — squad-manager tests confirming `dto.transitions` caps at 5 and excludes `turn-progress` entries; `dto.errorTransitions1h` reflects actual ring content (drive 3 fail/catastrophe transitions in under an hour, assert the count is 3, not capped at whatever the DTO tail shows).
- `cd webapp && bun test` (or the project's webapp test runner — check `webapp/package.json` scripts) — `flappingAgents()` unit test with a fabricated `AgentDTO[]` fixture; `TaskDetail` render test (mirror `TaskDetail.test.tsx`'s existing pattern) asserting the timeline strip renders when `agent.transitions` is non-empty and stays hidden when absent.
- Manual: `bun run dev` (or the project's existing `run`/dev skill) — spawn an agent, trigger an error + restart, confirm the Lifecycle strip shows `idle → error (fail)` then `error → starting (restart)`, and "Load full history" round-trips through the new endpoint.
- `bun run check` (includes webapp typecheck if wired into the root script — confirm via `package.json`).

## Dependency graph

blockedBy: 02-transition-history.md
verifyBlocker: confirm `TransitionEntry` and the `"transition"` `SquadEvent` case exist in `src/types.ts` and `SquadManager.transitionHistory()` is callable — `grep -n "transitionHistory\|interface TransitionEntry" src/squad-manager.ts src/types.ts` should return hits before starting.
