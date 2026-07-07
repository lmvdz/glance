# Policy store + evaluator
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/policy.ts, src/policy.test.ts, schema/http-body.ts

## Goal
The shared substrate: a durable, runtime-mutable rule table + one pure evaluator, fail-open.

## Approach
- New `src/policy.ts`: `PolicyRule` type (see DESIGN.md), `PolicyDoc={rules:PolicyRule[]}`, a `PolicyStore` cloning `RuntimeSettingsStore`'s load/save (`stateDir/policy.json`, `writeFileDurable`, Effect `Schema` decode on load, **any parse error → `{rules:[]}` fail-open**). `evalPolicy(rules, subject): {decision:"deny"|"ask", reason, ruleId} | undefined` — pure; present `when` fields AND-match, absent = wildcard; DENY wins over ASK on multi-match; no match → undefined (allow). Uncompilable rule regex → skip that rule (log), never throw.
- `subject` is a discriminated union by seam: `{seam:"tool_call", tool, command?}`, `{seam:"land", changedFiles, commitsBehind}`, `{seam:"dispatch", model, tier}`.

## Verify
`bun test src/policy.test.ts`: deny-wins-over-ask; wildcard match; regex compile failure skipped not thrown; malformed json → empty rules; round-trip save/load.
