# Reward-boost on digests
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/digest.ts, src/fabric.ts, src/proof.ts, tests/digest.test.ts, tests/fabric-search.test.ts

## Goal

Let verified, clean successes rank higher when priming future agents — without ever penalising work that simply lacks a proof signal. Boost-only: absence of proof means "unknown," never "bad."

## Approach

**Tag the digest with a fresh-checked reward:**
- Extend `buildDigest` (`src/digest.ts:49`) input to accept an optional reward summary `{ ok: boolean, fresh: boolean, firstTryGreen: boolean } | null`.
- The caller (squad-manager run-end) computes it: read the worktree proof and run `isFresh(proof, fingerprint)` (`src/proof.ts:103`) — a proof that is `ok` but stale must tag as **unknown**, not pass. `firstTryGreen` = passed with zero fixup visits (from concern 01's engine instrumentation).
- Record the tag in the digest markdown as a small structured line (kept out of the prose sections so it does not pollute the summary).

**Boost via existing weight, not new ranking logic:**
- `fabricDocuments()` is a pure flatten; ranking lives in `searchFabric` via the `KbDoc.weight` fold (`src/fabric-search.ts:162`). Do NOT add boost/drop logic to the flatten.
- When flattening a digest doc, set `KbDoc.weight` from the reward tag: e.g. `firstTryGreen` > `ok+fresh` > `unknown` (baseline 1.0) — a multiplicative prior only, so the BM25 fold already applies it. **No down-weight below baseline; no drop.** Missing tag → baseline weight.
- Gate the whole behaviour behind `OMP_SQUAD_REWARD_BOOST` (concern 01's flag reader); off → baseline weight for all, i.e. current behaviour.

Reward-hacking guard: only `firstTryGreen` earns the top boost. A green-after-3-fixups run is `ok+fresh` (mild) not top-tier, so a thrash is not enshrined as a gold signal.

## Cross-Repo Side Effects

None. Digest markdown gains one structured line; readers that display digests should keep it out of the human summary view (it is metadata).

## Verify

- `bun test tests/digest.test.ts` — reward tag computed correctly for fresh-pass / stale-pass(=unknown) / fail / no-proof(=unknown) / first-try vs multi-fixup.
- `bun test tests/fabric-search.test.ts` — with flag on, a first-try-green digest out-ranks an unknown digest on equal BM25; with flag off, weights are equal; no digest is ever weighted below baseline.
- `bun run check`
