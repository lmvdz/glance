# Data-driven deny/ask at the tool-call seam
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/agent-guard.ts, src/server.ts, src/runtime-settings.ts

## Goal
An operator adds a deny/ask rule at runtime and a live fleet tightens on the next tool call. The #2 headline.

## Approach
- `src/agent-guard.ts` `screenToolCall`: AFTER the hardcoded `FORBIDDEN_COMMANDS`/protected checks (which ALWAYS run), consult `evalPolicy` over rules loaded from `policy.json` (path via `protectedStateRoots(home)`), behind a cheap **mtime cache** so a hot tool loop doesn't stat-storm. A `deny` → `{block, reason}`; tool-call `ask` → `{block, reason:"requires operator approval — not permitted unattended"}` (ASK degrades to DENY here — no cross-harness mid-tool human round-trip for omp/pi). Gated by `OMP_SQUAD_POLICY_RULES` (new FeatureFlagKey, defaultEnabled:false).
- `src/server.ts`: `POST /api/policy/rules` (+ GET, DELETE) cloning the `/api/settings/feature-flags` pattern (admin-gated, Schema-decoded body, PolicyStore.setRules → fresh doc). Add the Schema to `schema/http-body.ts`.
- `src/runtime-settings.ts`: add `OMP_SQUAD_POLICY_RULES` to `FeatureFlagKey` + `FEATURE_FLAGS` (defaultEnabled:false).

## Verify
`bun test`: an added deny rule blocks a matching tool call; ask rule blocks with the soft reason; flag off → today's behavior; the hardcoded FORBIDDEN_COMMANDS still fire regardless. Live-drive: POST a rule, observe a live agent's next matching tool call blocked.
