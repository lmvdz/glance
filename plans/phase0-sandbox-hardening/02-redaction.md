# Redaction — harden redact.ts and apply it to the gate-output persistence path
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/redact.ts, src/proof.ts, src/gate-logs.ts, tests/redact.test.ts
MODE: afk

## Goal
Agent-authored gate/test output that echoes a secret does not land verbatim in a persisted, world-readable
record.

## Approach
Two gaps:
1. **Gate output bypasses redaction entirely.** `proof.ts:265+` captures gate stdout/stderr raw and persists the
   tail into the `Proof` record; `gate-logs.ts:46` `writeGateLog` writes the full raw diff+suite output. `redact()`
   exists and already guards transition causes (`squad-manager.ts:510`) but is not on either path. Route both
   through `redact()` at write time (matching the existing redact-at-write decision).
2. **`redact.ts` misses the highest-value secret in this system.** Its 7 shape patterns + env-line name rule
   (`redact.ts:16-27`) do **not** catch `DATABASE_URL` values (a `postgres://user:pass@host` connection string is
   not name-shaped like `*_SECRET`, and the URL body matches no listed shape). Add a connection-string pattern
   (`\w+://[^:@/]+:[^@/]+@`) and extend the env-line rule to catch a bare `DATABASE_URL=` prefix. Keep it targeted
   — a general high-entropy scanner is explicitly out of scope (redact.ts's own comment scopes it out).

## Cross-Repo Side Effects
None.

## Verify
- New `redact.test.ts` cases: a `DATABASE_URL=postgres://u:p@h/db` line and a bare connection string both redact;
  a benign URL without credentials does not.
- A gate run whose command does `printenv` / `cat` a secret-shaped value produces a persisted proof and gate-log
  with the value redacted (drive it, don't assume).
- Mutation proof: remove the `redact()` call on the gate-log path → a test asserting the redacted marker in the
  persisted log goes red.
