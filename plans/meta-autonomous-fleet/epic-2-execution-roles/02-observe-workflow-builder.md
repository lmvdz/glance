# buildObserveWorkflow — reproduce/report graph

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/workflow/verify-workflow.ts, tests/workflow.test.ts

## Goal (what is built)

A new pure builder `buildObserveWorkflow(spec: VerifySpec): Workflow` that synthesizes a
reproduce-then-report graph for an observing agent: run the reproduce command (the acceptance
gate for the suspected regression); if it FAILS (regression reproduces), an agent node narrows it
to a cause and writes a findings report, then exit; if it PASSES (could not reproduce — flaky),
exit immediately. Sibling to the existing `buildVerifyWorkflow`/`buildTddVerifyWorkflow`, same
file, same pure-graph style (no DOT round-trip). No wiring — leaf 03/05 select and dispatch it.

## Approach (how — cite real file:symbol attach points)

Add to **src/workflow/verify-workflow.ts** alongside `buildVerifyWorkflow` (verify-workflow.ts:37)
and `buildTddVerifyWorkflow` (verify-workflow.ts:73). Mirror their exact node/edge construction
idiom (a `Map<string, WorkflowNode>` + an `edges` array; nodes carry `attrs:{}`; see the
`WorkflowNode` shape in src/workflow/types.ts:28).

Graph (note: the observer's job is to REPRODUCE, so the command "succeeding" here means the
regression reproduced — invert the usual pass/exit semantics via the edge conditions):
```
start → reproduce ─(command fails ⇒ regression reproduced)→ report → exit
                  └(command passes ⇒ could not reproduce)──────────→ exit
```
- `reproduce`: `kind:"command"`, `script: spec.command`. Do NOT set `goalGate:true` — a
  non-reproducing (green) gate is a valid, non-failing outcome for an observer (unlike verify,
  where green is the goal). Leave `goalGate` unset so the run never hard-fails on a green gate.
- `report`: `kind:"agent"` with a new `OBSERVE_REPORT_PROMPT` const (define next to the existing
  `WRITE_TEST_PROMPT` at verify-workflow.ts:32). Prompt substance: "The reproduce command FAILED —
  the regression is real. Do NOT fix it. Narrow it to the smallest failing case, identify the
  likely cause (recent commit / file / symbol), and write a concise findings report. Stop when the
  report is written." `maxVisits: 1`.
- Edges: `start→reproduce`; `reproduce→report` with `condition:"outcome=failed"` (regression
  reproduced); `reproduce→exit` labelled "Not reproduced" (the default/pass edge, no condition or
  `condition:"outcome=succeeded"`); `report→exit`. Match how `buildVerifyWorkflow` orders its
  pass/fail edges (verify-workflow.ts:53–54: the conditioned edge first, then the fallthrough).
- Return `{ name: "observe", nodes, edges, start: "start", exit: "exit" }`.

Export it. Do not change the two existing builders.

## Scope boundary

- Do NOT add a fixup/codefix/escalate cascade — an observer reproduces and reports, it does not
  repair. No `CODEFIX_CMD` node.
- Do NOT wire it into `makeDriver`, `routeIntake`, or the Observer here — builder + test only.
- Do NOT change `VerifySpec` (that is leaf 03).

## Verify (concrete command + expected observable outcome)

- `bun run check` passes.
- Add a test to **tests/workflow.test.ts** mirroring the existing `buildTddVerifyWorkflow` test
  (tests/workflow.test.ts:408–428). Import `buildObserveWorkflow` (the import is at
  tests/workflow.test.ts:23). Assert:
  - `wf.nodes.get("reproduce")?.kind === "command"` and its `script` equals the spec command;
  - `wf.nodes.get("reproduce")?.goalGate` is falsy (a green gate is not a run failure);
  - `wf.nodes.get("report")?.kind === "agent"` and its prompt matches `/reproduc|report/i` and
    does NOT instruct a fix (e.g. `expect(prompt).not.toMatch(/\bfix\b/i)` modulo "do not fix");
  - the edge list contains `reproduce->report` gated on `outcome=failed` and both `reproduce->exit`
    and `report->exit`.
- `bun test workflow` is green.
