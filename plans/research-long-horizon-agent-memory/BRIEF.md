# Research Brief: Long-Horizon Agent Memory (beyond vector similarity) → omp-squad room-threads

**Date**: 2026-07-25
**Target project**: omp-squad (`/home/lars/sui/omp-squad`) — specifically **plans/room-threads** (per Lars, this run: "does not map to any specific repository however omp-squad is a good choice, specifically on top of our room-threads plan/work")
**Question**: which memory-architecture patterns from this report transfer to the room-threads node substrate, beyond what [research-tencentdb-agent-memory](../research-tencentdb-agent-memory/BRIEF.md) (2026-07-07) already ranked — and how do they sequence against DIRECTION.md's the-room/love-gate law.
**Source**: user-supplied pre-extracted deep-research report, preserved verbatim at [SOURCE-REPORT.md](SOURCE-REPORT.md). No bibliography was delivered; all load-bearing claims were independently spot-verified 2026-07-25 (below).
**Systems covered**: TencentDB-Agent-Memory (already briefed), HippoRAG/HippoRAG 2 (arXiv 2405.14831), Graphiti/Zep bi-temporal graphs (arXiv 2501.13956, github.com/getzep/graphiti), MemGPT/Letta, Nous Hermes Agent, LongMemEval (arXiv 2410.10813), LongMemEval-V2 (arXiv 2605.12493), LoCoMo (arXiv 2402.17753), MemoryAgentBench (github.com/HUST-AI-HYZ/MemoryAgentBench).

---

## 1. Verification of the source report (scout pass, web, 2026-07-25)

The report survived spot-checking almost intact — 7 CONFIRMED, 2 PARTIAL, 0 NOT-FOUND:

| # | Claim | Verdict |
|---|---|---|
| 1 | Graphiti bi-temporal edges (t_valid/t_invalid + t_created/t_expired), 3 subgraphs, invalidate-don't-delete | CONFIRMED — arxiv.org/abs/2501.13956 |
| 2 | HippoRAG neocortex/PHR/hippocampus + Personalized PageRank; 6–13× vs IRCoT | CONFIRMED (speed figure is from HippoRAG 1, NeurIPS'24) — arxiv.org/abs/2405.14831 |
| 3 | Hermes Agent MEMORY.md ~2,200 chars / USER.md ~1,375 chars, SQLite FTS5 | **PARTIAL** — budgets exact, but injection is a **frozen snapshot at session start**, not per-turn (deliberate prefix-cache preservation) — hermes-agent.nousresearch.com docs |
| 4 | LongMemEval ICLR 2025, 500 Qs, ~115k-token histories, 5 abilities | CONFIRMED — arxiv.org/abs/2410.10813 |
| 5 | LongMemEval-V2 (2026), 451 Qs, 500 web trajectories, LAFS metric | CONFIRMED — arxiv.org/abs/2605.12493 (WIP paper) |
| 6 | MemoryAgentBench four axes incl. "selective forgetting" | **PARTIAL** — fourth axis is **Conflict Resolution** (latest-valid-fact-wins under contradiction), not selective forgetting |
| 7 | LoCoMo multi-session dialogue benchmark | CONFIRMED — arXiv 2402.17753 |
| 8 | MemGPT/Letta core/archival/recall tiers, self-directed paging | CONFIRMED |
| 9 | OpenClaw runtime + TencentDB plugin metrics (WideSearch 33→50%, −61.38% tokens, SWE-bench 58.4→64.2) | CONFIRMED as **vendor-reported** in Tencent's README |

Both PARTIAL corrections *increase* relevance to omp-squad: Hermes's frozen-snapshot injection is exactly the prefix-stabilization discipline the report preaches, and Conflict Resolution as a benchmark axis is precisely the gap found in room-threads (§3, Concept 2).

## 2. Target ground truth (verified in-repo, 2026-07-25, main @ 21a8a54b)

- The tencentdb brief's Ranks 1–5 (async decisions consolidation, typed traceable facts + conventions.md, retention guards, transcript spill, hardening bundle) **never shipped** — `fabric.ts:438` still appends `f.decisions ?? []` with zero dedup; no consolidation/retention/conventions modules exist in `src/`.
- Standing constraints unchanged: daemon never touches a child agent's live context window (turn-boundary only); no vector/embedding infra by design (BM25/lexical only); DIRECTION.md sequencing law — the-room is the foundation, love-gated; room-threads must not start batch 3 before the love-gate verdict.
- Named bottleneck: **the room love gate** (plans/the-room/23). Room-threads is the sanctioned successor surface; its differentiation is "cards are proofs, not agent self-reports."
- Useful substrate that already exists: lifecycle-truth (closed) shipped a guarded single write-path for AgentStatus with a declared transition table and persisted `{from,to,reason,at}` history — the natural attachment point for supersession semantics.

## 3. Strategist — ranked delta concepts (fable)

Ranked against the named bottleneck: room-threads shipping as a *trustworthy* state surface. Concepts that protect "cards are proofs" outrank cleverer ones. Everything below is **borrow the pattern**; the one adopt-the-dependency candidate (Graphiti) is rejected in §5.

### Rank 1 — Worker-exit/summary-write ordering (the orphaned-state failure mode)

**Pattern**: When an isolated worker's context is destroyed at exit, any state not yet committed to the durable store is permanently orphaned; the parent resumes with a stale world-view. The mitigation is ordering: the upward-summary write is part of the exit path itself, and abnormal exits are detected and repaired from durable exhaust.
**Mechanism**: Treat every worker terminal transition — including crash/kill/adopt-loss — as a summary-regeneration trigger, not just clean settling. A sweep detects nodes whose worker vanished without a frozen upward summary and regenerates one from the daemon-side exhaust (receipts, transcripts, gate logs), marked as reconstructed-post-mortem so it reads as evidence, not self-report.
**Value for omp-squad**: This is the sharpest genuinely-new finding. Concern 06 freezes the upward summary into after-action **on settling**; nothing owns "subagent died before its upward summary regenerated." DESIGN.md's "live compaction is unsolved" risk is the soft version — the report's version is harder: the target *vanishes* before any summary exists. omp has a structural advantage the report's subject systems lack: the daemon owns the exhaust (`receipts/<agentId>.jsonl`, transcripts, gate logs) outside the worker's context, so orphaned state is *recoverable* — but only if something is charged with recovering it.
**Where it applies**: `src/after-action.ts`, `src/squad-manager.ts` (finalizeRun + abnormal-exit paths), `src/nodes.ts` (room-threads 01, `settledAt` + terminal states), the existing orphan-sweep lineage (never-lose-work 04 / daily-turn-substrate).
**Build vs Buy**: Build — it's an ordering rule plus a sweep over stores that already exist.
**Concretely**: amend room-threads **06** (add abnormal-exit regeneration trigger + a verify bullet: "kill a worker mid-run; its node still gets an upward summary, sourced from receipts, marked reconstructed") and **02** (a worker death is escalation-grade).

### Rank 2 — Escalation conflict rule (temporal disagreement between parallel workers)

**Pattern**: When parallel workers assert contradictory state about the same subject, a non-temporal store surfaces both with equal confidence and the reader picks arbitrarily. The fix is supersession semantics at write time: a new assertion that contradicts a prior one *invalidates* it (records it superseded) rather than coexisting with it.
**Mechanism**: Escalation-grade facts on a node carry `supersedes`/`supersededBy` links stamped at write time through the single-writer path (the manager), reusing lifecycle-truth's transition-table shape. A superseded card stays addressable (never hard-deleted) but renders as history, never as current state. Multi-homed nodes (07) report *one* current state to all parents by construction, because current-ness is decided at the node, not at each parent's view.
**Value for omp-squad**: Concern 02 has escalation-only upward flow but **no rule for two simultaneous conflicting escalations**; concern 07's DAG multi-homing makes divergent parent views structurally possible. For a product whose differentiation is "cards are proofs," two live contradictory proofs is the worst-case failure — it's E_contradiction rendered in the UI. MemoryAgentBench making Conflict Resolution a top-4 benchmark axis independently confirms this is a first-class failure mode, not an edge case.
**Where it applies**: room-threads **02** (escalation addressing), **07** (multi-homed state view), `src/nodes.ts` state, card refs.
**Build vs Buy**: Build — it's a field pair and a write-path rule, not a graph database.
**Concretely**: amend room-threads **02** with the conflict rule and a verify bullet ("two conflicting escalations from siblings → exactly one current, one superseded-but-addressable"), and **07**'s verify ("a two-parent node shows the same current state from both parents").

### Rank 3 — Supersession/validity windows for durable facts (bi-temporal borrowed light, Graphiti's idea without Graphiti)

**Pattern**: Never hard-delete a superseded durable fact; append the replacement with its own valid-from and stamp the old one valid-to/superseded-by. Point-in-time reconstruction ("what did the fleet believe at T?") becomes a filter, and E_anachronism (acting on a stale fact) becomes detectable instead of silent.
**Mechanism**: Extend the fabric's decision/fact records (JSONL, append-only — already the right substrate) with `validFrom`/`validTo`/`supersededBy`. The cold-start primer filters to currently-valid facts; the full history stays auditable. This *upgrades* the never-shipped tencentdb Rank 1 consolidation: consolidation becomes supersession (old fact closed, new fact opened, link kept) instead of merge-and-lose, which also de-risks that plan's own named risk ("LLM merge loses a real distinction").
**Value for omp-squad**: omp's institutional memory already works by supersession informally — DIRECTION.md amendments, plans "closed with a pointer," glance-desktop "superseded" — but the *machine-consumed* fact store has no such semantics, so every cold-started agent's primer can still serve stale decisions with full confidence. This is the report's central "vector soup" failure translated to omp's lexical world: BM25 returns the obsolete and the current decision with equal rank, same as cosine similarity would.
**Where it applies**: `src/fabric.ts` (FabricDecisionFact schema + primer filter), the tencentdb brief's Rank 1/2 recommendations (fold in, don't duplicate), after-action records as the frozen historical layer.
**Build vs Buy**: Build. **Adopting Graphiti is rejected** — see §5.
**Concretely**: this belongs to the fabric/institutional-memory lane, not room-threads itself; fold into the tencentdb brief's plan slice when that work is picked up.

### Rank 4 — Hard token budget + frozen-snapshot injection for the downward summary

**Pattern**: The always-present context block gets a strict numeric size ceiling (Hermes: ~500–800 tokens per file, ~3,500 chars total) and is injected as a snapshot frozen at session start, so it never churns the prompt prefix mid-session; freshness arrives at the next spawn, not mid-flight.
**Mechanism**: Give concern 06's downward (inherited-context) summary an explicit budget enforced at generation time — regeneration must fit the cap or tighten itself, references-not-restatement doing the compression. Inject at worker spawn via the existing `appendSystemPrompt` primer path (already the stable prefix); never rewrite it mid-session.
**Value for omp-squad**: Concern 06 says the downward summary is "small" but pins no number; unbounded "small" is how summary bloat starts. The corrected Hermes finding (frozen at session start, deliberately, for cache) matches omp's spawn-time primer mechanism exactly — omp is already on the right architecture and just needs the budget made explicit.
**Where it applies**: room-threads **06** (one sentence: a numeric cap + fit-or-tighten rule), `src/fabric.ts` `buildContextPrimer`.
**Build vs Buy**: Build — one constant and one generation-time check.

### Rank 5 — Eval import: the error taxonomy + checkpoint protocols as test vocabulary

**Pattern**: Score memory correctness with named failure classes (E_constraint, E_contradiction, E_hallucination, E_abstraction, E_anachronism, E_pollution) and resume checkpoints (short/medium/long interval with forced restarts), instead of generic accuracy.
**Mechanism**: Adopt the taxonomy as test-naming vocabulary for verify bullets that already probe these classes unnamed: 06's "poisoned turn disappears on regeneration" is E_pollution recovery; 02's lane-separation tests are E_pollution prevention; Rank 2's conflict tests are E_contradiction; Rank 3's stale-primer test is E_anachronism. Add one cheap harness shape: restart-resume checkpoints with an injected clock (concern 04 already injects the clock) — kill the daemon, cold-boot, assert node summaries/ranking/current-state survive.
**Value for omp-squad**: Fits the proofs-not-self-reports culture and the reality-audit/make-it-work practice — it turns "memory works" from a vibe into six named, testable failure classes. Protocols 2 (constraint retention under compaction) and 4 (drill-down from summary to exact raw token) map almost verbatim onto concern 06's verify section; protocol 3 (contradiction/invalidation) is the test for Ranks 2–3.
**Where it applies**: room-threads verify sections (02, 04, 06, 07), tests/.
**Build vs Buy**: Build — it's vocabulary plus a handful of tests.

## 4. Convergence findings (validation, not delta — worth recording)

- Concern 06's "reference, never duplicate" + "regenerate, never append" is **independently convergent** with the report's summary-drift mitigation (deterministic drill-down pointers, node_id/result_ref). Two lineages, same conclusion — strong signal the design is right.
- Concern 04 (state picks the region, score only orders within it; needs-you never scored) is the report's precision-at-K-over-recall principle, already applied.
- Concern 02's escalation-only upward flow is E_pollution prevention by construction; DESIGN.md's "propagating everything rebuilds the firehose one level up" is the same law the report states as cross-worker pollution.
- The sub-agent handoff 3-stage lifecycle (task manifest down → isolated execution → structured summary up, never the raw trace) is room-threads' "up carries events, down carries context" — already decided. The report adds only the exit-ordering gap (Rank 1).
- The report's own mutation-discipline warning cuts against Hermes-style free in-place LLM editing of core files: concern 06's deterministic regenerate-from-history is the drift-proof variant. Keep regeneration; borrow only the budget.

## 5. CUT (recurring or newly rejected)

- **Graphiti/Zep as a dependency** — the one real adopt-candidate, rejected: graph DB + LLM entity resolution + triple extraction ("high write overhead" by the report's own matrix) against a local-first, no-infra daemon whose graph is *declared* (`refs`, ownership, BLOCKED_BY), not inferred. Rank 3 takes the bi-temporal idea as two JSONL fields.
- **HippoRAG / PPR over an inferred KG** — a more sophisticated instance of exactly what room-threads DESIGN.md already cut ("we declare the graph; GraphRAG's value is inferring one"). Same category error, same verdict.
- **Hybrid retrieval + RRF + vector store** — re-proposed by the report as a "mandate"; the calculus from the tencentdb brief is unchanged (BM25-favorable identifier corpus, no vector infra, unproven ROI). Still cut.
- **MemGPT/Letta paging + "dynamic sliding window with prefetching"** — both require acting inside/before the model's live generation; blocked by the turn-boundary hard constraint. Only the "Core Memory" terminology maps (≈ 06's downward summary).
- **Mermaid in-window symbolic canvas** — same constraint, same verdict as the tencentdb brief (Rank 4 residue only).
- **Consensus engines for shared mutable sub-agent graphs** — presupposes a shared durable graph substrate omp doesn't have and doesn't want; Rank 2's single-writer supersession through the manager is the omp-shaped answer to the same problem.

## 6. Sequencing note (against DIRECTION.md law)

Ranks 1, 2, 4, 5 are **amendments to room-threads concern docs** (02, 06, 07 + verify sections) — design-level edits to the sanctioned foundation plan, costing sentences now and preventing rework later; they respect the "no batch 3 before the love-gate verdict" hold since 01 hasn't landed. Rank 3 belongs to the fabric/institutional-memory lane (the never-shipped tencentdb slice) and should fold into that plan whenever it's picked up — not open a new one. Nothing here proposes new surface area beyond the room.

---

## Addendum 2026-07-25 (evening): HumanLayer "context shards" transcript

Read in full (YouTube rTn8Vhdt-Jo, Dex/HumanLayer + Vaibhav/BAML live spec session) — notes and
mapping in [CONTEXT-SHARDS-NOTES.md](CONTEXT-SHARDS-NOTES.md). One genuinely new pattern for the
fabric lane: **frequency-gated promotion with citation receipts** (a fact earns primer placement
by recurrence across sessions/users, carrying `citations[{who, quote, context}]` as evidence) —
it composes with, rather than replaces, the supersession semantics (recurrence promotes,
contradiction supersedes). Also new: dismiss-as-snooze with re-evidence expiry. Strong practice
convergence on: additive memory sets rot (their CodeRabbit complaint = our unbounded-growth
pole), decay-out-unused, deliver triage to the existing inbox (the room, for glance), and
supervisor-as-small-structured-inference-pipelines.
