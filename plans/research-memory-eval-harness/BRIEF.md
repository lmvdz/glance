# Research Brief: "Concrete Evaluation Harness for Long-Horizon Agent Memory" → the ledger validation program

**Date**: 2026-07-26
**Target**: the agent-memory-ledger lane — [VALIDATION.md](../research-long-horizon-agent-memory/VALIDATION.md) specifically, plus glance's live primer (`src/fabric-search.ts` `buildContextPrimer`).
**Question**: what does this harness spec add beyond VALIDATION.md's existing program, and what should fold in.
**Source**: user-supplied pre-extracted deep-research artifact (no bibliography; inline `[cite: N]` markers unresolved). Condensed structural preservation at [SOURCE-REPORT.md](SOURCE-REPORT.md) (full prose in the 2026-07-26 conversation record; deliberately not copied verbatim — the bulk is echo, per §0).

## 0. Provenance warning — echo vs delta

This report is **substantially derived from our own published position**: L0–L3 layering, frozen-at-spawn primers, single-writer supersession, regenerated-vs-accreted summaries, exclusion-vs-soft-labeling, died-without-summarizing recovery, drill-down pointers, and the six base error classes are our vocabulary, returned by a generator that evidently ingested POSITION.md/VALIDATION.md (its five ablations MEM-ABL-01..05 are C2, C9, C8, C7, and C2/C6 restated). **None of that echo counts as external validation** — importing it back would be laundering our own claims through a third party. This brief extracts only the genuine delta. Additional cautions: the "dashboard" section presents invented observed values (TSR 86.6%, divergence step 18.4, etc.) formatted as if a run occurred — illustrative fiction, not evidence; and several citation names are unverified against primary sources ("LoCoMo-Plus", "T-Mem", "xMemory", the "E-P-R" Entry-Propagation-Recovery phase naming) — LOW-CONFIDENCE labels; MemTrapBench itself is real (verified 2026-07-26 in the compliance-trap full text, which reports RCR/DPC metrics — the E-P-R framing did not appear in the sections we read).

## 1. The genuine delta (ranked, strategist pass)

Ranked against the lane's named next-work: VALIDATION says **harness first**, and glance's primer is live in production today.

### Rank 1 — State-region partitioned primer (pinned governance, ranked remainder)

**Pattern**: The active set is allocated by *region*, not by one relevance ranking: Region 1 = governance/active constraints, pinned unconditionally; Region 2 = current task state and settled decisions, pinned; Region 3 = episodic context, filled top-k with whatever budget remains. The failure it prevents is structural: "DO NOT MODIFY PRODUCTION TABLES" has near-zero lexical/semantic overlap with the query that violates it, so any pure ranking eventually evicts the constraint for chatter.
**Why this is the top rank**: it names a **live gap in glance today**. `buildContextPrimer` is pure BM25 top-6 — a recurring-failure "Do not repeat:" line and an active constraint compete in the same ranking as episodic digests, and lose exactly when the spawn query doesn't resemble them. Our own position says "must-see items surface by state, never by score" (L3) — the room's decay ranking honors that, the primer does not. This is the position's own rule, unapplied at its most consequential injection point.
**Where it applies**: `src/fabric-search.ts` (`buildContextPrimer` — partition: failure/constraint-class facts pinned, currently-valid decisions pinned up to a sub-budget, ranked remainder), tests.
**Build vs Buy**: Build — a partition rule over the existing fact types, no new infra.

### Rank 2 — Score the over-conservatism direction: E_gov_halt + the FCR/FSR pair

**Pattern**: Constraint retention is scored in BOTH directions: False Continue Rate (acted despite an active restriction) and False Stop Rate (refused a valid action citing a revoked/non-applicable restriction). An architecture that never breaches but constantly spuriously halts is also broken.
**Why it matters to us**: our taxonomy has no over-conservatism class, yet the compliance-trap paper's own mitigation data showed exactly this trade ("verify before acting" cut damage 17.2pp but cost 11.0pp helpfulness — uniformly less compliant). Without E_gov_halt, a memory system can game our harness by refusing. This also pairs with room-threads' needs-you philosophy: a spurious halt is a needs-you card that shouldn't exist.
**Where it applies**: VALIDATION.md taxonomy (+1 class) and the harness's constraint probes (each probe set must include revoked-constraint tasks, not just active-constraint tasks).

### Rank 3 — Divergence step + sustained-compliance observation (O_delayed)

**Pattern**: Score *where* a resumed trajectory first deviates from ground truth (S_div), and keep scoring for N steps after resume — not just the first action. The compliance trap propagates; first-action-correct is not resumed-correctly.
**Where it applies**: VALIDATION.md instrument spec (resume checkpoints gain a divergence-step measurement and an N-step post-resume window); glance replay driver when built.

### Rank 4 — Disruption operators as a named, schedulable vocabulary

**Pattern**: COMPACT, SPAWN_EXIT_HANDOFF, MID_TASK_KILL, CONTEXT_WIPE, TIME_JUMP(d), CONTRADICTION_INJECT, AUTHORITATIVE_CONSTRAINT as deterministic operators a scheduler composes per scenario — instead of prose descriptions of probes. Makes scenarios declarative and the harness's coverage enumerable ("which operators × which seams have we exercised?").
**Where it applies**: VALIDATION.md instrument spec; the eventual `tests/` harness gets an operator enum rather than ad-hoc probe code.

### Rank 5 — Zero-tolerance classes + vector scoring rule

**Pattern**: The run score is a vector, never an average, and named classes are zero-tolerance (a single governance breach or lost-identifier failure fails the run regardless of aggregate success). We already reject aggregate accuracy; the zero-tolerance rule is the enforcement mechanism that stops a future dashboard from re-aggregating.
**Where it applies**: VALIDATION.md scoring rules; CI gating when the harness lands (their "build kill-switch on C_gov_breach > 0" maps to glance's gate culture directly).

### Rank 6 — Secondary metrics formalized: R_step, N_re-dec

Step re-execution rate and decision re-derivation count as computed metrics with denominators, not just production counters. Cheap; folds into the production-adjudication section. (K_tok token overhead is already implicit in our C4 economics; H_int is glance's needs-you lane by another name.)

### Noted, not imported

- **Task-corpus properties** (identifier-preservation tasks, supersession mid-workflow, active bounds) — good checklist for authoring glance replay scenarios; the 15 scenario blueprints themselves are generic-enterprise flavored and mostly don't fit glance's domain, but SCEN-05 (CI flaky-test triage), SCEN-09 (partial migration + kill), and SCEN-13 (parallel workers sharing infra state) are directly translatable to fleet scenarios.
- **IMemoryAdapter interface** — its five methods map 1:1 onto glance's existing seams (receipts append = ingest_raw_event; after-action freeze = commit_checkpoint; buildContextPrimer = query_primer_context; recordAgentDecision supersession = resolve_fact_conflict; receipt/transcript lookup = drill_down_to_raw). Useful as evidence the seams are right; adopting the interface itself matters only if the harness ever tests foreign backends — not a current goal.
- **The governance-persistence scenario shape** (revoke-during-idle → T+1w resume → tempted action) — the single best probe design in the report; becomes a scenario in the harness regardless of the rest.

## 2. What this does NOT change

- The echo content (ablations = C2/C7/C8/C9, frozen primer, single-writer, exclusion) — already ours, already pre-registered; no circular import.
- No evidence claims adopted: the dashboard numbers are fictional; unverified benchmark names stay LOW-CONFIDENCE.

## 3. Recommended disposition

Amend, don't plan: (a) VALIDATION.md — add E_gov_halt (+E_drift/E_orphan promoted to named classes for counter parity), FCR/FSR, divergence step + O_delayed window, the operator vocabulary, and the zero-tolerance scoring rule; (b) file the primer state-region partition as the next code unit in the fabric lane (it is a production gap today, same size class as the supersession PR); (c) fold the governance-persistence probe into the harness scenario list.
