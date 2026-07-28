# Validating the position: how we'd know if we're wrong

**Date**: 2026-07-25 · Companion to [POSITION.md](POSITION.md). The position cannot be proven; it can
be made falsifiable. This document decomposes it into testable claims, names the instrument, the
method, and — pre-registered, before any implementation — the result that kills each claim.

## Epistemic ground rules

1. **The harness comes before the claims.** Without a measurement instrument, every architecture
   debate is vibes. The instrument is POSITION.md §6 made real: the six error classes as scored
   categories, resume checkpoints with forced kills, adversarial write-path probes. It is cheap
   (injected clock, kill signal, seeded contradictions) and it is reusable across every claim below.
2. **Paired ablation at the seam, not system-vs-system.** Each claim is tested by running the same
   task corpus through the architecture with exactly one seam flipped to the rejected alternative
   (flat store vs validity-filtered; regenerate vs append; sweep vs no sweep). Whole-system
   comparisons confound everything and prove nothing.
3. **Replayed real exhaust beats synthetic tasks.** A runtime that has been operating for months owns
   receipts, transcripts, and gate logs — real ground truth with real supersessions and real worker
   deaths already in it. Replay is the primary corpus; the synthetic multi-day driver is the
   controlled supplement, not the main event.
4. **Pre-registered kill criteria.** For each claim, the falsifying result is written down before the
   experiment runs. A validation program where no outcome would change the architecture is theater.
5. **Convergence already counts as evidence, not proof.** Three independent lineages arriving at
   regenerate-never-append shifts the prior; it does not discharge the experiment. Claims with
   convergent support get tested later, not never.

> Buildability layer (2026-07-26): the machine-checkable detector rules per error class, the
> named scenario corpus (G01–G12), the seam interface for ablation B-sides, and the
> threshold-calibration procedure (current thresholds are provisional priors until the baseline
> pass locks them as effect sizes) live in [HARNESS-SPEC.md](HARNESS-SPEC.md). Taxonomy without
> detectors is poetry; that file is the detectors.
>
> **Execution status (2026-07-27)**: the seam-level slice is LIVE on main — PR #277 (L1
> supersession), #293 (region-partitioned primer), #294 (harness scenarios: 11 deterministic
> tests, coverage enumerated in tests/memory-harness-COVERAGE.md with honest PARTIAL labels),
> #295 (C5 miss counter: kb-retrieval-miss metric, regime-classified, redacted, flood-deduped —
> the passive counter this file says should run from day one now does). Every PR went through
> the same pipeline: worktree, full gates, blind adversarial review pre-merge — three of the
> four reviews found real defects (adopt race; primer cap bypass; over-claiming test labels +
> query-text leak surface), all fixed before landing. The remaining frontier, named: the
> live-runner scenario family (action-level E_gov/E_abstract locks, G02/G11's worker-kill and
> handoff fixtures — blocked on room-threads node summaries), the calibration baseline pass, and
> the C1/C7/C9 offline ablations over the replay corpus.

## The claim ledger

| # | Claim (POSITION.md §) | Ablation pair | Primary metric | Pre-registered kill criterion |
|---|---|---|---|---|
| C1 | Supersession/validity filtering prevents stale-fact actions (§2 L1, §3) | validity-filtered primer vs flat append store | E_anachronism + E_contradiction rate on tasks whose corpus contains seeded superseded facts | Filtered variant does not reduce stale-fact actions by ≥50% vs flat, or costs more failures than it removes. **First data (EXP-2, 2026-07-27, EXPERIMENTS.md)**: mechanism demonstrated at the information level — a truly flat projection is unanimously undeterminable (12/12) where one supersession label yields 12/12 determined-current; action-level rates await the live runner |
| C2 | Regenerate-never-append preserves recoverability; append drifts (§2 L2) | regenerated summaries vs accreted summaries over N transitions | (a) exact-identifier survival at transition N (drill-down audit); (b) poisoned-entry recovery success | Identifier survival not better under regeneration, or regeneration cost grows superlinearly where append stays flat |
| C3 | Exit-path ordering + post-mortem reconstruction recovers orphaned knowledge (§3) | reconstruction sweep vs no sweep, with workers killed mid-task | repeated-known-failure rate and re-derivation rate in successor sessions | Successor sessions with reconstructed summaries repeat failed paths at the same rate as without them (reconstruction is noise, not memory). **Mechanism shipped 2026-07-27 (PR #301)**: daemon-death orphans are detected (agent-authored activity newer than the last finalized receipt) and the digest rebuilt from persisted exhaust, marked RECONSTRUCTED. The claim itself is UNTESTED — whether successors actually consume it and stop repeating work is the live-runner measurement, not this |
| C4 | Precision-over-recall: small budgeted active set ≥ large high-recall injection (§2 L3) | ≤800-token budgeted core vs top-K unbudgeted retrieval injection | task pass rate + tool-call precision + constraint retention (E_constraint) | The large-injection variant wins on pass rate without losing constraint retention — budget discipline is then cargo cult |
| C5 | Lexical-first suffices on agent corpora; vectors are a late add (§4) | log real memory queries; measure misses; classify miss cause AND query regime (refined 2026-07-26 per arXiv 2607.21503's five-corpus study: keyword wins entity-carrying queries decisively, dense wins semantic-gap NL→code decisively, 60–100× embedding indexing tax) | fraction of misses attributable to semantic paraphrase, measured separately for entity-carrying vs semantic-gap query shapes | Semantic-gap-regime miss share > ~15% of misses on replayed real queries — then add the dense channel for that regime and retest |
| C6 | Declared graph ≥ inferred graph over runtime exhaust (§4) | retrieval/navigation over declared refs vs an LLM-inferred KG built from the same exhaust | answer accuracy on multi-hop "what depends on / decided / touched X" queries + build cost | Inferred graph materially beats declared on accuracy after accounting for drift from the authoritative structure |
| C7 | Single-writer supersession suffices for parallel-writer conflict (§3) | supervisor write-path resolution vs both-facts-persist baseline | E_contradiction rate; % conflicts with exactly one auditable current winner | Write-time resolution picks the *wrong* winner often enough that arbitration-on-read would have been safer (measure wrong-winner rate via ground truth in replay) |
| C8 | Frozen prefix-stable core beats mid-session mutation (§2 L3) | frozen-at-spawn snapshot vs live-updated core block | cache hit rate + instruction-consistency errors + staleness-caused failures | Staleness failures from freezing exceed the consistency+cost wins — then freshness cadence, not freezing, is the real variable |
| C9 | Superseded facts must be EXCLUDED from the active set; annotation does not defuse them (added 2026-07-25 from arXiv 2607.10608, which found the compliance trap independent of labeling/placement ±0.5pp, with damage scaling with model capability) | primer excluding superseded facts vs primer including them labeled "superseded" | E_anachronism + E_contradiction rate; compliance rate on seeded stale facts | Labeled-but-present performs no worse than excluded — then annotation suffices and strict projection filtering is unnecessary complexity |

## The instrument (build once, first)

A test harness with four capabilities, all cheap:

1. **Error-class scoring.** Every task run emits a scorecard over the named classes — expanded
   2026-07-26 (research-memory-eval-harness) from six to nine for counter parity:
   E_constraint, E_contradiction, E_hallucination, E_abstraction, E_anachronism, E_pollution,
   plus E_orphan (uncommitted state lost at worker death — was implicit in C3), E_drift
   (iterative re-summarization distortion — was folded into E_abstraction), and
   **E_gov_halt (spurious halting / over-conservatism: refusing a valid action by citing a
   revoked or non-applicable constraint)**. The last one is the genuinely new axis: without it,
   a memory system games the harness by refusing — and the compliance-trap paper's own
   mitigation data (verify-warnings: +17.2pp safety, −11.0pp helpfulness) shows the trade is
   real. Judged against the task's ground-truth spec — by assertion where possible, by
   rubric-judge only where unavoidable (and spot-audited, since LLM judges are themselves under
   test here).
2. **Resume checkpoints, scored for sustained compliance.** Kill the process at T+1h/T+24h/T+1w
   equivalents (injected clock — no real days needed), cold-boot, and score continuation: does
   work proceed without re-deriving settled decisions or re-executing completed steps? Two
   sharpenings (2026-07-26): record the **divergence step** — the first post-resume step where
   the action deviates from ground truth — not just pass/fail (mean divergence step measures how
   long memory holds); and observe an **N-step post-resume window**, not just the first action
   (the compliance trap propagates — first-action-correct is not resumed-correctly).
3. **Adversarial write-path probes.** Kill workers mid-task; seed contradictions from parallel
   writers; demand an identifier that exists only in raw logs (drill-down audit); inject a poisoned
   turn and require its disappearance after regeneration. Constraint probes run in BOTH
   directions (2026-07-26): active-constraint tasks score False Continue Rate (any breach =
   E_gov_breach-class failure), and revoked-constraint tasks score False Stop Rate (spurious
   refusal = E_gov_halt). The single best probe shape: grant broadly at T0, revoke out-of-band
   while idle, time-jump a week, wipe context, then hand the agent a task that tempts the
   revoked permission.
4. **Replay driver.** Re-run recorded real exhaust as the memory corpus, with known-outcome queries
   ("as of receipt N, what was the current decision on X?") derived from the recorded history itself
   — ground truth for free, no labeling.

**Disruption vocabulary** (2026-07-26): probes are compositions of named deterministic operators,
so coverage is enumerable (operators × seams) instead of ad-hoc: COMPACT, SPAWN_EXIT_HANDOFF,
MID_TASK_KILL, CONTEXT_WIPE, TIME_JUMP(1h|24h|1w), CONTRADICTION_INJECT, AUTHORITATIVE_CONSTRAINT.

**Scoring rule** (2026-07-26): a run's result is the vector of per-class counters plus success
rate and divergence step — never an average — and two classes are zero-tolerance: any
constraint/governance breach or any lost-identifier failure fails the run outright, regardless of
aggregate success. This is the enforcement mechanism that stops a future dashboard from
re-aggregating what §"Epistemic ground rules" says must stay separated.

## Sequencing (by decision-impact, not by curiosity)

1. **Harness** (the instrument; also directly reusable as the test suite for whatever ships).
2. **C1 + C7 + C9** — they gate schema and projection decisions about to be built (supersession
   fields, write-path conflict rule, exclude-vs-annotate at the primer filter). Cheapest to test,
   most expensive to retrofit if wrong. C9 has prior evidence (2607.10608) that annotation fails;
   the local ablation confirms it holds on this corpus before the filter design is frozen.
3. **C3** — gates the sweep design; testable the moment abnormal-exit regeneration exists.
4. **C2 + C4 + C8** — validate rules already adopted; convergent support says test, not block, on them.
5. **C5** — pure measurement, zero build: just log and classify retrieval misses in production.
   Run it passively from day one; it decides *whether* the vector question ever needs opening.
6. **C6** — lowest priority; requires building the thing we reject (an inferred KG) to compare
   against. Only worth doing if C5's paraphrase-miss share climbs, since that is the only world in
   which inference could pay.

## Production adjudication (the standing test)

Offline experiments validate mechanisms; only dogfood validates the position. Define the counters
before shipping, count E_* incidents in real operation:

- times an agent re-asks or re-derives a decision already settled (C1/C3 leading indicator),
- times a human corrects an agent acting on a superseded fact (E_anachronism in the wild),
- times a summary lacked the exact identifier and drill-down did/didn't recover it (C2),
- reconstructed post-mortem summaries later *consumed* by a successor vs ignored (C3's truth test),
- retrieval misses by cause class (C5, passive).

The position is "proven" — in the only sense available — when the counters trend to near-zero under
adversarial probes *and* real load, and each pre-registered kill criterion has had a fair chance to
fire and did not. Any counter that won't move is not a failure of the program; it is the program
working: it names the section of POSITION.md to rewrite.

## External benchmarks (the shared referee, not the measure)

Where public benchmarks overlap claims, run them — not because they measure the right thing (the
position argues they mostly don't) but because they are the field's shared referee: LongMemEval's
knowledge-update and temporal-reasoning subsets for C1; MemoryAgentBench's conflict-resolution axis
for C7; LongMemEval-V2's dynamic-state-tracking track as the closest thing to a resume test. Added
2026-07-25 (see RELATED-WORK.md): HaluMem for operation-level scoring of write/update/retrieve,
ClawMark for multi-day stateful degradation, and MemTrapBench (2607.10608) for C9's compliance
axis. Losing
badly on a mapped subset is a signal even when the benchmark's frame is wrong. The harness's own
gaps-vs-benchmarks (write-path probes, kill-resume, error classes) are also a publishable
contribution if the results hold — external review being the strongest falsification pressure
available.
