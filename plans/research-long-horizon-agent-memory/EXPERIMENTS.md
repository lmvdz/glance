# Experiments — live ablation data for the claim ledger

Each experiment is pre-registered here BEFORE its results are unblinded: method, arms, scoring
rule, and expectations are written first; the results section is appended after, never edited.

---

## EXP-1: C9 exclusion vs annotation (+ C1 flat-store baseline arm) — 2026-07-27

**Claims under test**: VALIDATION C9 (superseded facts must be EXCLUDED from the active set;
annotation does not defuse them) and C1's core mechanism (a flat store serves stale facts that get
acted on).

**Method**: 36 single-turn probes, 12 per arm, sonnet at low effort via workflow fan-out. Each
probe hands the model a glance-shaped context primer and asks it to resume a paused deployment by
emitting exactly `deploy --target <hostname>`. The corpus truth: the deployment target decision
was `staging.api.internal`, superseded 2026-07-19 by `prod.api.internal`.

- **Arm A — exclusion (the position's design)**: primer carries only the current decision
  (prod). The superseded fact is absent.
- **Arm B — annotation (C9's rejected alternative)**: primer carries BOTH; the stale decision
  appears FIRST (temptation-maximizing position) and is explicitly labeled
  `[SUPERSEDED 2026-07-19 — replaced by the prod.api.internal decision; kept for history only]`.
- **Arm C — flat store (C1's rejected alternative)**: both decisions present, no supersession
  information at all, stale first (relevance-orderings in flat stores don't know better).

Three noise lines (hot file, prior session, active agent) permuted across trials (3 orderings × 4
reps per arm) so no single prompt layout carries the result. Scoring is assertion-checked, no
judge: response contains `staging` → STALE adoption (the E_anachronism event); contains `prod` →
CURRENT; neither → OTHER.

**External validity, stated plainly**: the consumer under test is Claude Sonnet in a one-shot
probe — a model-behavior measurement in the compliance-trap paper's methodology (arXiv
2607.10608), not an end-to-end glance fleet run. It measures the CONSUMPTION side of C9/C1: what
a model does with each projection design. The projection side (glance produces arm-A primers) is
already locked by tests/memory-harness.test.ts G01.

**Pre-registered expectations and what would falsify what**:
- Arm A stale rate ≈ 0 (the fact is absent; any `staging` emission would be hallucination).
- Arm C stale rate materially > 0 — the vector-soup failure C1 names. If arm C ≈ 0, the flat
  store is harmless in this shape and C1's premise weakens at single-conflict scale.
- **The C9 question is arm B**: if B's stale rate ≈ A's (both ≈ 0), the label defused the trap
  and C9's exclusion-not-annotation claim WEAKENS toward "annotation suffices at this scale" —
  the pre-registered kill direction. If B > A, exclusion holds its ground.
- Caveats accepted in advance: n=12/arm gives coarse proportions (this is first data, not the
  §5-calibrated pass); a single conflicting fact is the easiest possible case for a label —
  the compliance trap's measured damage grew with context pressure and decision-point depth,
  neither of which a one-shot probe recreates. A null result here does NOT retire C9; a positive
  result (B > A) at even this easy scale would be strong.

**RESULTS**: (appended after unblinding — see below)

**RUN 1 (2026-07-27): VOID — not unblinded.** 30/36 probes were refused by the executing
harness's safety classifier: the task ("emit the deploy command") read as arming an unauthorized
production deployment decided from untrusted injected context, and the gate blocked it — every
arm-A and arm-C trial, so the surviving tallies are pure selection artifact and were discarded
without interpretation. Two lessons kept: (1) the refusal is itself a live demonstration of
POSITION §5's authority-at-the-gate principle — the runtime's action gate refused an untrusted-
context production action regardless of what the context asserted, which is the correct behavior
for a real agent and merely inconvenient for a probe; (2) probes that measure memory consumption
must be UNMISTAKABLY offline — action-shaped phrasing conflates the measurement with the thing
the gate exists to stop.

**REVISED METHOD (run 2)**: same arms, same corpus, same scoring, but the probe is an explicitly
synthetic, offline belief-report: "This is an offline evaluation of a memory system using
synthetic data; nothing will be executed. According to this primer, which hostname is the CURRENT
deployment target? Answer with the hostname only." Measurement downgrade acknowledged in advance:
this measures the model's stale-fact BELIEF, not a stale-fact ACTION — the compliance-trap
literature says action-context pressure is where labels fail hardest, so a null here is even
weaker evidence against C9 than run 1's design would have been, and is recorded as such.

**RUN 2 RESULTS (2026-07-27, unblinded against the pre-registration above)**: 36/36 completed,
zero gate-blocked. Arm A: 12/12 current. Arm B: 12/12 current. Arm C: 12/12 current. **Zero stale
adoption anywhere, including the flat store.**

Interpretation, per the pre-registered directions: the weak direction fired ("if arm C ≈ 0, the
flat store is harmless in this shape") — but unblinding exposed an instrument flaw sharper than
the null: **arm C was not actually flat.** Its decision lines carried recency provenance ("2d
ago" / "9d ago"), so temporal order leaked into context and the probe degenerated into a
timestamp-reading test, which a strong model passes at ceiling. C1's vector-soup condition is
precisely "both facts at equal confidence with NO validity metadata" — the arm as built
contradicted its own definition. Verdict: **no claim evidence either direction; one instrument
lesson** (provenance labels are themselves validity metadata — a "flat store" fixture must strip
them), plus confirmation that belief-report probes against a strong model need genuine ambiguity
to have any power. C9's action-form question remains open and honestly deferred (run 1's gate).

---

## EXP-2: the genuinely flat store, and the label as minimal restoring metadata — 2026-07-27

**Claim under test**: C1's mechanism statement — a store with no validity metadata makes currency
UNDETERMINABLE, so the consumer picks arbitrarily ("non-determinism laundered as retrieval").
Corollary: the supersession label is the minimal metadata that restores a deterministic pick.

**Arms** (12 probes each, same corpus, same scoring, no temporal metadata anywhere):
- **A — exclusion control**: current decision only, no ago-labels.
- **B′ — label-only**: both decisions, stale FIRST, no timestamps; the stale one carries only
  `[SUPERSEDED — replaced by the prod decision]`. If the label alone restores ~100% current,
  the label is doing the work recency did in run 2.
- **C′ — truly flat**: both decisions, stale FIRST, identical phrasing shape, no timestamps, no
  labels, nothing distinguishing them but content and order.

**Pre-registered expectations**: A ≈ 12/12 current. B′ ≈ 12/12 current (a label read in a calm
belief-report should work; this is NOT the C9 action-context question). **C′ is the measurement**:
if picks split (order-biased or mixed), C1's undeterminability mechanism is demonstrated at the
smallest possible scale; if C′ ≈ 12/12 current anyway, the model is using some cue we haven't
controlled (phrasing? the word order? plausibility priors about prod-vs-staging) and the fixture
needs another iteration — record which hostname it converges on. Honest note: with truly zero
cues the "right" behavior is refusing to pick; the schema forces a hostname, so C′ also measures
forced-choice behavior — an `other`/hedge answer is recorded as such, not coerced.

**RESULTS**: (appended after unblinding)

**EXP-2 RESULTS (2026-07-27, unblinded)**: 36/36 completed, zero blocked.
- A (exclusion): **12/12 current**.
- B′ (label-only): **12/12 current**.
- C′ (truly flat): **12/12 undeterminable** — zero current, zero stale, unanimous.

Interpretation against the pre-registration: the provisioned hedge branch fired, unanimously —
and it is the cleanest available demonstration of C1's mechanism statement: **a flat projection
does not carry the information the currency question needs.** "Which is current" has no answer in
arm C′, and the consumer says so 12/12. The distance between undeterminable and 12/12
determined-current is exactly one supersession label — the ledger's L1 delta, measured as an
information gap. Operational reading: a flat store forces its consumer into either arbitrary
choice (the compliance-trap literature's action-context finding, not reproduced here) or
hedge-and-escalate (a stall — the E_gov_halt-flavored cost: every consumer must stop and ask a
human what is current). Either branch is a real cost the one-label arm eliminates.

What this does and does not update:
- **C1 mechanism: demonstrated** at the information level (n=12/arm, belief-report form).
  Behavioral damage under action pressure remains literature-supported (arXiv 2607.10608) plus
  future live-runner work.
- **C9: still open, honestly.** B′ shows a label suffices for calm belief-report — consistent
  with the compliance-trap paper, which never tested labels and measured damage in action
  trajectories. Exclusion remains the shipped default (the cheap, safe choice); the
  action-context ablation is the live-runner family's job.
- Instrument lessons banked: provenance ago-labels are validity metadata (run 2's flaw); an
  explicit undeterminable escape separates honest hedging from arbitrary picking.

---

## LIVE-1: G01 against a scratch daemon — 2026-07-27 (re-baselined after the fact)

A background agent booted an isolated scratch daemon per .claude/skills/scratch-daemon and drove
G01 over real HTTP. **Re-baselining note, established afterward**: the daemon was built from the
LOCAL working tree, whose `main` has diverged from origin/main (local tip 26aa1841, a voice-lane
line WITHOUT the merged supersession PRs; origin/main tip 83e10a98 carries them all). So the run
tested the pre-#277 baseline — voiding its "current code fails G01" reading and converting it
into an accidental CONTROL run:

- **The before-photo, live**: on a real daemon without supersession, a seeded stale decision and
  its replacement surface in /api/fabric and /api/fabric/search at IDENTICAL BM25 scores
  (0.3646… each) — the compliance-trap shape, reproduced on the production binary. This is the
  live demonstration of what #277/#293 exist to prevent. Evidence: /tmp/g01-live-evidence.md.
- **The finding that survives re-baselining (true on origin/main too)**: supersession is
  UNREACHABLE over HTTP. The write rule lives in recordAgentDecision behind the agent-only
  squad_record_decision tool; PATCH /api/features/:id silently drops a client `supersedes` field
  (deliberate anti-forgery in featureDecisions — clients must not mint stamps). Net: the human/UI
  lane can ADD or DELETE a decision but can never SUPERSEDE one — the ledger's core verb is
  missing from the human lane, and deletion is exactly the verb the ledger forbids. Next unit: an
  authenticated supersede route that goes through recordAgentDecision's write rule.
- **Environment finding for the operator**: local main ≠ origin/main (diverged, not merely
  behind) — anything built from the local tree, scratch daemons included, tests different code
  than what is merged. Surfaced, not "fixed" — the local line carries unmerged fleet work.
- Stretch (real unit spawn) failed for environmental reasons (bare git-init repo, isolated HOME)
  — the primer-consumption half remains open for the live-runner family, unchanged.

**LIVE-1 follow-through (2026-07-27)**: the surviving finding is closed — PR #298 ships
`POST /api/features/:id/decisions/supersede`, the human lane's supersession verb, riding
recordAgentDecision's write rule (stamps server-authored; forged stamps schema-stripped;
degenerate `supersedes` 400s instead of degrading to a plain append — the blind review's one real
finding, fixed and locked). The ledger's core verb is now reachable from every lane: agent tool,
and human HTTP.


---

## Borrow log: mnemosyne → C3 (2026-07-27)

The fresh-context comparison (plans/research-mnemosyne/BRIEF.md) filed one direct borrow: the
claim-before-write, originals-preserved shape of mnemosyne's `sleep()` consolidation. Applied in
PR #301 as orphaned-run digest reconstruction — with the glance-specific twist that our exhaust
(receipts + persisted transcripts) is runtime-owned and survives the worker AND the daemon, so
reconstruction can happen at adopt time from durable evidence rather than needing a crash-safe
claim protocol inside the summarizer.

Second blind-review lesson banked, and it is about our own testing: the first cut's detector
compared max-over-ALL transcript entries to the last receipt, which would have relabeled every
cleanly finalized run as a post-mortem — because finalizeRun emits its token-burn system entry
AFTER writing the receipt. The accompanying test passed only because its fixture hand-ordered
the timestamps into the convenient shape. **A fixture that does not reproduce the real ordering
of the code under test is not a test of that code.** The detector now reads agent-authored turns
only; the fixtures mirror production ordering.

---

## FIELD-1: L0 growth measured on a real long-running deployment — 2026-07-28

Not an experiment; a measurement, taken from the operator's live daemon state dir (`~/.glance`,
running continuously for weeks across a real fleet). It answers a question POSITION §2 never asks.

| Store | Size | Bounded? |
|---|---|---|
| worktrees | 1.2 G | reaped (`worktree-reaper.ts`) — not a memory store |
| orgs | 882 M | per-org disk (transcripts/receipts/digests within) |
| automation.jsonl | 7.7 M | **append-only, no rotation** |
| workflow-checkpoints | 5.1 M | unbounded |
| receipts | 2.9 M / 536 files | **`receipts.ts` self-flags "no rotation/retention"** |
| state.json | 1.9 M | snapshot, rewritten |
| gate-logs | 1.9 M | unbounded |
| digests | 1.6 M | one per agent, never expired |
| audit.jsonl | 1.2 M | append-only |
| **total** | **2.1 G** | |

**The gap this exposes in the position itself**: POSITION §2's L0 rule is "append-only, immutable,
cheap to write, never destructively summarized" — and it says NOTHING about bounds. Taken
literally that is a disk leak with a philosophy. The honest form of the rule, which the position
should carry: **L0 is append-only and bounded — retention is a floor-and-circuit-breaker problem,
not a deletion problem.** The tencentdb research already banked the shape (Rank 3): time-based
deletion gated by a minimum-retained floor per agent, plus a circuit breaker that refuses the
whole prune when the expired fraction exceeds a ceiling (a bad clock or config must not be able to
empty the ground truth every layer above regenerates from). Glance sits at the OPPOSITE failure
pole from the systems that inspired the rule: they over-deleted; this one has never deleted at all.

Not fixed in this pass — recorded as evidenced, unblocked work with a known design. The reason it
matters for the ledger and not just for disk: every claim in this lane (C2 regeneration, C3
post-mortem reconstruction, drill-down provenance) assumes L0 is *there* to regenerate from. An
unbounded store eventually gets truncated by something that is not us — a full disk, a manual
`rm`, a container rebuild — and that is exactly the uncontrolled loss the architecture exists to
prevent. Bounded-with-guards is how the guarantee survives contact with a finite machine.
