# Glance / omp-squad Fleet Receipt Report

Read-only analysis of `~/.glance/receipts/*.jsonl`, `~/.glance/orgs/*/receipts/*.jsonl`, `~/.glance/land-failures.json`, and `~/.glance/dispatch-ledger.json`. `~/.glance/model-outcomes.json` was not present.

## 1. INVENTORY

- Receipt files: 410
- Parseable receipts: 543
- Parse errors: 0
- Date range by `startedAt`: 2026-06-21T21:02:09.047Z to 2026-07-07T17:20:40.014Z
- Date range by `endedAt`: 2026-06-21T21:12:12.483Z to 2026-07-07T17:49:00.915Z
- Scope split: root 501 receipts / 372 files; org-scoped 42 receipts / 38 files
- Org scoped id: `org_01KWJC6XBFP7MS0C5J5Z8XW470`
- Dispatch ledgers: 2 files, 61 distinct UUIDs, 0 receipt-text matches
- Land-failure ledger: 10 branch keys, 38 matched receipts

Models as recorded:

| model identity | runs |
|---|---:|
| `<missing>` | 422 |
| `openai-codex/gpt-5.5` | 39 |
| `claude-opus-4-8` | 35 |
| `claude-fable-5` | 27 |
| `opus` | 12 |
| `gpt-5.5` | 6 |
| `claude-sonnet-5` | 1 |
| `claude-sonnet-4-6` | 1 |

Harnesses as recorded:

| harness | runs |
|---|---:|
| `<missing>` | 430 |
| `claude-code` | 64 |
| `omp` | 44 |
| `codex` | 5 |

## 2. COST/OUTCOME MATRIX

Outcome join is conservative. `failed` means a receipt matched a `land-failures.json` branch/agent/name/feature key. `landed` is 0 because no available file maps landed outcomes back to receipts.

| model | harness | runs | total cost | tokens | mean cost/run | landed | failed | unknown |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `claude-opus-4-8` | `claude-code` | 35 | $9888.0078 | 4,650,229,387 | $282.5145 | 0 | 0 | 35 |
| `claude-fable-5` | `claude-code` | 27 | $5000.9356 | 1,335,185,557 | $185.2198 | 0 | 0 | 27 |
| `<missing>` | `<missing>` | 385 | $586.9807 | 618,763,574 | $1.5246 | 0 | 38 | 347 |
| `opus` | `<missing>` | 12 | $42.2260 | 44,318,222 | $3.5188 | 0 | 0 | 12 |
| `<missing>` | `omp` | 37 | $42.0258 | 42,625,267 | $1.1358 | 0 | 0 | 37 |
| `gpt-5.5` | `codex` | 5 | $36.7665 | 42,739,207 | $7.3533 | 0 | 0 | 5 |
| `openai-codex/gpt-5.5` | `<missing>` | 33 | $15.7327 | 18,109,730 | $0.4767 | 0 | 0 | 33 |
| `gpt-5.5` | `omp` | 1 | $6.6878 | 8,319,760 | $6.6878 | 0 | 0 | 1 |
| `openai-codex/gpt-5.5` | `omp` | 6 | $0.8669 | 299,150 | $0.1445 | 0 | 0 | 6 |
| `claude-sonnet-5` | `claude-code` | 1 | $0.0904 | 53,924 | $0.0904 | 0 | 0 | 1 |
| `claude-sonnet-4-6` | `claude-code` | 1 | $0.0542 | 33,650 | $0.0542 | 0 | 0 | 1 |

Normalized `modelKey` rollup from `src/model-outcomes.ts` semantics:

| modelKey | runs | total cost | tokens | failed | unknown |
|---|---:|---:|---:|---:|---:|
| `claude-opus-4-8` | 35 | $9888.0078 | 4,650,229,387 | 0 | 35 |
| `claude-fable-5` | 27 | $5000.9356 | 1,335,185,557 | 0 | 27 |
| `default` | 422 | $629.0065 | 661,388,841 | 38 | 384 |
| `gpt-5.5` | 6 | $43.4543 | 51,058,967 | 0 | 6 |
| `opus` | 12 | $42.2260 | 44,318,222 | 0 | 12 |
| `openai-codex/gpt-5.5` | 39 | $16.5996 | 18,408,880 | 0 | 39 |
| `claude-sonnet-5` | 1 | $0.0904 | 53,924 | 0 | 1 |
| `claude-sonnet-4-6` | 1 | $0.0542 | 33,650 | 0 | 1 |

## 3. KEY-SHAPE AUDIT

| exact receipt identity | runs | shape | warning |
|---|---:|---|---|
| `<missing>` | 422 | missing, normalizes to `default` | Will not match any explicit model string. |
| `openai-codex/gpt-5.5` | 39 | provider/model | Will not match bare `gpt-5.5`. |
| `gpt-5.5` | 6 | bare model id | Will not match provider-qualified `openai-codex/gpt-5.5`. |
| `claude-opus-4-8` | 35 | bare vendor-family-version | Will not match `opus`. |
| `opus` | 12 | bare alias | Will not match `claude-opus-4-8`. |
| `claude-fable-5` | 27 | bare vendor-family-version | Separate key from every Claude alias/provider form. |
| `claude-sonnet-5` | 1 | bare vendor-family-version | Separate key from other Sonnet ids. |
| `claude-sonnet-4-6` | 1 | bare vendor-family-version | Separate key from other Sonnet ids. |

Observed key-coherence hazards: `openai-codex/gpt-5.5` vs `gpt-5.5`; `claude-opus-4-8` vs `opus`; missing model values collapse to `default`.

## 4. TASK-CLASS SIGNAL

Derived task family × model × harness:

| task family | model | harness | runs | cost | tokens | failed |
|---|---|---|---:|---:|---:|---:|
| `claude-code` | `claude-opus-4-8` | `claude-code` | 35 | $9888.0078 | 4,650,229,387 | 0 |
| `claude-code` | `claude-fable-5` | `claude-code` | 27 | $5000.9356 | 1,335,185,557 | 0 |
| `ompsq` | `<missing>` | `<missing>` | 295 | $465.9484 | 486,453,339 | 29 |
| `ompsq` | `<missing>` | `omp` | 36 | $41.8627 | 42,592,669 | 0 |
| `codex` | `gpt-5.5` | `codex` | 5 | $36.7665 | 42,739,207 | 0 |
| `vpb` | `<missing>` | `<missing>` | 16 | $29.6269 | 24,787,699 | 0 |
| `chat` | `openai-codex/gpt-5.5` | `<missing>` | 33 | $15.7327 | 18,109,730 | 0 |
| `status` | `<missing>` | `<missing>` | 2 | $13.7627 | 18,545,137 | 0 |
| `agent-1` | `<missing>` | `<missing>` | 9 | $12.8220 | 11,486,127 | 0 |
| `verified-landing-control-plane` | `<missing>` | `<missing>` | 9 | $9.3062 | 14,969,086 | 9 |
| `chat` | `openai-codex/gpt-5.5` | `omp` | 6 | $0.8669 | 299,150 | 0 |
| `chat` | `<missing>` | `<missing>` | 15 | $1.4636 | 349,432 | 0 |
| other named families | mixed | mostly `<missing>` | 65 | $100.8796 | 115,112,677 | 0 |

OMPSQ issue ids with failure signal:

| task class | model | harness | runs | cost | tokens | failed |
|---|---|---|---:|---:|---:|---:|
| `ompsq-294` | `<missing>` | `<missing>` | 14 | $6.3199 | 5,982,373 | 14 |
| `ompsq-178` | `<missing>` | `<missing>` | 4 | $3.8820 | 3,414,663 | 4 |
| `ompsq-189` | `<missing>` | `<missing>` | 4 | $2.5802 | 2,355,473 | 4 |
| `ompsq-190` | `<missing>` | `<missing>` | 2 | $1.7486 | 1,478,156 | 2 |
| `ompsq-55` | `<missing>` | `<missing>` | 1 | $7.4642 | 7,210,567 | 1 |
| `ompsq-138` | `<missing>` | `<missing>` | 1 | $6.5684 | 8,372,072 | 1 |
| `ompsq-130` | `<missing>` | `<missing>` | 1 | $4.7947 | 5,682,847 | 1 |
| `ompsq-194` | `<missing>` | `<missing>` | 1 | $2.0705 | 1,983,820 | 1 |
| `ompsq-211` | `<missing>` | `<missing>` | 1 | $0.6901 | 721,952 | 1 |

High-spend OMPSQ unknown-outcome signals include `ompsq-33` at $37.8038 over 8 runs, `ompsq-35` at $16.3713 over 5 runs, `ompsq-125` at $14.0218 over 3 runs, and `ompsq-37` at $12.4013 over 6 runs. These are spend signals only, not success signals.

## 5. GAPS

- No landed join is possible from the requested files: `model-outcomes.json` is absent, and `dispatch-ledger.json` is UUID-only with no receipt matches.
- `land-failures.json` is branch-keyed, not run-keyed. A matched receipt means that branch has landing failures; it does not prove that exact run failed.
- 422/543 receipts have no `model` field, so most OMP spend collapses to `default` under current `modelKey` rules.
- 430/543 receipts have no `harness` field. Existing scoreboard logic may treat missing harness as daemon/OMP, but exact key-shape reporting must preserve `<missing>`.
- External harness receipts carry spend/model data, but no land outcome join in the available ledgers.
- Task class is heuristic except for explicit `ompsq-NNN` ids. Family names like `chat`, `vpb`, and `claude-code` are not semantic complexity tiers.
- Missing `tokens` or `costUsd` fields are counted as zero in aggregates; the data cannot distinguish absent telemetry from true zero-cost runs.
