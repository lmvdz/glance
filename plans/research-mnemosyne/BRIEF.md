# Research Brief: mnemosyne vs the agent-memory ledger

**Date**: 2026-07-27
**Target**: the agent-memory-ledger lane (POSITION/VALIDATION/HARNESS-SPEC/EXPERIMENTS).
**Method**: fresh-context subagent, primary sources only — our four canonical docs + a clone of
github.com/mnemosyne-oss/mnemosyne at commit `33540d2213c83fb2d5a0e004aef1fce78e5dbd76`
(2026-07-27; MIT, 1,870★, 58 contributors, ~3.5 months old, daily merge cadence).
**Adjudication caveat**: mnemosyne-side file:line citations were recorded by the scout and are
internally consistent, but not independently re-verified by a second reader; treat specific line
anchors as scout-confidence, the structural findings as high-confidence.

## What mnemosyne is

A zero-dependency in-process Python/SQLite memory library ("BEAM": working / episodic /
scratchpad tiers + a temporal SPO triple store + an append-only annotation store), embedded
directly or via MCP, exposing remember()/recall()/sleep(). Genuinely dogfooded: production-shaped
issues (#498 SEGV race, #564 summary-freshness inversion), honest self-published gap tables and
judge-mismatch disclosures.

## The comparison, adjudicated (full scout report preserved below)

**Convergences that strengthen the position:**
- They independently grew supersession fields (`superseded_by`, `valid_until`, triple-store
  `as_of` queries) in three places — supporting the position's "the semantics cost two fields and
  a write rule" minimalism claim from a second real system.
- Their own roadmap doc reaches for an L0–L4 layering nearly isomorphic to our four layers and
  states they aren't there yet — another lineage converging on the shape (POSITION §2's argument
  gains a fourth data point when/if they ship it; re-scout then).
- Their own benchmark breakdown scores worst exactly where the position predicts an
  ungated-write, accretive-summary system must: Contradiction Resolution 50%, Knowledge Update
  50%, Event Ordering 25% at 100K scale — the critique lands on a shipping system, not a strawman.

**Divergences where the ledger holds the stronger ground (each = one of our named rules):**
- Ungated write path: `remember()` and the always-injected persona-promote are single
  self-asserted calls — the "model's own claim of authority" channel our entry rule forbids.
- Authority-blind conflict resolution: Bayesian mention-count confidence wins unconditionally —
  a chatty agent asserting X four times beats an authoritative one-shot correction.
- Accreted (never regenerated) summaries; no gated-recoverability check; live issue #564 is
  E_drift in production.
- No token budget, no frozen-at-spawn, live re-ranking every call; no action-gate/authority
  concept anywhere (different control point: a library inside the caller's turn).
- Self-declared provenance (caller sets its own veracity/trust) vs our server-authored stamps.
- Evaluation: aggregate QA benchmarks, no kill criteria, no failure classes.

**Where they're honestly ahead of us:**
- Battle-tested multi-signal retrieval under real load, vs our lexical-first argued from
  literature + n=12 probes.
- 58 contributors of adversarial integration diversity = concurrency/staleness scar tissue we
  have not earned yet. The scout's sharpest line: our LIVE-1 ("supersession unreachable over
  HTTP until #298") and their #498 are the same story — the write path had a hole nobody
  exercised. Their volume finds such holes faster.
- Shipped raw-preserving compaction (originals never deleted) — our drill-down guarantee, live
  in production at scale.
- External benchmark participation; we've run none of the mapped subsets yet.

## Actionable, ranked

1. **Borrow directly — the claim-before-write orphan-tolerant pattern** (`sleep()` marks
   `consolidated_at` BEFORE summarizing; a crash mid-summary leaves the claim visible and the
   originals recallable). This is a battle-tested reference implementation of exactly what C3 /
   E_orphan / room-threads 06 rule 7 needs. Pointer filed for whoever builds the abnormal-exit
   sweep — read `beam.py` sleep path first.
2. **Borrow the pattern — memory banks** (named, filesystem-isolated stores per tenant) as the
   shape for any future cross-project isolation inside one supervisor; glance's repo-scoping is
   the current analog, no urgency.
3. **Priority nudge — external referees**: their participation and our absence is the one
   practice gap with reputational weight; LongMemEval's knowledge-update subset (C1's mapped
   referee) should run once the calibration pass exists, not "when convenient".
4. **Watch**: re-scout when their layered-memory roadmap ships — a working L0–L4 in a
   1,870★ project becomes either our strongest convergence evidence or our sharpest competitor.
5. **Do not adopt**: their write path and summary model — those are C9's and C2's rejected
   alternatives, shipping, with the predicted weak scores attached.

---

## Appendix: full fresh-context scout report (verbatim)

(preserved as delivered; scout had no access to this conversation's conclusions)

**Sources inspected.** Ledger side: the four canonical docs, read in full. Mnemosyne side: cloned
at `33540d2213c83fb2d5a0e004aef1fce78e5dbd76` (2026-07-27), MIT, 1,870★, created 2026-04-05, 58
contributors, pushed same day as review.

**Architecture**: BEAM tiers — working_memory (hot, TTL, FTS5), episodic_memory (consolidated,
hybrid vector+FTS5+importance), scratchpad (ephemeral) in `mnemosyne/core/beam.py`; temporal SPO
`triples` (auto-close prior row on same subject+predicate via valid_until, `triples.py:142-176`;
point-in-time `query(as_of=...)`, `triples.py:199-229`); append-only AnnotationStore
(`annotations.py`). Supersession fields exist per-table (`superseded_by`, `invalidate()`,
`beam.py:4012-4040`) but no store-wide bi-temporal contract and no L0 exhaust layer (their own
roadmap names L0/L2/L3-provenance/L4 as not-yet-built).

**Conflicts**: VeracityConsolidator (`veracity_consolidation.py`) Bayesian confidence
(`old + (1-old)*weight*0.3`), auto-resolve higher-confidence-wins (`run_consolidation_pass`,
777-830), extract=True path only; LLM conflict detector off by default; free-text remember()
content gets no conflict resolution — both facts sit in episodic and recall()'s blend picks.
DB-level concurrency (WAL, BEGIN IMMEDIATE, RLock) with real fixed races (issue #498 SEGV).

**Compaction**: sleep() (`beam.py:8261-8560`) claims stale rows (marks consolidated_at BEFORE
summarizing — crash-tolerant), LLM-summarizes with local-GGUF→remote→keyword fallback, writes
one NEW episodic row per group, never deletes originals (post-E3 additive, `beam.py:8261-8270`)
— accretive summaries, preserved raw. `docs/architecture.md:65` stale vs code ("removes the
originals"). Open issue #564: summary claims write-time as content age → recency inversion (live
E_drift-class bug).

**Active set**: pre_llm_call hook auto-injects working memory; recall() scores
0.5*vec + 0.3*fts + 0.2*importance, top-k, live re-rank every call, no hard budget, no freeze.
L3 persona tier always-injected regardless of relevance — pinning exists but promotion is one
ungated model-initiated call with a free-text reason that is only logged
(`persona_tools.py:9-36`).

**Write path**: `mnemosyne_remember` ungated (any client, self-declared importance/veracity);
exact-content dedup + importance-max on repeats; recurrence signal only in the narrow extraction
path. Provenance columns (author_id/author_type/veracity/trust_tier) are caller-self-declared
with light clamping — no server-authored stamping.

**Evaluation**: LongMemEval self-reported 98.9% Recall@All@5; BEAM benchmark (third-party
dataset) with per-ability breakdown at 100K: Contradiction Resolution 50.0%, Knowledge Update
50.0%, Event Ordering 25.0%. Honest judge-mismatch disclosure. No kill/resume tests, no failure
classes, no pre-registered kill criteria.

**Control point**: a library/MCP server inside the calling agent's own turn; zero
action-authorization concept (no authorize/revoke/gate code). Its always-injected persona tier is
the self-directed-paging shape that does not transplant to a supervisor architecture, and the
ledger's action-gate has no meaning inside a library with no execution loop — different control
points, neither's mechanisms port.

**Verdict (scout's own)**: mnemosyne fails first at the ungated write path + authority-blind
confidence-wins resolution (chatty agent × 4 mentions beats authoritative one-shot correction,
silently, conflicts table never surfaced proactively; #564 shows the class is live). The ledger
fails first by under-exposure: validated by design argument + small-n probes + one host repo,
without the adversarial integration diversity that finds the write-path holes nobody exercised —
noting that glance's LIVE-1 and mnemosyne's #498 are the same story-shape. Borrow: banks pattern,
claim-before-write. Do not adopt: ungated writes, accretive summaries. Watch: their L0-L4 roadmap.
