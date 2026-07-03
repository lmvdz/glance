# Tests
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: tests/plan-blocks.test.ts, tests/features.test.ts

## Goal

Lock in the parser, sanitizer, and round-trip behaviors so the block system
doesn't regress. Pure-logic tests (the established pattern — `planGraph`,
`insights`, `comments`, `features` are all unit-tested with `bun:test`).

## Approach

Use `bun:test` with the tmpdir pattern from `tests/comments.test.ts` /
`tests/features.test.ts`. Ensure `node_modules/.bin` is on PATH when running
(known gotcha: two spawn tests fail otherwise — run via the project's test script
or export PATH).

1. **`tests/plan-blocks.test.ts`** (new):
   - `parseMeta` (from `webapp/src/components/PlanBlocks.tsx`): `surface=browser id=x`
     → `{surface:'browser', id:'x'}`; quoted values; bare tokens ignored. (If
     importing a `.tsx` into bun:test is awkward, factor `parseMeta`/`hashBody`/the
     meta+body extraction into a framework-free `webapp/src/lib/planBlocks.ts` and
     import that — preferred, keeps logic testable.)
   - `sanitize` (`webapp/src/lib/sanitize.ts`): strips `<script>`, `<style>`,
     `onerror=`, and `url(...)`/`javascript:` in inline style; KEEPS
     `style="color:var(--wf-ink);display:flex;gap:8px"`, keeps `data-icon`, keeps
     safe `<svg><path/></svg>`.
   - file-tree path→tree builder (factor it out if needed): a path list builds the
     expected nested structure; empty body + touches fallback.
   - questions YAML/body parser: the documented shape parses to the expected
     question objects.
2. **`tests/features.test.ts`** (extend): `appendConcernDecision` —
   - creates a `## Decisions` section when absent and appends the bullet;
   - appends to an existing section;
   - is idempotent (no duplicate bullet on re-append);
   - the appended bullet is then picked up by `parsePlanConcerns().decisions[]`
     (round-trip: write an answer, re-parse, see it as a decision).
3. Keep tests deterministic and filesystem-isolated (tmpdir + cleanup in
   `afterEach`).

## Cross-Repo Side Effects

May motivate extracting `parseMeta`/`hashBody`/file-tree/questions parsers into
framework-free `webapp/src/lib/*.ts` modules so they're importable by `bun:test`
(do this as part of the owning concern if cleaner, or here). Prefer pure modules.

## Verify

- `bun test` (repo root, with `node_modules/.bin` on PATH) passes, including the
  new `plan-blocks.test.ts` and the extended `features.test.ts`.
- `cd webapp && bun run build` still succeeds.
- No reduction in existing passing tests.

## Resolution

Landed in 9ef3142 (2026-06-29). Verified: webapp `bun run build` + backend `tsc --noEmit` green; full suite 753 pass (1 pre-existing unrelated orchestrator failure, OMPSQ-308).
