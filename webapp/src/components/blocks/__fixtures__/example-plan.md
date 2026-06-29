# Rich squad status panel
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/SquadStatusPanel.tsx, src/events.ts, tests/squad-status-panel.test.ts

## Goal

Replace the flat squad status list with a reviewable control surface that shows agent state, recent events, and blocked land gates without requiring an operator to tail logs.

```callout tone=decision id=source-of-truth
The event journal remains the source of truth. The panel renders a derived view and never invents agent state locally.
```

## Operator surface

```wireframe surface=browser id=status-panel
<section class="wf-stack" style="gap: 16px; padding: 16px;">
  <header class="wf-row" style="justify-content: space-between; align-items: center;">
    <div>
      <p class="wf-muted">omp-squad</p>
      <h2>Implementation fleet</h2>
    </div>
    <span class="wf-pill">3 active agents</span>
  </header>
  <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 16px;">
    <article class="wf-card wf-stack" style="gap: 12px; padding: 14px;">
      <h3>AuthoringSpec</h3>
      <p class="wf-muted">Writing docs/plan-blocks.md</p>
      <div class="wf-row" style="gap: 8px;"><span class="wf-pill">running</span><span class="wf-pill">docs only</span></div>
    </article>
    <aside class="wf-card wf-stack" style="gap: 10px; padding: 14px;">
      <h3>Land gate</h3>
      <p><span data-icon="shield"></span> Waiting for focused verification.</p>
      <button class="primary">Open details</button>
    </aside>
  </div>
</section>
```

## Data flow

```diagram id=status-data-flow
<div class="diagram-panel wf-stack" style="gap: 12px;">
  <div class="diagram-card">Agent process writes structured event</div>
  <div class="diagram-node">src/events.ts</div>
  <div class="diagram-card">Server streams compact DTO</div>
  <div class="diagram-node">SWR cache</div>
  <div class="diagram-card">SquadStatusPanel renders derived state</div>
</div>
```

## Expected file impact

```filetree id=touched-files
webapp/src/components/SquadStatusPanel.tsx +added
src/events.ts ~modified
tests/squad-status-panel.test.ts +added
```

## Open questions

```questions id=status-panel-decisions
- id: stale-threshold
  type: single
  prompt: When should an active agent be marked stale in the UI?
  options: [30s, 60s, 120s]
  recommended: 60s
- id: event-types
  type: multi
  prompt: Which event types should appear in the first release?
  options: [spawned, tool-call, verification, land-gate, completed]
  recommended: [spawned, verification, land-gate, completed]
- id: operator-copy
  type: freeform
  prompt: What short label should explain a blocked land gate?
```

## Server contract sketch

```annotated lang=ts id=status-dto
// @note 1-5 Keep the DTO boring: it is a projection of events, not a second state machine.
export interface SquadAgentStatus {
  id: string;
  state: "queued" | "running" | "blocked" | "done";
  lastEventAt: string;
  blockedReason?: string;
}

// @note 8 A missing heartbeat is displayed as stale by the client; the server still reports the last known event.
export interface SquadStatusResponse {
  agents: SquadAgentStatus[];
}
```

## Before and after

```columns id=operator-before-after
Before

- Operators inspect raw logs to know which agent is blocked.
- Land gate failures are easy to miss.
- The web UI cannot explain whether the fleet is idle or stuck.
---
After

- The panel shows each agent's derived state.
- Land gate failures are visible beside the agent.
- The stale threshold is explicit and reviewable.
```

## Acceptance

- The panel renders from server-provided status DTOs only.
- Stale display is deterministic in tests.
- Existing event writes remain append-only.
