# Related work: arXiv + GitHub sweep

**Date**: 2026-07-25 · Companion to [POSITION.md](POSITION.md). Two parallel scouts (arXiv, GitHub),
briefed on the position's seven themes and told to prize contradicting work over supporting work.
Every paper verified via its abstract page; every repo verified via gh CLI. Excludes the nine
sources already verified in [BRIEF.md](BRIEF.md).

Themes: (1) event-sourcing/supersession · (2) conflict resolution · (3) compaction failure ·
(4) sub-agent handoff/orphaned state · (5) active set/cache · (6) evaluation · (7) lexical/declared retrieval.

## Challenges to the position (read these first)

- **arXiv 2606.00408 — Masking Stale Observations Helps Search Agents, Until It Doesn't** (May 2026).
  Lossy context reduction sometimes *helps*, on a regime map: plateau under weak retrievers, a real
  peak at strong-retriever/mid-capacity pairings, collapse at saturation. Undercuts any absolute
  "compaction = drift = bad" reading. → POSITION §2's rules should be read as "lossy compaction must
  be *recoverable*," not "context reduction is harmful." (Theme 3)
- **arXiv 2607.10608 — The Compliance Trap** (Jul 2026). Agents adopt conflicting/wrong memory at
  the first exposed decision point regardless of model strength; stronger models lose more per
  compliance event. Correct latest-valid-wins resolution is necessary but not sufficient —
  **exposure order and consumption behavior are an independent failure axis** the position does not
  currently address. Candidate ninth claim for VALIDATION.md. (Theme 2)
- **arXiv 2605.23296 — Parallel Context Compaction for Long-Horizon LLM Agent Serving** (May 2026).
  A live research line that accepts lossy summarization as permanent and optimizes its
  latency/throughput, rather than replacing it with regeneration-from-log. The serving-systems
  world is betting against the position's premise. (Themes 3, 5)
- **github osinachix/contested-memory** (0★, WIP, active). Deliberately does NOT auto-resolve
  conflicts: on disagreement it appends a *linked competing claim*. Thesis: surfacing unresolved
  disputes is more honest than forcing resolution. A real design dissent against write-time
  supersession — though note glance's escalation model can express both (supersede when the
  supervisor has ground truth; escalate-as-needs-you when it doesn't). (Themes 1, 2)
- **arXiv 2604.22085 — Memanto** (Apr 2026). Typed memory with conflict resolution and temporal
  versioning, positioned *against* hybrid semantic-graph architectures as unnecessary overhead —
  soft support for "two fields, no graph DB," soft challenge to graph-first designs generally.
  (Themes 1, 2)

## Direct support

- **arXiv 2607.12893 — MemOps** (Jul 2026). Reframes memory eval as a lifecycle of explicit
  operations (remember/forget/update/reflect) with structured traces — independently converges on
  the event-sourcing/operation-log framing. (Themes 3, 6)
- **arXiv 2606.22528 — Governance Decay** (Jun 2026). Compaction silently drops safety constraints
  (violations 0% → up to 59%); introduces a Compaction-Eviction Attack and Constraint Pinning.
  Raises the stakes of E_constraint/E_abstraction from correctness to safety. (Theme 3)
- **arXiv 2607.14166 — Stop Means Stop** (Jul 2026). Across six agent frameworks: cancellation
  orphans, timeout zombies, replay double-execution on sub-agent cancellation (leakage in 215/1200
  runs). The orphaned-exit failure mode, measured in the wild. (Theme 4)
- **arXiv 2605.10848 — Pi-Serini** (May 2026). Well-tuned BM25 + strong LLM beats dense-retriever
  search agents on BrowseComp-Plus (83.1%). Strong support for lexical-first, albeit on web search
  rather than code. (Theme 7)
- **arXiv 2606.17016 — TokenPilot** (Jun 2026). Ingestion-aware compaction that stabilizes prompt
  prefixes for cache + lifecycle-aware eviction; 61–87% cost cut. The cache-safe injection
  discipline, systematized. (Theme 5)
- **arXiv 2605.29630 — Entity-Collision** (May 2026). Event-sourced decision logs for
  reproducibility; shows dense-retrieval gains often vanish once BM25's lexical floor is controlled.
  (Themes 1, 7)
- **github crzyc0d3r/memory-write-path-lab** (0★, runnable experiment). Typed ontology +
  edge-invalidation scores 10/10 on fact-update questions vs a flat chunk store's 2/10, with
  reproduced stale-answer failures. Tiny, but it is C1's ablation already run by someone else.
  (Theme 3)

## Foundations (classics worth citing)

- **arXiv 2304.03442 — Generative Agents** (2023). Append-only memory stream + reflection layer:
  the ancestor of ledger + derived summaries. (Theme 1)
- **arXiv 2111.13499 — Bitemporal Property Graphs** (2021). The database-theory grounding for
  validity windows and point-in-time reconstruction. (Theme 1)
- **arXiv 2303.11366 — Reflexion** (2023). Derived reflective memory as a distinct layer from raw
  experience. (Theme 3)

## Benchmarks & eval infrastructure

- **arXiv 2604.23781 — ClawMark** (Apr 2026). Multi-day, multimodal, stateful coworker-agent
  benchmark; best model at 20% full completion, degrading after environment state changes. The
  multi-day gap, quantified. (Theme 6)
- **arXiv 2607.13157 — Oracle Agent Memory** (Jul 2026). Enterprise DB-native memory substrate;
  93.8% on LongMemEval at 10.7× fewer tokens than flat history. (Themes 1, 6)
- **github MemTensor/HaluMem** (148★). Operation-level hallucination benchmark for memory systems
  (scores write/update/retrieve, not final QA). (Theme 6)
- **github bowen-upenn/PersonaMem** (174★, COLM 2025). Dynamic user-profiling over multi-session
  dialogue. (Theme 6)

## Systems & building blocks (GitHub)

- **topoteretes/cognee** (29.3k★, active). Graph+vector pipelines with ontology-driven dedup — the
  highest-adoption structured-memory system; notably *not* a flat vector store. (Themes 2, 3)
- **MemoriLabs/Memori** (15.7k★, license unclear). Structured memory from *execution traces* (tool
  calls, decisions, outcomes), BYO-database; beats Zep/Mem0 on LoCoMo token footprint. Closest
  large project to "memory from exhaust." (Themes 3, 4)
- **neo4j-labs/agent-memory** (384★, official Neo4j Labs). POLE+O graph, explicit consolidation
  API, `:TOUCHED` audit edges from reasoning steps to entities, ships an eval harness. (Themes 3, 6)
- **zhangfengcdt/memoir** (598★, alpha). Git-like branch/commit/merge/rollback/blame over
  hierarchical memory paths — version control as the supersession mechanism. (Themes 1, 3)
- **inite-ai/inite-brain-service** (30★, AGPL). Per-tenant bitemporal KG, "not a vector store":
  two clocks per fact, explicit conflict-resolver stage with trust snapshots. (Themes 1, 2, 3)
- **davccavalcante/gaptime** (1★). Zero-dependency TypeScript bitemporal store: valid-time +
  transaction-time, supersede-without-delete, time-travel queries. The cleanest minimal reference
  implementation of exactly the L1 mechanism. (Themes 1, 2)
- **Nifty0x/memora** (2★). "Bitemporal Provenance Memory Architecture" reference ledger. (Theme 1)
- **cortexkit/magic-context** (1.5k★). Self-managing compaction layer for coding agents ("one
  session for life"). (Theme 4)
- **mtrnix/metronix-memory** (32★). MCP-native memory server: dense+sparse+graph hybrid, temporal
  KG layer, ships LoCoMo/LongMemEval/MemoryAgentBench harnesses. (Themes 2, 5, 6)
- **jagoff/memo** (9★). 100%-local: Markdown source of truth, sqlite-vec + BM25 hybrid, MCP + CLI.
  (Theme 5)
- **beaugunderson/obliscence** (7★). Claude Code history archive with FTS5/BM25 + sqlite-vec.
  (Themes 4, 5)

## Deep-read addendum (2026-07-25, full-text pass on the two gap papers)

- **2607.10608 (Compliance Trap), full text**: the trap fires at the *first* decision point where
  conflicting memory appears; presentation does not matter (system-prompt vs observation-footer
  placement changed damage by ±0.5pp across three open-weight models; explicit staleness labels
  untested but placement-independence implies annotation is weak). Compliance rates 63–72% across
  five models (Qwen3.5-9B/27B, Gemma-4-E4B/26B, Gemini-3-Flash). Damage scales with capability:
  −2.1pp (Gemma-4-E4B, 23% baseline) → −25.5pp (Qwen3.5-27B, 49% baseline) on WebArena;
  −9.5 → −26.0pp on MemTrapBench. "Verify before acting" warnings cut conflicting damage +17.2pp
  but cost −11.0pp of helpful gains — uniformly less compliant, not selectively safer. Their best
  mitigation is scheduling (inject memory only on retry-after-failure). **Consequence adopted**:
  exclusion-not-annotation at projection → POSITION §3 caveat, VALIDATION C9, room-threads 06
  rule 9.
- **2606.00408 (Masking), abstract + regime map**: masking = removing observations the model has
  stopped attending to; asymmetric inverted-U over retriever strength × model capacity (4B–284B);
  authors' own framing: safe when it removes what the model would not have used, unsafe when it
  removes evidence it would have. Which regime applies is not knowable per-item in advance.
  **Consequence adopted**: POSITION §2 sharpened to "loss must be recoverable," explicitly not
  "context reduction is harmful."

## Late addition (2026-07-26): Agentic Context Management (arXiv 2607.21503)

Maximem vendor paper, full /research pass in
[../research-agentic-context-management/BRIEF.md](../research-agentic-context-management/BRIEF.md).
Convergent with the position's lifecycle thesis from a commercial lineage. Three usable pieces:
**validated compaction** (loss-check + retry-less-aggressive loop — upgrades room-threads 06's
E_abstraction guard and operationalizes C2's identifier-survival metric as a runtime gate), a
five-corpus **retrieval regime study** (keyword wins entity-carrying queries SciQ 0.815 vs 0.614;
vector wins semantic-gap NL→code 0.914 vs 0.290; 60–100× vector indexing tax — refines C5 into
regime-classified miss logging), and a citable **accuracy-cliff** case (18,282→122 tokens:
66.7%→57.1%). Its Architecting primitive (LLM-generated memory architecture) is cut as
meta-level inference-over-declared-structure; its hosted polyglot platform is §7's standing
rejection with better ammunition.

## Late addition (2026-07-26, evening): harness spec artifact

A second pre-extracted deep-research artifact, this one substantially an ECHO of this lane's own
POSITION/VALIDATION (its five ablations are C2/C9/C8/C7/C2-C6 restated) — full /research pass
with echo-vs-delta discipline in
[../research-memory-eval-harness/BRIEF.md](../research-memory-eval-harness/BRIEF.md). Genuine
delta folded into VALIDATION.md same day: the E_gov_halt over-conservatism class + FCR/FSR
paired constraint probes, divergence-step + N-step post-resume scoring, the named
disruption-operator vocabulary, zero-tolerance vector scoring, and E_orphan/E_drift promoted to
named classes. Its sharpest actionable finding is a LIVE glance gap: `buildContextPrimer` is
pure BM25 top-6 with no pinned region, so constraints/failure-warnings compete with episodic
chatter — the position's own "state, never score" rule unapplied at its most consequential
injection point. Filed as the next code unit in the fabric lane — **LANDED 2026-07-27** (PR #293, region-partitioned primer: pinned failures never evicted, pinned current decisions, ranked episodic remainder; blind review found and closed a cap bypass).

## Late addition (2026-07-27): mnemosyne, compared fresh-context

Full brief: [../research-mnemosyne/BRIEF.md](../research-mnemosyne/BRIEF.md) (scout cloned
33540d2, 1,870-star shipping OSS memory library). Three things it gives this lane: independent
supersession-field convergence (supports the two-fields minimalism claim); a shipping instance of
the ungated-write + accretive-summary design whose own benchmark breakdown (CR 50 / KU 50 / EO
25% at 100K) lands where the position predicts; and one directly borrowable battle-tested
pattern — claim-before-write orphan tolerance in its sleep() path — filed as the reference read
for C3/E_orphan's abnormal-exit sweep. Its honest counterweight: they have 58 contributors of
adversarial integration scar tissue and external benchmark participation; we have design
argument, seam tests, and n=12 probes. Priority nudge accepted: run LongMemEval's mapped subsets
once calibration exists, not "when convenient".

## What the sweep says about the position

1. **No refutation found of the core thesis.** No widely-adopted flat-vector memory system is held
   up as best-in-class; the high-adoption systems (cognee 29k★, Memori 15.7k★) are structured, and
   bitemporal/versioned stores are proliferating as of mid-2026. The write-path-lab repo is
   literally C1's ablation, already showing 10/10 vs 2/10.
2. **Two real gaps in the position surfaced.** (a) The Compliance Trap: exposure order is an
   independent failure axis beyond resolution correctness — a candidate C9 for VALIDATION.md and a
   caveat for POSITION §3. (b) Masking-helps-sometimes: the position should claim "lossy compaction
   must be recoverable," not "context reduction is harmful" — POSITION §2 already leans this way
   but should say it explicitly if revised.
3. **One live design dissent worth naming**: contested-memory's surface-don't-resolve stance.
   Glance's model already spans both poles (supersede with ground truth, escalate without), which
   is worth stating when the conflict rule is implemented.
4. **The eval direction is being converged on independently**: MemOps (operation-level scoring),
   HaluMem (operation-level hallucination), ClawMark (multi-day stateful). The four-protocol suite
   in VALIDATION.md has company; ClawMark and HaluMem are candidate external referees alongside
   LongMemEval/MemoryAgentBench.
