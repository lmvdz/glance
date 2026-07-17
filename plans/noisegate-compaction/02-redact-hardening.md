# Harden redact.ts + redact at gate-log persistence
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/redact.ts, src/gate-logs.ts, tests/redact.test.ts, tests/gate-logs.test.ts
BLOCKED_BY: 01

## Goal
redact() stops corrupting legitimate code/test text and stops being O(n²), then guards the gate-log persistence boundary.

## Approach
1. `src/redact.ts` bearer pattern: `\s*` → `[^\S\n]*` (never cross newlines) AND require an actual `[:=]` or secret-shaped tail so `const authorization = req.headers.authorization;` and test names like `(fail) authorization middleware-check` survive. Measured false-positive corpus (red team): src/workos.ts:41, src/harness-hooks.ts:135, tests/voice-token.test.ts, tests/org-secret-rls.test.ts, tests/secrets.test.ts, tests/architect-harness-env.test.ts, tests/spawn-env.test.ts — all must pass unchanged.
2. Private-key pattern: bound the lazy span (`[\s\S]{0,20000}?`) to kill the measured O(n²) BEGIN-bomb (4000 markers = 307ms, extrapolates ~90s at 4MB).
3. Corpus test: run redact() over every `src/**/*.ts` + `tests/**/*.ts` file's content; assert zero changes (whitelist redact.test.ts's own fixtures). Perf regression test: BEGIN-bomb input under a generous ceiling (e.g. 1000 markers < 500ms).
4. `writeGateLog` (src/gate-logs.ts:41): persist `redact(content)`. Amend the module doc's lossless claim ("lossless except secret-shaped substrings"). Existing offload callers (validator/land/land-pr) unaffected for non-secret content.
5. tests/gate-logs.test.ts: fixture with a real secret shape (sk-…) → offloaded file redacted; fixture with `authorization`-adjacent legit code → byte-identical.

## Cross-Repo Side Effects
None. Existing transcript-path redact callers get strictly fewer false positives.

## Verify
`bun test tests/redact.test.ts tests/gate-logs.test.ts` green; corpus test proves zero-change on repo source.
