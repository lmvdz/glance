# Long-horizon agent memory: the direction we believe is correct

**Date**: 2026-07-25 · Companion to [BRIEF.md](BRIEF.md) (project-specific mapping) and
[SOURCE-REPORT.md](SOURCE-REPORT.md) (verified source material). This document is the general
position, independent of any particular codebase. This markdown is canonical; the shareable
visual twin lives at https://claude.ai/code/artifact/4879ed9b-9f69-47f0-b560-51f8cd5a1640 and is
kept in lockstep.

## Thesis

Long-horizon agent memory is an **event-sourcing problem that the field has been treating as a
retrieval problem**. For two years the debate has been "which index" — vectors, knowledge graphs,
hybrid fusion — while the failures that actually kill multi-day agents are write-path and lifecycle
failures: facts that were superseded but never invalidated, workers that died before committing what
they learned, summaries that accreted drift until the original detail was unrecoverable, and active
contexts polluted by high-recall noise. Better retrieval over a corrupted, structureless store
retrieves corruption faster. The correct direction is a **ledger with regenerated projections**:
append-only ground truth at the bottom, typed facts with validity windows above it, summaries
rebuilt (never accreted) from those layers, and a small, hard-budgeted active set at the top.

## 1. Why flat similarity fails — and why it isn't really about vectors

"Vector soup" is correctly diagnosed but usually misattributed. The failure is not that embeddings
are imprecise; it is that **rank-by-relevance over an unstructured pool discards exactly the three
things a long-horizon agent needs**: temporal order (which of these came last), supersession (which
of these is still true), and provenance (what evidence produced this). BM25 over the same flat pool
fails identically — the obsolete decision and its replacement are both "relevant" and score
near-identically, and the model picks arbitrarily. Swapping the index does not fix a store that
cannot represent "this fact replaced that one." That is a schema problem, and schema problems are
solved at write time, not query time.

## 2. The architecture: a ledger with projections

The convergent shape — visible across TencentDB-Agent-Memory's L0–L3 pyramid, Graphiti/Zep's
episode-vs-entity split, MemGPT's tiers, and independently re-derived by working agent-runtime
teams — is four layers with strict rules about what may flow between them.

**Layer 0 — append-only exhaust, owned by the runtime, not the model.** Raw transcripts, tool
outputs, receipts, gate logs. Immutable, cheap to write, never destructively summarized. Everything
above this layer is a *derived view* and must be rebuildable from it. The critical ownership point:
this layer must survive the death of any individual context window, which means the **runtime**
(daemon, supervisor, harness) writes it as a side effect of execution — it is never something an
agent remembers to do.

**Layer 1 — typed facts with validity windows.** (Sharpened 2026-07-25 with the entry rule:
**recurrence promotes, contradiction supersedes**. A fact earns promotion into the durable store
by being observed repeatedly — across sessions, ideally across workers — carrying citations back
to the evidence, not by a single model's in-the-moment decision to remember. The trade is
deliberate: a lagging memory that is never useless beats an eager one that fills with noise.
Source: HumanLayer's context-shards design session, CONTEXT-SHARDS-NOTES.md. Amended 2026-07-26
after red-team: promotion is **evidence-gated**, and recurrence is one kind of evidence — the
default for model-observed patterns. A directive from an authorized human is sufficient evidence
on its own: "always do X" arrives once, promotes immediately at full weight, and is revocable
only by supersession. Without this channel a recurrence-only gate systematically under-remembers
commands. The gate that must never open: a model's own claim of authority — model-observed facts
always take the recurrence path.) The single most transferable idea in the current
literature is Graphiti's bi-temporal semantics: every durable fact carries when it became true and
when it stopped being true, and contradiction **invalidates rather than deletes**. A superseded fact
gets a closed validity window and a pointer to its successor; nothing is ever hard-deleted; "what
did the system believe at time T" becomes a filter rather than an archaeology project. Crucially,
**the semantics do not require the machinery**. Zep implements this with a graph database, LLM
entity resolution, and triple extraction — heavy, high-write-cost infrastructure justified for a
multi-tenant memory platform. For a single runtime, the same semantics are two fields on an
append-only log (`validTo`, `supersededBy`) and a write-path rule. Adopt the idea; skip the
database.

**Layer 2 — summaries as regenerated projections, never accreted logs.** Three independent lineages
— TencentDB's traceable atoms, session-handoff practice in working agent teams, and the
summary-drift analysis in the research literature — arrive at the same three rules, which we regard
as settled:

1. **Regenerate, never append.** A summary is rebuilt from ground truth on each state transition,
   not grown by accretion. Append-only summaries have no recovery path: a bad turn becomes a
   permanent inheritance, and iterative re-summarization acts as a lossy low-pass filter that
   eventually erases the exact identifiers (flags, hashes, line numbers) the work depends on.
   Regeneration makes a poisoned entry recoverable — drop it from history and rebuild. (Added
   2026-07-26: regeneration is a *gated loop* — each result is checked for recoverability against
   a declared per-type list of must-survive-verbatim fields, and a failing compression is retried
   less aggressively, never shipped. Unvalidated compression has a measured cliff: one documented
   case dropped task accuracy 66.7%→57.1% when 18,282 tokens were crushed to 122 — arXiv
   2607.21503.)
2. **Reference, never restate.** A summary that quotes its sources is just the log again, and it is
   why naive summarization grows without bound. Point at the plan doc, the PR, the log line.
3. **Keep deterministic drill-down pointers.** Every abstraction must carry an address back to the
   raw evidence that produced it (record IDs, file paths, receipt lines). When the summary proves
   too abstract — and it eventually will — the exact token is one lookup away instead of gone. A
   memory system without drill-down converts every abstraction into eventual data loss.

To be precise about the claim (sharpened 2026-07-25): the position is **not** that context
reduction is harmful — lossy reduction measurably helps in some regimes, and hurts in others
(arXiv 2606.00408 maps an inverted-U over retriever strength × model capacity; the authors'
summary is that masking is safe when it removes what the model would not have used and unsafe when
it removes evidence it would have). Since which regime you are in is not knowable per-item in
advance, the claim is that **loss must be recoverable**: compact aggressively, but only over a
ground-truth layer that regeneration and drill-down can always reach back into. Recoverable
compaction gets the wins of both regimes; irreversible compaction gambles on being in the right
one.

**Layer 3 — the active set: small, budgeted, frozen, prefix-stable.** What actually enters the
prompt should be a hard-capped core (the Hermes Agent numbers — roughly 800 tokens of operational
memory plus 500 of user profile — are a sane anchor; the point is that a number exists and is
enforced at generation time) plus task-scoped context assembled at session start. Two disciplines
matter more than the exact budget:

- **Precision beats recall.** Injecting a dozen partially-relevant fragments to chase recall
  measurably degrades instruction-following and tool-calling. The active set should contain
  validated, currently-valid facts — and *must-see* items (blocked work, things awaiting a human)
  should be surfaced by **state, as a region, never by a relevance score**, because a score lets a
  chatty healthy item outrank a silent critical one.
- **Freeze per session for prefix stability.** Inject the core as a snapshot at session start,
  below static instructions, and do not rewrite it mid-flight; freshness arrives at the next
  session boundary. This is not merely a prompt-cache cost optimization (though byte-stable prefixes
  are what make caching work) — mid-session mutation of standing context is also how agents end up
  unsure which version of their own instructions they are following.
- **Authority is never frozen** (added 2026-07-26, resolving the urgent-revocation objection to
  freezing). The frozen prefix carries *knowledge*; *authority* lives at the action gate — the
  runtime layer that approves each tool call — which takes revocations effective immediately,
  out-of-band, and blocks the very next action regardless of what the context believes. The
  context catches up at the next turn boundary. Advice may go a session stale; permission cannot.
  A kill-switch that depends on rewriting a prompt was never a kill-switch.

## 3. Where memory is actually lost: the lifecycle, not the lookup

The empirically dominant failure modes in multi-agent, multi-day operation are not retrieval misses.
They are:

**The exit path.** A sub-agent's context window is destroyed at exit; anything not committed to the
durable store by then is orphaned forever, and the orchestrator resumes with a stale world-view,
repeating known-failed paths. The fix is structural, not behavioral: the summary/state write is part
of the exit path itself — *including abnormal exits*. Because Layer 0 is runtime-owned, a crashed
worker's knowledge is recoverable from its exhaust; a repair sweep should detect
died-without-summarizing and reconstruct a post-mortem summary from receipts and transcripts,
explicitly marked as reconstructed so it reads as evidence rather than self-report. A memory
architecture that only captures clean exits is a memory architecture for demos.

**Parallel writers.** Two workers observing different slices of a system will eventually assert
contradictory facts ("migration complete" / "migration rolled back"). A store without supersession
serves both at equal confidence — non-deterministic behavior laundered as retrieval. The research
frontier proposes consensus protocols over shared mutable graphs; we think that is the wrong
direction for a supervised fleet. **Route all durable writes through the single-writer supervisor
and resolve conflicts at write time with supersession semantics** — one current assertion per
subject, losers invalidated-not-deleted, history addressable. Consensus machinery is what you need
when there is no supervisor; if you have one, use it. (That this matters is no longer speculative:
conflict resolution is now a top-level axis in memory benchmarks.)

One caveat, added 2026-07-25: resolving the conflict at write time is necessary but not
sufficient. Agents adopt a conflicting memory at the first decision point where it appears,
regardless of how it is presented — arXiv 2607.10608 measured the effect as independent of
labeling and placement (±0.5pp across presentation conditions), with damage scaling with model
capability (−2.1pp on a weak model to −25.5pp on a strong one), and found that "verify before
acting" warnings make agents uniformly less compliant rather than selectively safer. The
consequence for projection: **superseded facts are excluded from the active set, not annotated.**
A superseded fact that still reaches the prompt with a "superseded" label is a live trap. The
claim is scoped to the action path (amended 2026-07-26): history stays addressable to any reader
that asks for it — a human auditing the record, or a model running a deliberate point-in-time or
"why did we believe X" query — but those historical reads belong in analysis contexts, never in
the context that acts next.

**Drift under compaction.** Covered by Layer 2's rules — the point worth restating is that
compaction failures are silent and compounding, which is why the recovery paths (regeneration,
drill-down) must be designed in from the start rather than retrofitted after the first
unrecoverable loss.

## 4. Retrieval: declared structure first, lexical first, vectors late

Two contrarian positions we hold with confidence:

**Declared graphs beat inferred graphs — when you have a runtime.** GraphRAG, HippoRAG, and their
descendants exist to *infer* structure from unstructured text, and they are good at it. But an agent
runtime is not an unstructured corpus: it already emits typed, entity-keyed structure natively —
task IDs, ownership, dependency edges, file references. Paying an LLM (plus entity resolution, plus
PageRank infrastructure) to re-derive a graph you already declared is a category error, and the
inferred copy will drift from the authoritative one. Inference layers belong where structure is
genuinely absent — ingesting the outside world — not over your own execution history.

**Lexical retrieval is underrated for agent corpora; vectors are a measured, late addition.** Agent
memory queries are dominated by exact identifiers — function names, flags, error strings, commit
hashes — which is BM25/FTS home turf and embedding-space quicksand. The "hybrid retrieval + RRF is
mandatory" position in the literature assumes a conversational/semantic corpus. Start lexical over
structured, validity-filtered stores; add a dense channel (and RRF is the right cheap fusion when
you do) only after logged retrieval misses prove semantic paraphrase is actually costing you.
Infrastructure should follow evidence, not fashion. (Sharpened 2026-07-26 by a five-corpus study
— arXiv 2607.21503: the split is regime-shaped, not tool-shaped. Keyword wins decisively where
queries carry specific entities (0.815 vs 0.614 on SciQ); dense wins decisively across wide
semantic gaps (0.914 vs 0.290 on NL→code); and embeddings carry a measured 60–100× indexing tax.
So classify logged misses by query regime — entity-carrying vs semantic-gap — and let the
semantic-gap share, specifically, decide whether the dense channel is earned.)

## 5. The control point determines the mechanism

A quiet source of bad borrowing: memory mechanisms assume a location for the intelligence, and they
do not transplant across locations. MemGPT's self-directed paging — the model issues calls to swap
its own memory tiers mid-generation — is correct **when the model is the runtime**. TencentDB's
in-window Mermaid canvas assumes a plugin living inside the agent's live context. A supervisor
architecture that acts only at turn and session boundaries cannot use either mechanism, and should
not try; its equivalents are spawn-time projection (assemble the active set when the worker starts)
and exit-time reconciliation (harvest state when it ends). Evaluate every published mechanism by
asking *where it assumes the control point is* before asking whether it works.

## 6. Evaluation: error classes and resume checkpoints, not QA accuracy

Benchmarks are converging on conversational QA over long histories, which measures the wrong thing:
whether an agent can *answer questions about* the past, not whether its memory lets the next session
*act correctly* — invoke the right tool with the exact flag, honor a constraint set days ago,
refuse a superseded instruction. The evaluation shape we endorse:

- **Score by named failure class**, not aggregate accuracy: forgotten constraint, contradicted
  decision, hallucinated memory, over-abstraction (lost identifiers), temporal anachronism (acted on
  a superseded fact), cross-worker pollution. Each class has a different architectural cause, so an
  aggregate score hides exactly the information needed to fix anything.
- **Force resume checkpoints**: kill the process, wipe live context, restart at T+1h / T+24h / T+1w,
  and score whether work continues without re-deriving established decisions or re-executing
  completed steps. Memory that only works within an unbroken session is a cache, not memory.
- **Test the write path adversarially**: kill workers mid-task (does their knowledge survive?),
  inject contradictions (does exactly one fact win, and is the loser auditable?), demand an exact
  identifier that only exists in raw logs (does drill-down reach it?).

These protocols are cheap — an injected clock, a kill signal, a handful of assertions — and they
catch the failure modes that QA-style benchmarks structurally cannot.

## 7. What we reject

- **Memory-as-a-platform (hosted graph/vector services) for single-runtime agents** — the semantics
  worth having (bi-temporality, supersession, provenance) cost two fields and a write rule locally;
  the platform costs network dependency, entity-resolution overhead, and a second source of truth.
- **Inference layers over self-generated structure** (GraphRAG/PPR on your own execution history).
- **Hybrid retrieval as a default mandate** — it is an optimization with a prerequisite (a proven
  semantic-miss rate), not a foundation.
- **Consensus engines for sub-agent memory** where a supervisor exists — single-writer supersession
  is simpler, auditable, and sufficient.
- **Unbudgeted "small" context blocks** — a size discipline without a number is not a discipline.
- **Mechanism transplants across control points** — in-window paging/canvases in supervisor
  architectures, and vice versa.

## 8. Honest open problems

Three things the field has not solved and we do not claim to have solved either. **Live compaction
of a moving target**: regeneration-on-transition sidesteps it for work with state boundaries, but a
genuinely continuous stream (a months-long standing goal with no settling points) still lacks a
principled compaction trigger. **Skill distillation without drift**: turning noisy successful traces
into reusable, parameterized procedures automatically — current summarization loses the exact
parameters that made the trace work, and manual curation does not scale. **Cross-runtime memory
trust**: when two independent agent systems share facts, provenance and validity semantics stop at
the boundary; nothing today lets a consumer distinguish "verified by their gates" from "their model
said so" — the proofs-not-self-reports property does not yet federate.

## Summary of the position

Build memory as an event-sourced ledger: runtime-owned append-only exhaust; typed facts that are
superseded, never deleted; summaries regenerated from ground truth with drill-down pointers, never
accreted; a small frozen budgeted active set surfaced by state, not score. Put the engineering
effort into the write path and the lifecycle — exit ordering, orphan recovery, single-writer
conflict resolution — because that is where long-horizon memory is actually lost. Retrieve
lexically over declared structure until evidence demands more. And evaluate with kill signals and
resume checkpoints, by named error class, because memory that cannot survive a restart is just a
long conversation.
