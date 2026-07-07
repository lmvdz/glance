# Lineage normalizer
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/model-lineage.ts, src/omp-graph/attribution.ts, src/model-lineage.test.ts

## Goal
A pure function `modelLineage(model?: string): ModelLineage` that collapses any model reference — a provider-prefixed spec (`anthropic/claude-sonnet-4-5`), a bare family (`sonnet`, `gpt-5.2`, `gemini-2.5-pro`), or `undefined` — into a vendor lineage bucket, reusing `attribution.ts`'s existing `modelFamily()` so the two heuristics can't drift.

```ts
export type ModelLineage = "anthropic" | "openai" | "google" | "fable" | "unknown";
```

## Approach
- New `src/model-lineage.ts`.
- **Provider-prefix fast path:** if the string contains `/`, take the segment before the first `/` and map the provider token directly (`anthropic→anthropic`, `openai→openai`, `google|google-vertex|gemini→google`, and pass unknown providers to the family fallback rather than trusting a raw token).
- **Family fallback:** call `modelFamily(model)` (export it from `src/omp-graph/attribution.ts` if not already exported) and map `opus|sonnet|haiku → anthropic`, `openai → openai`, `gemini → google`, `fable → fable`, `other|unknown → unknown`.
- `undefined`/empty/unmatched → `"unknown"`. **Never throws.**
- Add a one-line cross-reference comment in BOTH `model-lineage.ts` and `attribution.ts` noting they must stay in sync, and that lineage is the coarser (vendor) grain of family.
- Optional helper `harnessLineage(harness?: string): ModelLineage` for the vendor-pinned harnesses ONLY: `gemini→google`, `claude-code→anthropic`, `codex→openai`; everything else (`omp`/`pi`/`opencode`/`auggie`/unknown) → `"unknown"` (multi-model runtimes don't imply a vendor). Used by concern 03 as the fallback when a model string is absent.

## Verify
`bun test src/model-lineage.test.ts` — cover: prefixed anthropic/openai/google; bare `sonnet`/`opus`/`fable`/`gpt-5.2`/`gemini-2.5-pro`; `undefined` → unknown; junk → unknown; a test asserting every value `modelFamily` can return maps to a defined lineage (drift guard); `harnessLineage` for gemini/claude-code/codex vs omp/pi.
