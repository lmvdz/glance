# Model-outcome ledger + reader

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/model-outcomes.ts (new), src/squad-manager.ts, tests/model-outcomes.test.ts

## Goal

Persist landed-vs-rejected counts per `(model, complexity-tier)` from the fleet's own land outcomes,
and expose a pure reader `modelOutcomes(stateDir, model, tier) → { landed, rejected }`. This is the
data layer concern 07 (outcome-driven model default) consumes. It never gates a land; it only records a
statistic already produced at land time.

## Approach

**New `src/model-outcomes.ts` — mirror `src/land-ledger.ts` exactly (do NOT invent a new persistence
pattern):**
- One JSON file `model-outcomes.json` under `stateDir`; sync read-modify-write (the manager is
  single-writer, single event loop — copy `readLandLedger`/`writeLandLedger` structure verbatim,
  including the corrupt/missing ⇒ `{}` and best-effort-write-swallows-error discipline at
  `src/land-ledger.ts:34` and `:45`).
- Shape: `type ModelOutcomes = Record<string, { landed: number; rejected: number }>`, keyed by
  `` `${model}::${tier}` ``.
- Export three helpers (concern 07 reuses the first two so record/read agree on bucketing):
  - `tierOf(thinking?: ThinkingLevel): "light" | "mid" | "heavy"` — `minimal|low → "light"`,
    `medium → "mid"`, `high|xhigh → "heavy"`, `undefined → "mid"`. (`ThinkingLevel` is in
    `src/types.ts`.)
  - `modelKey(model?: string): string` — `model ?? "default"`.
  - `recordModelOutcome(stateDir, model, tier, landed: boolean, now?)` — read-modify-write, `landed`
    bumps `.landed` else `.rejected`; returns the updated entry. No-op-safe on undefined model
    (`modelKey` folds it to `"default"`).
  - `modelOutcomes(stateDir, model, tier): { landed: number; rejected: number }` — read-only, returns
    `{ landed: 0, rejected: 0 }` for an unseen key.

**Record at the existing land site (`src/squad-manager.ts`, land()):**
- The land failure-streak is recorded at `~:2190` under
  `if (!result.retryable && (auto || result.ok)) recordLandOutcome(this.stateDir, dto.branch, result.ok, ...)`.
- Append, under the *same* guard and using the *same* `rec`/`dto` already in scope:
  `recordModelOutcome(this.stateDir, dto.model, tierOf(rec.options.thinking), result.ok);`
  (`rec.dto.model` is the run's model; `rec.options.thinking` is its `CreateAgentOptions.thinking`.)
- Emit a metric via concern 01's helper so the ledger's growth is attributable (tag
  `{ flag: "model-outcomes", variant: learningFlags().modelOutcomes ? "on" : "off" }`). If concern 01's
  metric helper is not merged yet, guard the call so this concern still lands independently.

Recording is **always-on** (a cheap statistic, like `land-ledger`); the *consumer* gating lives in
concern 07. Do NOT read this ledger anywhere in this concern — the reader is exported for 07 to use.

## Scope boundary

- Do NOT touch `proofGate`, `landBranch`, or any land *decision* — this is record-only, after the land
  result is known.
- Do NOT add a `setInterval`/`start()` sibling loop — recording is event-driven at land (see DESIGN.md).
- Do NOT modify `src/land-ledger.ts` (the branch-keyed failure streak stays as-is; this is a parallel,
  additive ledger).
- Do NOT wire any consumer of `modelOutcomes()` here.

## Verify

- `bun test tests/model-outcomes.test.ts` — `tierOf` buckets all five `ThinkingLevel`s + undefined
  correctly; `recordModelOutcome` bumps landed vs rejected and folds undefined model to `"default"`;
  `modelOutcomes` returns `{landed:0,rejected:0}` for an unseen key; a corrupt `model-outcomes.json`
  reads as empty (never throws); a write failure is swallowed (best-effort).
- `bun run check`
- Manual: run a verify-workflow to a landed merge, then to a rejected land; confirm
  `model-outcomes.json` under the state dir gains `landed`/`rejected` bumps on the run's
  `<model>::<tier>` key.
