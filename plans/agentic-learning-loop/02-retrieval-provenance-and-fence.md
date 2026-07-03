# Retrieval provenance + fence-in-builder
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/fabric-search.ts, src/fabric.ts, src/digest.ts, tests/fabric-search.test.ts

## Goal

Make retrieval results self-describing (where a fact came from and how fresh it is) and make untrusted-content fencing a property of the primer builders rather than a per-call-site convention. This is the foundation concerns 03/04/05 build on.

## Approach

**Provenance (additive, no dropping):**
- Add optional `source?: string` and `ranAt?: number` (epoch ms) to `FabricSearchResult` (`src/fabric-search.ts:34`).
- Thread a timestamp into `KbDoc` when flattening in `fabricDocuments()` / the fabric loaders: use the fields that already exist — `FabricDecisionFact.createdAt`, `FabricScoutFact.filedAt`, receipts' `endedAt`. Do **not** overload the existing `weight` prior for recency; add an explicit `ts?: number` on `KbDoc`.
- Surface these in `buildContextPrimer` output as a compact suffix per line (e.g. `(src: agent a1, 2h ago)`), and **label** low-scoring hits as `(weak match)` instead of dropping them. Weak matches stay — a novel task with only weak hits must still get a primer. `buildContextPrimer` must keep returning `""` only when there are genuinely zero hits (unchanged behaviour).

**Fence-in-builder (close the injection gap):**
- Today `buildContextPrimer` returns bare markdown and its docstring says the caller must fence. Move the `fenceUntrusted()` wrap **inside** `buildContextPrimer` so its output is always fenced.
- Audit the existing call sites: they currently fence externally — remove the now-double external fence, or make `fenceUntrusted` idempotent. Pick one and document it in the function.
- `src/digest.ts` already exports `fenceUntrusted`; reuse it, do not fork a second fencing helper.
- Add a test asserting `buildContextPrimer` output is always wrapped (no unfenced path), so future injectors (04/05) inherit the guarantee.

Do NOT add a confidence-drop floor to the primer (rejected in design: it starves novel cold-starts). Do NOT change BM25 scoring math here.

## Cross-Repo Side Effects

None. `FabricSearchResult` is consumed by `squad_kb_search` host tool and the primer; both tolerate the new optional fields.

## Verify

- `bun test tests/fabric-search.test.ts` — result carries `source`/`ranAt`; weak hits are labelled not dropped; empty corpus still yields `""`; primer output always fenced.
- `bun run check`
- `grep -n "Caller is responsible for fencing" src/fabric-search.ts` returns nothing (fence is now internal).
