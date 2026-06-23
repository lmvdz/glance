# Characterization tests for the LLM-decision coercers

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: tests/llm-coerce.test.ts (new), src/smart-spawn.ts, src/land.ts

## Goal

Pin the *current* behavior of the fleet's highest-risk LLM-output coercers — the ones feeding the **auto-approval** and **auto-land** gates — with offline, deterministic tests, BEFORE the `decideTyped` refactor (02) touches them. This is the parity gate for 02 and the ponytail "one runnable check" on code whose silent drift can wreck main. The draft assumption that these had "no tests" was wrong — most paths are covered; this concern fills the **uncovered, drift-prone gaps** the red team found (RedTeam 2A/1A/1C/1F/1E).

Do NOT change any behavior here. The only `src/` edits are behavior-preserving exposures so the pure logic is testable.

## Approach

### Enabling exposures (behavior-preserving — no logic change)
1. `src/smart-spawn.ts`: add `export` to `asApproval` (smart-spawn.ts:81) and `asThinking` (smart-spawn.ts:85). They are pure; currently module-private so untestable directly.
2. `src/land.ts`: extract the reviewer predicate at land.ts:288-290 into an exported pure function and call it from `defaultReviewer`:
   ```ts
   /** True iff the model's free-text review approves: contains APPROVE and NOT REJECT (case-insensitive). */
   export function parseApproval(raw: string): boolean {
     const out = raw.toUpperCase();
     return /\bAPPROVE\b/.test(out) && !/\bREJECT\b/.test(out);
   }
   ```
   `defaultReviewer` then does `return parseApproval(await new Response(proc.stdout).text());`. `defaultReviewer` itself stays I/O-bound (spawns omp) and is not unit-tested; the *predicate* is.

### Tests — `tests/llm-coerce.test.ts` (`bun:test`, no network, no model calls)
Generate every `expected` by reasoning about the CURRENT code (or by importing and running the function), never from docstrings (the intake "last balanced JSON object" docstring is stale — it's outermost like the others; RedTeam 1H).

- **`snapToOption` two-phase ordering** (via the exported `parseDecision`, supervisor.ts:108 — `select` kind): exact-over-ALL-options runs before substring.
  - `parseDecision('{"value":"abort"}', {kind:"select", options:["bort","abort"], ...})` → `"abort"` (exact wins; a single-pass `find(exact||substring)` would wrongly return `"bort"` since `"abort".includes("bort")`).
  - `parseDecision('{"value":"bort"}', {kind:"select", options:["bort","abort"], ...})` → `"bort"`.
  - out-of-options invariant: `parseDecision('{"value":"zzz"}', {kind:"select", options:["Approve","Deny"]})` → `chooseFallback` = the `APPROVE_RE` match `"Approve"`.
- **`asApproval`/`asThinking` exact, case-sensitive** (RedTeam 1C — the security-relevant one):
  - `asApproval("ask")` → `undefined` (MUST NOT snap to `"always-ask"`).
  - `asApproval("always-ask")` → `"always-ask"`; `asApproval("YOLO")` → `undefined` (case-sensitive); `asApproval("yolo")` → `"yolo"`.
  - `asThinking("hi")` → `undefined`; `asThinking("high")` → `"high"`.
- **`parsePlanJson` owns trim/drop-empty** (smart-spawn.ts:108, exported; RedTeam 1E):
  - input `'{"repo":" /x ","owns":[" src/web ","","\t","a"]}'` → `repo:"/x"`, `owns:["src/web","a"]` (trimmed, empties dropped). Non-array `owns` → `undefined`.
- **`parseApproval` (land, extracted)** (RedTeam 1A — zero coverage today):
  - `parseApproval("APPROVE")` → `true`; `parseApproval("approve")` → `true`; `parseApproval("looks fine")` → `false` (no token); `parseApproval("APPROVE the safe parts but REJECT the migration")` → `false` (negative guard); `parseApproval('{"verdict":"approve"}')` → `true` (substring word-search, documents that JSON is NOT required here — the very reason land is excluded from 02).
- **bool/string verbatim** (supervisor): `parseDecision('{"value":"YES"}', {kind:"confirm"})` → `"yes"`; `parseDecision('{"value":" keep  spaces "}', {kind:"input"})` → `" keep  spaces "` (NOT trimmed — RedTeam 1G).

Keep all existing `tests/supervisor.test.ts`, `tests/smart-spawn.test.ts`, `tests/intake.test.ts`, `tests/omp-call.test.ts` untouched and green.

## Cross-Repo Side Effects

None. Two new exports (`asApproval`/`asThinking`) and one extracted export (`parseApproval`); `defaultReviewer`'s observable behavior is unchanged.

## Verify

- `bun test tests/llm-coerce.test.ts` → green.
- `bun test tests/supervisor.test.ts tests/smart-spawn.test.ts tests/intake.test.ts tests/land.test.ts` → still green (no behavior change).
- `bun run check` → typecheck clean (new exports + extraction only).

## Resolution

CLOSED — landed in commit `bfd8eb1`. Built + self-verified by an omp-squad fleet agent (`goal1-coerce-tests`, dogfood), reviewed and integrated by the operator. Gate green on main (21/21 targeted; the agent also caught a real `\t`→`\\t` JSON-escape bug in its own fixtures during the verify loop). No runtime behavior changed.
