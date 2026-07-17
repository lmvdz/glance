# Overhead (Epic G)

Parent: plans/daily-driver/00-meta.md · Arbitration: daily-driver-arbitration.md §11 (binding) · Evidence: daily-driver-landscape.md

## Outcome

Two numbers, two disciplines, never merged into one job. Everything the daemon itself controls between dispatch and the first byte back from a driver is a DETERMINISTIC ratchet run against a mock harness — no model, no network — gated in `bun test`, with a committed numeric baseline that only ever moves down (or up on an explicit operator commit). Everything the model/network controls — how much slower a real glance-mediated turn feels next to typing the raw harness CLI directly — is a PUBLISHED, manually re-measured number that never gates anything, anywhere. A live-model wall-clock gate would fold every flaky-gate failure mode this repo has already paid for (verify-loop thrash on hard units; the composition-drift false-green lesson — only a fresh pristine run ever counted as truth) into a single job on a non-deterministic input. Splitting the concern this way is the fix, not a compromise.

This epic is p2 and OFF the adoption path (00-meta.md epic table): the wave-0 stopwatch that actually informs Epic A's prewarm decision already lives at `plans/daily-onramp/01-console-lane-stopwatch.md` as throwaway measurement, not a committed gate. This epic is the durable follow-on, built after wave 1 ships and sequenced by priority, not by a hard dependency.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 mock-harness-ratchet | pins the one thing glance's own dispatch path can regress — overhead between dispatch and the first byte back from a driver — as a committed-baseline test, so a future change to the dispatch/manager path can't silently get slower without a red test | architectural | scripts/orchestration-overhead-bench.ts (new), tests/orchestration-overhead.test.ts (new), src/spans.ts (read-only reuse) |
| 02 published-live-ratio | the honest, public number: how much slower `glance here` feels vs the raw harness CLI on the same real task, same model, same moment — published in a repo doc, never gated, re-measured on demand | mechanical | docs/ (new doc or section), scripts/ (manual runner) |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | standalone — mock harness + ratchet, no dependency on anything else in this epic |
| 2 | 02 | claimed soft dependency on 01's scaffolding — verified in 02's own doc; drop if it doesn't hold |

## Not yet specified

(none)

## Notes

- The GATED-vs-PUBLISHED split is the whole point of this epic (arbitration §11, folding RT1 F2 + RT2 4b): 01 is a `bun test` assertion with a committed numeric baseline, following the `scripts/defect-ratchet.ts` / `tests/defect-ratchet.test.ts` committed-baseline pattern (no `.github/workflows` exist in this repo — "gated" means "part of the `bun test` suite the land gate, `src/proof.ts`, already runs"). 02 is never wired into that suite, under any flag, ever.
- t3code's 3x-overhead complaint (plans/research-t3code/BRIEF.md) is why 02 must be public rather than discovered by feel: an honest, visible number is the antidote to a builder quietly bouncing off the product.
- Neither concern touches the needs-you ladder, boundary sync, or any git-write path — no cross-lineage (codex+grok) review requirement here, unlike Epic A's boundary-sync or Epic F's preview tool.
- Adoption gate lives in plans/daily-driver/00-meta.md, not here: this epic does not execute-to-ship until wave 1 (A–D) has shipped and the kill criterion hasn't fired.
