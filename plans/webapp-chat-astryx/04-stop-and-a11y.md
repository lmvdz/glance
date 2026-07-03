# Stop control in the composer + live-region a11y
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/AssistantChat.tsx, webapp/src/components/AssistantChat.test.tsx

BLOCKED_BY: 03

## Goal
Operators can stop a running agent without leaving the composer, and streaming transcripts are announced correctly by screen readers. Misleading no-op buttons are gone.

## Approach
**Stop button** — this is a *relocation of existing capability*, not new wiring: `webapp/src/lib/agent-control.ts` already exports `interruptCommand` and `interruptibleAgents`, and TaskDetail already uses them. Rules (from DESIGN.md, red-team finding):
1. Derive `isStopShown` (naming borrowed deliberately — "the stop affordance is visible", decoupled from transport state) from the active session's agent being in a running/interruptible state.
2. The send button (`AssistantChat.tsx:1377-1389`) becomes a send/stop toggle: running → square stop icon; `onStop` sends `interruptCommand(agentId)` via `sendConsoleCommand`.
3. **Debounce, never escalate**: after one press, show a disabled "stopping…" state (spinner) for a few seconds or until the agent leaves running state. A second press is a no-op. `kill` is NOT reachable from this button — it stays in TaskDetail. Rationale: interrupt already hard-kills workflow-driver agents (`abort()` = `killChild` in flue-service-driver); an impatient double-click must never destroy a run.
4. Interrupt produces no immediate server acknowledgment (no transcript marker, no status flip until the driver reports) — the pending UI state is the feedback; reset it on `status` change or timeout.

**A11y** (scroll container from concern 03):
5. `role="log"` + `aria-live="polite"` + `tabIndex={0}` on the scroll container; `aria-busy={anyEntryRunning}` derived from `transcriptEntries.some(e => e.status === 'running')` — screen readers then announce a finished message once, not per token.
6. Each rendered entry becomes/wraps an `<article aria-label={"Message from " + sender}>` (or `aria-labelledby` where a name row exists).
7. **Remove** the decorative attach + mic buttons (`AssistantChat.tsx:1369-1374`) — they have `aria-label`s promising functionality that doesn't exist. (Attach returns for real in concern 12's paste-as-chip infrastructure; mic is cut per DESIGN.md.)

## Cross-Repo Side Effects
None (uses the existing `ClientCommand.interrupt` path end-to-end).

## Verify
- Static-markup tests: running state → stop affordance present, send absent (and inverse); `role="log"`/`aria-live`/`aria-busy` attributes correct for running vs settled entry sets; attach/mic buttons absent.
- Manual: start a run, press stop → "stopping…" appears, agent halts (allow driver latency), composer returns to send; double-click does nothing extra; screen-reader spot check (announce-once behavior).
