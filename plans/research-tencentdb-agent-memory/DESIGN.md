# Design: Fleet institutional-memory / primer de-pollution

## Status: DESCOPED after adversarial design + live-state grounding

The original goal — "reduce redundant/contradicting decision facts in the cold-start primer, and add typed+traceable institutional memory distilled into a per-repo conventions doc" — was tested against the actual code and the running daemon's state. **The motivating problem is empirically near-nonexistent and the premise partly false.** Two independent opus red-teamers and a live-state probe converged on this. The design is descoped accordingly.

## What the evidence showed

| Claim in the original plan | What the code / live state actually says |
|---|---|
| Concurrent agents pile up redundant decisions in an append-only store | **No append-only decision store exists.** Decisions are either parsed from plan markdown (`features.ts:753`, view-layer only) or held per-feature in `pf.decisions`. |
| Plan-boilerplate decisions pollute the primer | **Plan-parsed decisions never reach the primer.** `fabric()` feeds `[...featureStore.values()]` (`squad-manager.ts:5093`); `buildFabricSnapshot` reads `f.decisions` off persisted features only (`fabric.ts:276`). The `pf.decisions ?? planDecisions()` fallback runs at DTO-build time (`features.ts:875`) and is never persisted back. |
| The primer is crowded by duplicate decision lines | The primer is **top-6 BM25 ranked against the spawning agent's own task text** (`squad-manager.ts:3048`) — a per-query top-N phenomenon, not a flat dump. BM25's IDF already suppresses exact repetition (shared tokens → high doc-frequency → ~0 contribution). |
| The problem is real at current scale | **Live state: 47 features, 0 with any persisted decisions; across 21 active plan dirs, 1 file has a Decisions section with 0 parsed items.** The decision fact-channel is empirically ~empty. |

## Approach (descoped)

Two principles, both forced by the evidence:

1. **Measure before optimizing.** There is no metric linking primer *content* to agent *outcomes* today (only `primer-empty`). Add a "primer decision-share / near-dup" counter and read one day of real cold-starts before building anything semantic.
2. **Fix the symptom where it lives — cheaply, deterministically, generally.** If any fact type ever monopolizes the 6 primer slots, the fix is a per-type quota + exact-normalized-text collapse *inside `buildContextPrimer`*. ~15 lines, pure, race-free, zero-cost, no LLM, no cache, no daemon loop. It guards **every** fact type, not just decisions, so it earns its keep even while decisions are empty.

Everything LLM-driven, schema-extending, or artifact-generating is **cut** — it is machinery aimed at a corpus the primer never reads globally, for a problem that does not yet exist.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Consolidation site | Query-time, inside `buildContextPrimer` | Async daemon pass + cache (orig. Concern 2) | The symptom is per-query top-N; the corpus is never read globally. A cache also breaks `fabric-search.ts`'s documented pure/sync/testable invariant and inverts the on-demand fabric's freshness guarantee. |
| Dedup algorithm | Exact normalized-text collapse | Token-Jaccard fuzzy (orig. Concern 1) | Real duplicates are copy-paste (byte-identical bar `featureTitle`). Jaccard false-merges parametrized decisions that differ only in the load-bearing noun ("gate feature **X**…" vs "…**Y**…"). |
| Crowding fix | Per-type quota (cap any one type at N of 6 slots) | Dedup alone | A quota fixes crowding even for *distinct* same-type facts; dedup only helps duplicates. Quota is the more general guard. |
| Contradictions | Escalate, not merge (deferred) | Merge into one consolidated line (orig. Concern 2) | Merging contradicting decisions destroys the exact signal a fresh agent needs. If ever built, emit a louder `conflict` doc showing both — the opposite of consolidation. |
| Typed facts / `conventions.md` | **Cut** | Extend `FeatureDecision` + per-repo LLM-distilled doc (orig. Concerns 3–4) | `priority`/`sourceRef` are unpopulated by the dominant (plan) source; `conventions.md` is a cheap-model repo-wide truth doc (blast radius = whole repo) vs per-agent digests (blast radius 1) — a net-negative safety trade. Scope creep from porting the source tool's L3 persona layer. |
| Rollout | Behind the existing `=ab` A/B variant infra (`metrics.ts`), read `first-try-green` delta | Ship default-on | The A/B + outcome-metric machinery already exists; let data decide whether even the ~15-line version lifts anything. |

## Risks

- **Even the MVP may lift nothing today** (decisions are empty) — mitigated by the measurement-first gate: the probe is one line and the quota/dedup is a cheap general guard that pays off whenever *any* type crowds, so it is defensible as future-proofing rather than dead code.
- **The real upstream gap is decision *capture*, not consolidation.** The channel is empty because nothing writes it — agents don't record decisions and concern files don't use "Decisions" sections. If institutional memory is genuinely wanted, that is a *different, higher-value* plan (capture from digests/receipts, or an agent decision-record tool) and should be scoped on its own merits.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| Premise false — plan decisions never reach the primer; primer is task-scoped BM25; IDF suppresses dups; live channel empty | critical | Descoped to measure-first + a cheap general guard; LLM/typed/conventions concerns cut. |
| Concern 2 cache breaks `fabric-search.ts` purity/sync/testability + inverts freshness + cross-tenant global store | significant | Cut the async/cached consolidation entirely; do it query-time and pure. |
| Merging contradictions hides them | significant | Deferred; if built, escalate as a `conflict` doc, never merge. |
| `priority`/`sourceRef` unpopulated by dominant source; 2 of 4 `kind` enum values unreachable | significant | Typed-fact concern cut; only `kind` is defensible and only if the probe justifies typed dedup. |
| `conventions.md` = repo-wide cheap-model trust hazard + unbounded backups | significant | Cut. If a human-readable conventions view is wanted, render typed facts on demand in KnowledgePanel — a reporting feature, not a persisted LLM artifact. |
| Jaccard over-engineered + false-merge risk | significant | Use exact normalized-text collapse. |

## Open Questions (resolve before DECOMPOSE)

1. **Ship the MVP at all, or shelve?** Given the channel is empirically empty, the measurement probe + cheap general quota/dedup guard is genuinely useful as future-proofing, but is not urgent. Options: (a) ship probe + guard behind A/B; (b) probe only; (c) shelve and revisit when decision volume appears; (d) **pivot** to the real gap — decision capture.
2. If pivoting: is institutional memory (captured decisions/conventions) a priority worth its own plan? That is where the source tool's ideas actually pay off — but only once there are decisions to remember.
