# Operator-declared requires/produces (UI + spawn path)

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components (spawn/agent-create form), src/web (spawn API handler), src/types.ts
PLANE: OMPSQ-348 — https://app.plane.so/inkwell-finance/browse/OMPSQ-348/

## Goal
Let an operator declare `requires`/`produces` explicitly when launching an agent, marked
`scopeSource:"operator"`. This is what makes the enforced paths in concerns 08 (hard
block on conflict) and 09 (hard defer) actually fire reliably — the autonomous LLM path
is advisory-only by design (red team A-S5), so without an operator entry point the
"enforced" branch would rarely execute.

## Approach
1. **Spawn form fields.** In the webapp agent-create UI (the panel that already collects
   the task/repo and surfaces `owns`), add optional `requires` and `produces` inputs
   (comma/newline-separated path prefixes), with helper text mirroring `owns`. When the
   operator fills them, send them on the create request and tag `scopeSource:"operator"`.

2. **Spawn API handler** (`src/web` create-agent route): accept `requires`/`produces`/
   `scopeSource` on the request body and thread them into `CreateAgentOptions` (concern
   07). When absent, leave `scopeSource` unset/`"inferred"` so smart-spawn's values (if
   any) flow through as advisory.

3. **Show the contract on the agent card / TaskDetail.** Render an agent's declared
   `requires`/`produces` (with an operator/inferred badge) so the contract is visible
   where conflicts and scope findings (concern 08) also surface. Read-only display reuse
   of the data already on the DTO.

## Cross-Repo Side Effects
Depends on concern 07 (types) and benefits concerns 08/09 (gives them operator-declared
contracts to enforce). Touches `src/types.ts` only if the create-request type needs the
fields — coordinate with 07 (land after 07).

## Verify
- `bun run typecheck` (webapp + src) clean.
- Launch an agent via the UI with explicit `produces:["src/x"]` and
  `requires:["src/y"]` → DTO shows `scopeSource:"operator"`; the values display on the
  agent card.
- With an operator-declared `requires` that conflicts with a live agent → spawn is
  blocked (concern 08's enforced path), confirming end-to-end enforcement.
