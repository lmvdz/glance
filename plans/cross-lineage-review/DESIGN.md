# Design: Cross-lineage adversarial review for the land gate

## Outcome

Glance's land gate today is **same-lineage by construction**: the executor authors with `sonnet` and the independent validator judges with `opus` — both Anthropic. Independent in model tier and process, but not in **vendor**, so their blind spots are correlated. This ships two things:

1. **An always-on trust floor** — every validation record carries the author's and reviewer's model *lineage* (vendor family) and a `sameLineage` flag; a same-lineage review renders as a **weaker** signal in confidence scoring and the UI, exactly as an unsandboxed proof (`Proof.sandboxed:false`) already renders weaker instead of pretending all proofs are equal. This makes today's self-lineage land visible for the first time, on the modal path.
2. **A real disjoint reviewer** — an opt-in judge that grades an Anthropic-authored diff with a genuinely different vendor (OpenAI via the `codex` CLI), gated behind a flag and a live-verification acceptance test, so at least the flagship lane gets true cross-vendor review — not just a measurement of the gap.

North-star fit: the land gate is what lets work land **hands-off**. Raising its independence raises the ceiling on how much can land unattended without a human second-guessing a self-graded merge.

## Approach

**Lineage is a derived vendor bucket, not a new concept.** `src/omp-graph/attribution.ts` already has `modelFamily()` (`opus|sonnet|haiku|fable|openai|gemini|…`). A new `src/model-lineage.ts` collapses family → **vendor lineage** (`anthropic|openai|google|fable|unknown`) and adds a provider-prefix fast path, reusing `modelFamily()` as the single source of truth so the two never drift.

**Author lineage is read where it already lives.** At the land seam (`SquadManager.runValidatorGate`, `src/squad-manager.ts`) the unit record is in scope; `rec.dto.model` is backfilled by the poll loop with a vendor-prefixed string (`anthropic/claude-sonnet-4-5`). That model + `rec.dto.harness` are threaded into the validator, which computes both lineages and stamps them on the `ValidationRecord`.

**Honest unknown.** When the model is unreadable (ACP units never backfill a `Model`; pre-first-poll units hold a bare create-time string or none), lineage falls back to a **vendor-pinned harness** table (`gemini→google`, `claude-code→anthropic`, `codex→openai`) — and only that. Multi-model runtimes (`omp`/`pi`/`opencode`) whose model is unknown resolve to `unknown`, and `sameLineage` is left `undefined`. We never assert same-lineage we can't substantiate — a warning you can't back up erodes the very trust signal this feature builds.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| What "lineage" means | Vendor family (`anthropic/openai/google/fable/unknown`) | Model family (opus/sonnet/…); raw string | Correlated blind spots track the *vendor*, not the tier. Opus judging sonnet is the problem. |
| Lineage source of truth | Reuse `attribution.ts` `modelFamily()` + provider-prefix fast path | Standalone second heuristic | Two string-matchers drift; a test pins family→lineage coverage. |
| Reading the author model | `rec.dto.model` (+harness fallback) threaded from `runValidatorGate` | Persist a new field; read the receipt | The value is already on the DTO (poll backfill) and durable on the receipt. |
| Unknown author | `sameLineage: undefined`, honest; vendor-pinned-harness fallback only | Default unknown→anthropic (RT1) | omp *can* run gpt-5; assuming anthropic is a confident mislabel — the opposite of the bug we fix. |
| New record fields | `authorLineage?`, `reviewerLineage?`, `sameLineage?` (all optional) | Single `selfLineageReview: boolean` | Once the disjoint reviewer ships, `reviewerLineage` genuinely varies — the 3-field shape earns its keep. |
| Confidence effect | same-lineage `pass` → smaller bonus (+0.05 vs +0.1); veto stays −0.4; undefined → neutral | Penalize same-lineage | Bad news isn't softened by who delivers it; absence stays neutral (preserves the module contract). |
| Disjoint reviewer in v1? | **Yes, but opt-in + live-verify-gated** (`OMP_SQUAD_VALIDATOR_HARNESS=codex`, off by default) | Defer all routing (Designer); ship on-by-default (RT1) | Deferring ships the thermometer, not the medicine. On-by-default is a fail-open landmine. Opt-in + a green live-verify test is the honest middle. |
| Disjoint judge mechanism | Shell `codex exec` with its **own** args + **own** JSONL parser + **own** timeout that degrades to the omp judge | `omp --model gpt-5` (Approach B) | codex is the *demonstrably* cross-vendor route in this env (registered harness + ingester + documented CLI). omp cross-vendor routing is unverifiable from code — deferred. |

## Risks

| Risk | Severity | Resolution |
|---|---|---|
| Naive `split("/")` mislabels bare (`"sonnet"`) and ACP (`"gemini-2.5-pro"`) models | significant | `modelLineage()` is a real normalizer (prefix + family table + honest unknown), never throws — never a bare `split`. |
| CodexJudge abstains on every land (JSONL ≠ coaxed single-JSON) → fake cross-vendor signal | critical | Own stream parser; **live-verify acceptance test** (≥5 real diffs → parseable non-abstain) is the gate to enable it; off until green. |
| Disjoint judge stalls the synchronous land path (codex is slow) | significant | Own shorter timeout; timeout **degrades to the omp judge** (logged), never a silent abstain. |
| Default-unknown→anthropic mislabel | significant | Rejected — honest `unknown` + vendor-pinned-harness fallback only. |
| `model-lineage.ts` drifts from `modelFamily()` | minor | Built on top of `modelFamily()`; a test asserts every family maps to a lineage. |
| Second judge site (`convergence-run.ts`) stays same-lineage | minor | Threaded with an honest `unknown` author (no DTO there); labeling stays consistent, no behavior change. |

## Red-team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| RT1: Designer's "model usually undefined" premise is false (poll backfill @ squad-manager.ts:5784) | significant | v1 reads the real lineage; the floor is not invisible — it fires on the modal omp/pi land. |
| RT1: label-only ships measurement, not the fix | significant | Concern 05 ships a real disjoint reviewer (opt-in, gated), not just the label. |
| RT2: provider-prefix shortcut breaks on bare + ACP models | significant | `modelLineage()` is a normalizer, not a `split`; ACP/bare handled. |
| RT2: CodexJudge is a fail-open landmine on the critical path | critical | Own parser + timeout-degrade + live-verify gate; off by default. |
| RT2: RT1's default-unknown→anthropic is a confident mislabel | significant | Held the line at honest `unknown`. |

## Scope boundary

**Ships (v1):** the lineage normalizer, author-lineage threading (land + convergence sites), the three record fields, the confidence downgrade, the UI tooltip — **all always-on** — plus the `codex` disjoint judge **built and tested but opt-in/off** until its live-verify test is green.

**Deferred:** Approach B (omp `--model <vendor>` routing — unverifiable from code); a second disjoint vendor beyond codex (gemini CLI); making any disjoint judge the *default*; a hard fail-closed veto from a disjoint-only objection (stays advisory until the harness earns `verified:true`).
