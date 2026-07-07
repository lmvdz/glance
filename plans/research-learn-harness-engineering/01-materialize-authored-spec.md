# Materialize the authored concern/Tier-2 body into the dispatched unit's context
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/fabric-search.ts

## Goal
A dispatched fleet unit receives its **authored spec** — the concern/Tier-2 issue body (acceptance
criteria, verification gate, scope boundary) — injected into its context, so it works toward the
actual contract instead of reconstructing intent from an 8-word title. Fixes the confirmed defect that
`IssueRef` carries no body and `dispatchSpawn` passes title-only.

## Approach
1. Add an optional `description?: string` (and/or `body?: string`) to `IssueRef` (src/types.ts:168).
   Populate it where issues are built from plan concerns / Plane issues — the concern body is already
   parsed (`parsePlanConcerns` in features.ts; Plane issue HTML in concern-tickets). Thread it onto the
   `IssueRef` the dispatcher already carries, so **no new synchronous Plane fetch** lands on the
   dispatch loop.
2. In `dispatchSpawn`/`createWithId` (src/squad-manager.ts ~1064 build, ~3220-3238 primer injection),
   when `issue.description` is present, append it to `appendSystemPrompt` **beside** the existing
   context primer at ~3232.
3. **Trust boundary (critical):** the body is human/skills-MCP-writable → a live prompt-injection path
   into a `yolo` agent. Sanitize before injection: HTML→text/markdown, strip scripts/markup, and wrap
   with the existing `fenceUntrusted` primitive (src/fabric-search.ts, already used for the primer at
   :252) labeled as untrusted **data, not instructions**. Do NOT inject raw HTML.
4. Fallback: absent/empty body → current title-only behavior (no regression).
5. Optional: also write `.omp/task.md` in the worktree for audit, with a one-line pointer in the
   prompt — but in-context injection is the load-bearing part (a file nothing references is a no-op).

## Cross-Repo Side Effects
None. Internal to omp-squad.

## Verify
- Unit test: an `IssueRef` with a `description` produces an `appendSystemPrompt` containing the fenced,
  sanitized body; an `IssueRef` without one reproduces title-only behavior byte-for-byte.
- Injection test: a body containing `<script>` / "ignore previous instructions" is sanitized and
  fenced as untrusted data (assert it lands inside the untrusted fence, markup stripped).
- Live: dispatch a unit from a promoted concern; confirm the agent's system prompt carries the
  acceptance criteria (drive the real dispatch path, not just the fake).

## Resolution
Shipped. `IssueRef.description` added (src/types.ts); `dispatchSpec` (src/squad-manager.ts) enriches
the dispatched issue via the cached `fetchIssueDetail` (best-effort, null-safe, `OMP_SQUAD_SPEC_MAX_CHARS`
cap 4000); `authoredSpecBlock` (src/digest.ts) fences the body as untrusted and is injected into
`appendSystemPrompt` beside the primer in `createWithId`. Injection-guard + title-only-fallback unit
tests in tests/digest.test.ts. Typecheck clean; injection rides the proven primer merge path.

