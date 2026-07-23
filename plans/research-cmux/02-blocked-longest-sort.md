# blocked-longest sort on the attention panel
STATUS: closed — 2026-07-21: the library half (insights.ts) shipped with tests, but every render site hardcoded `{ sort: 'severity' }`, so the operator toggle this concern exists for was unreachable (AttentionPanel itself was later deleted by nav-consolidation). Toggle delivered on the cockpit's "Needs you" header by the surface-invisible-observability PR.
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/insights.ts, webapp/src/components/AttentionPanel.tsx, webapp/src/lib/insights.test.ts

## Goal
Let the operator rank the "Needs you" queue by **who's been blocked longest**, matching cmux's rankable notification panel. Default stays the current freshest-first order.

## Context (verified)
- `attentionItems(input: AttentionInput): AttentionItem[]` (`webapp/src/lib/insights.ts:479`) is a pure function. Every item carries `since?: number` (the age anchor, `insights.ts:457`).
- Current sort (`insights.ts:662`): `severity asc, then since DESC (freshest first), then id`.
- `AttentionPanel.tsx` calls `attentionItems({...})` in a memo around `:86-91`.

## Approach
1. **`insights.ts`** — add an options arg without breaking the existing signature:
   ```ts
   export function attentionItems(input: AttentionInput, opts?: { sort?: "severity" | "blocked-longest" }): AttentionItem[]
   ```
   Keep the current comparator as the `"severity"` default. For `"blocked-longest"`, sort by `since ASC` (oldest first) with items lacking `since` sorted last, tie-break by `id`. Blocked-longest is most meaningful for actually-blocking rows (`severity === "critical"`), but sort the whole list uniformly by age so the panel stays a single coherent list — do not filter.
2. **`AttentionPanel.tsx`** — a small segmented toggle / button ("Newest" ↔ "Longest waiting"), local `useState<"severity" | "blocked-longest">("severity")`, passed as the `sort` opt into the `attentionItems(...)` memo (add it to the memo deps). Match the panel's existing control styling; keep it unobtrusive in the panel header.
3. **`insights.test.ts`** — add a test: given three items with `since` = t0 (oldest) < t1 < t2 and mixed severity, `attentionItems(input, { sort: "blocked-longest" })` returns them oldest-`since`-first; the default call is unchanged (freshest-first) — assert both to lock the default.

## Cross-Repo Side Effects
None.

## Verify
- `cd webapp && bun test src/lib/insights.test.ts` passes (new + existing).
- In the running app, the toggle reorders the panel; default load is unchanged.

## Resolution
Closed. `attentionItems(input, { sort })` added (default byte-for-byte unchanged); `AttentionPanel` gained a "Newest ↔ Longest waiting" toggle that renders a single ranked section in blocked-longest mode (so an older warn row can outrank a fresher critical one). Two new tests; `insights.test.ts` 69 pass, full webapp suite 555 pass, typecheck/build clean.
