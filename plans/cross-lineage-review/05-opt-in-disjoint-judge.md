# Opt-in disjoint (cross-vendor) judge
STATUS: blocked
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: src/validator.ts, src/config.ts, src/validator.codex.test.ts

## Goal
A genuinely different-vendor judge (OpenAI via the `codex` CLI) that can grade an Anthropic-authored diff — off by default, safe on the land critical path, and trusted only after a live-verify test proves it emits parseable verdicts. This is the "medicine" for concept #1: an actual disjoint reviewer, not just a label.

## Approach
- Gate: `OMP_SQUAD_VALIDATOR_HARNESS` env (unset/`omp` ⇒ today's omp judge). When `=codex`, `defaultJudge()` returns a `codexJudge()` instead.
- `codexJudge()` is a DISTINCT `Judge` — NOT a reuse of `ompOneShot`'s omp flags:
  - Its own bin (`codex`) + args (`codex exec` non-interactive; `-s read-only`; feed the same criteria+diff prompt asking for the SAME `{"perCriterion":[...],"confidence":...}` schema on stdout).
  - Its own **stream-tolerant parser**: `codex exec` may emit a JSONL event stream, not one clean JSON object. Parse line-by-line, find the last line that parses as an object with a `perCriterion` array (mirror the tolerance in `src/ingest/codex.ts`), else `undefined`. Do NOT reuse `extractJsonObject`'s first-`{`-to-last-`}` slice — it throws on multi-object streams.
  - Its own timeout (`OMP_SQUAD_VALIDATOR_CODEX_TIMEOUT_MS`, e.g. 90_000). **On timeout or `Bun.which("codex")` miss, DEGRADE to the omp judge (logged), not a silent abstain** — a disjoint judge that can't run must not become an every-land abstain that fakes cross-vendor review.
  - Never throws (Judge contract).
- Stays ADVISORY: a disjoint-only outcome does not change the fail-closed veto semantics beyond what the omp judge already produces in v1 — the codex judge simply *is* the reviewer when enabled, and its lineage is stamped by concern 02's logic (reviewer `codex`/openai vs anthropic author → `sameLineage: false`).

## Cross-Repo Side Effects
None. Enabling it changes which binary the judge shells.

## Verify
- Unit (`src/validator.codex.test.ts`): fake spawn returning a codex JSONL stream → parser extracts the verdict; malformed/empty stream → `undefined` (→ abstain per contract, or degrade if the whole call failed); `Bun.which("codex")` miss → degrades to omp judge (assert the omp path ran).
- **Live-verify (the enable-gate — this is the acceptance test):** with `OMP_SQUAD_VALIDATOR_HARNESS=codex` and codex installed+authed, run the judge against ≥5 real diffs and assert each returns a parseable, non-abstain verdict. Only once this is green may 05 be enabled by default anywhere. If this env cannot run codex, 05 ships OFF and this step is documented as the gate to flip it on — do NOT enable on the strength of unit tests alone.
