# CS329A (Stanford, Autumn 2025) × glance — adoption brief

**Date**: 2026-08-03 · Corpus: 9 cleaned lecture transcripts,
`/mnt/c/Users/Lars/Downloads/CS329A_Self-Improving_AI_Agents_Dossier/CS329A_Self-Improving_AI_Agents_Dossier/transcripts/`
(Chowdhery & Mirhoseini). Method: full direct read of all nine transcripts by this brief's
author, plus an independent grok-4.5 single-pass extraction
(`/home/lars/.claude/jobs/7f45c876/tmp/grok-out.md`) run in parallel as a cross-check — the two
passes agree on every load-bearing number and quote cited below (Weaver 86.2% / 400M / 97%;
METR 59min@50% vs ~15min@80%; GDPval 47.6%; DAPO 30→50; DeepScholarBench <19%;
meta-verification quotes; "consensus of other models to critique"). glance context:
POSITION.md + VALIDATION.md
(plans/research-long-horizon-agent-memory/), deepen-modules/00-overview.md, src/ layout.

## The question

Which specific claims, methods, and results from CS329A should glance adopt, and which of
glance's four architectural bets (event-sourced memory, verification-as-trust-anchor,
self-improvement loops, real-work long-horizon evaluation) does the course confirm or contradict?

## Verdict in three sentences

The course **confirms all four bets** — most strongly the verification bet, where the entire
arc of lectures 2–3–9 is glance's architecture stated as research consensus: the
generation–verification gap is the bottleneck, execution feedback beats LLM judgment,
self-critique is weaker than independent critics, and even verifiers need meta-verification.
No bet is contradicted; the nearest thing to a contradiction is a **shared open wound**, not a
disagreement — the course states flatly that "we don't really have very good techniques to
learn from failures" and that self-improvement makes systems *more consistent, not smarter*
(majority@K up, pass@K flat), which bounds what glance's learning ledger can ever deliver.
The highest-leverage borrows are compute-allocation and evaluation *policies*, not new
machinery: DAPO-style difficulty-targeted dispatch (no signal from all-pass or all-fail work),
a METR-style horizon×reliability curve computed from glance's own dispatch ledger, and
Weaver-style measured weighting of the reviewer ensemble.

## Per-lecture load-bearing content (compact)

**L1 — Course overview** (`01_Part1_Course_Overview.txt`). Scaling laws → emergent CoT →
agents = goal + environment feedback + stop condition. Frames the whole course around the
generator–verifier gap: "at the end of the day, whether that's useful or not, we need a
feedback loop… In domains where you can have good feedback, that's where it's possible to
continue to improve the model." Models "like their own traces more" — even over a better
model's traces. Agent workflows = LLM calls + verifiers + critics + tool calls + orchestration.

**L2 — Test-time compute scaling** (`02_...txt`). Large Language Monkeys: coverage follows a
power law in samples; Llama-3 8B beats GPT-4o given 10k samples and a verifier. The
**generation–verification gap**: "majority voting… plateaus after 10 or 50 samples" while
coverage keeps climbing — selection, not generation, is the bottleneck. Verifiable domains
enumerated: unit tests, formal proofs, translation equivalence (KernelBench CUDA-vs-PyTorch
output matching). Compute-optimal scaling: easy/medium problems — test-time compute substitutes
for model scale; hardest problems — bigger pretrained models still win. Archon: inference
architecture search (generation→critic→ranker→fusion layers, Bayesian-optimized); **fusion of K
candidates beats even oracle selection**; open-source ensemble beat GPT-4o/Claude-3.5 pass@1 by
avg 14.1%.

**L3 — Robust verification** (`03_...txt`). Four-paper arc. Cobbe/GSM8K verifiers: verifier
selection beats fine-tuning as data grows, BUT **verifier precision collapses past ~400
samples** ("the precision of the verifier drops… they stopped at 100 samples"); larger
generator + smaller verifier beats the reverse. Let's Verify Step by Step: PRM > ORM +
majority voting; process supervision "can manage the false positives way better" (model can
hallucinate to a correct final answer through a wrong process); PRM generalizes under
distribution shift better than majority voting. Math-Shepherd: automated step labels via
rollout success — no human annotation; known failure: hard problems yield zero signal.
**Weaver** (Stanford 2025): ensemble of weak verifiers + weak-supervision weights closes the
gap — filtering out low-quality verifiers first "is a very important step"; lifts an 8B
generator to ~70B-class accuracy; **distilled 400M cross-encoder keeps 97% of the ensemble's
accuracy at <1% of compute**. Code monkeys teaser: model-generated unit tests as the verifier.

**L4 — Learning from feedback with tools/code** (`04_...txt`). ReAct: interleaved
thought→action→observation; grounding cuts hallucination; fails on large action spaces. RLEF:
execution feedback (test results) in the RL loop; **public/private test split** so the model
"cannot simply memorize the test outputs." Constitutional AI: principles-as-critique
self-improvement loop; helpful/harmless Pareto frontier. Key caveat, near-verbatim: "getting
the model to critique itself can be harder. So having a **consensus of other models to
critique** the model sometimes works better, because the models might be overconfident."

**L5 — Planning & multi-step reasoning** (`05_...txt`). LATS: MCTS/UCT over agent actions with
LLM-judge + self-consistency values and reflection on failed trajectories; lecture names the
disqualifier itself: "there are scenarios where taking an action may [not] be reversible…
paying for a service and so on. That is another scenario where this approach might not be
adaptable." SPRINT: fine-tune to emit independent plans in parallel; ~40% sequential-token
reduction AND accuracy gains; exploration early, convergence late. **SWiRL**: offline
synthetic multi-step trajectories, stepwise LLM-judge process rewards, no live tools during
RL; **process-filtered data beat outcome-filtered data** ("if we only get trajectories where
the model already knows the outcome… you're not helping the model solve problems it couldn't
solve"); cross-tool generalization (train on search, improve on calculator: 65→75.1%).

**L6 — Train-time scaling / RL** (`06_...txt`). STAR: bootstrap rationales, rationalize
failures with answer-as-hint; plateaus after iterations. DeepSeekMath/GRPO: 7B → 51.7% MATH;
code-pretrained base beats arxiv-pretrained for math; group-relative advantage (no critic).
DAPO: 30→50 AIME on Qwen-32B via asymmetric clipping + token-level loss + overlong penalty +
**dynamic sampling**: "if all the rewards are zero or all the rewards are one then basically
the normalization doesn't work… you want to keep only those groups that have some signal."
Two hard limits stated as claims: RL "improves the majority@K performance… none of these will
yet improve the fundamental capability" — "the model actually became **more consistent, not
fundamentally smarter**"; and "we don't really have very good techniques to **learn from
failures**… a lot of the techniques just filter them out." Also: "if the model is too capable
then the rewards will get hacked; if the reward model doesn't have enough signal you can't
hill climb."

**L7 — Self-improvement & deep research agents** (`07_...txt`). AlphaCode: 1M samples,
filter-on-public-tests (removes ~95%), **cluster by behavioral equivalence** (generated test
inputs), submit one per cluster; 10@k vs pass@k gap shows "the selection stage can also be a
bottleneck." AlphaCode 2: fine-tuned Gemini Pro family + learned scoring model → **100 samples
matched AlphaCode's 1M**; 43% vs 25% solve rate at equal budget; 85th percentile. Search-o1:
uncertainty terms ("perhaps", "wait") trigger retrieval; **reason-in-documents** — extract
relevant chunks instead of dumping documents, because with 10–20 raw documents "it might
actually not be able to do a good job at reasoning over them"; accuracy *rises* with document
count only with extraction. Model overconfidence/calibration: models "will be like 80% very
confident" at 50% correctness.

**L8 — Agentic evaluations & long-horizon tasks** (`08_...txt`). METR: task time-horizon
completed at 50% reliability doubles every ~7 months; Claude 3.7: **59 min at 50% success vs
~15 min at 80%** — "there will be reliability challenges even for moderately complex tasks."
Failure taxonomy: poor planning, poor tool choice, premature abandonment, repetitive loops —
"failure mode analysis is very useful in understanding where the models can or cannot
improve." **Contractor result**: repo maintainers are 5–18× faster than no-context
contractors, "and model performance is consistent closer to contractor times… it's operating…
as a low-context human." GDPval: win-rate vs decade-experienced experts, **linear** trend
(GPT-4o 12.4% → Opus 4.1 47.6%) vs METR's exponential; dominant failure = instruction
following; "the models will promise to look at the reference data but then actually not look
at it"; retry-with-feedback loop: 1.6× cost / 1.4× speed improvement; well-specified prompts
carry the context a human has in their head — "real work is often context heavy."
DeepScholarBench: live monthly-regenerated benchmark (contamination-proof); **no system
exceeds 19%**; verifiability and synthesis quality trade off; document importance <12.5%.

**L9 — Future research areas** (`09_...txt`). Multi-agent fine-tuning: single-model
self-improvement collapses — "when a single large language model is generating outputs… it
will not have very diverse responses even at high temperatures"; multiple specialized
generators + critics keep diversity and keep improving where "single-agent fine-tuning…
accuracy collapses." DeepSeek-Math V2 **meta-verification**: LLM verifiers "will claim that
the incorrect proofs are valid"; a meta-verifier audits the verifier's analysis ("do these
identified issues actually exist? does the score follow from the issues?") and the
generator/verifier co-improve; result: best@32 ≈ 42% proof score on the IMO 2024 shortlist,
climbing over eight iterations. Absolute-Zero-style task self-proposal: proposer reward = 0 if
solver success rate is 0, else 1 − avg success rate — "you end up selecting tasks of moderate
difficulty where the solver will sometimes succeed and sometimes fail." Intelligence-per-watt:
local ≤20B models already address 88.7% of real chat queries; hybrid local/cloud routing.
Continual learning named open: side-memory ≠ skill acquisition ("having a side memory system
doesn't quite achieve [reasoning over new domains]").

## Bets adjudicated

### Bet 1 — Long-horizon memory as event-sourcing, not retrieval → **CONFIRMED (indirectly) + EXTENDED; no contradiction**

The course never proposes an event-sourcing memory (its memory touchpoints are
retrieval-shaped: RAG, agentic RAG, deep research), so it cannot directly bless the ledger
architecture. But it supplies the strongest *stakes* evidence in the corpus for the bet's
premise — that context/memory is where long-horizon economic value is lost:

- L8 (METR): maintainers 5–18× faster than contractors, and "model performance is consistent
  closer to contractor times." The maintainer-vs-contractor gap **is** the gap glance's memory
  is built to close: durable, validity-filtered project context is what turns a contractor
  into a maintainer. Land-rate improvements from memory should be measured against exactly
  this framing.
- L8 (GDPval): "the models will promise to look at the reference data but then actually not
  look at it" — direct support for POSITION §2-L3's rule that must-see items are surfaced *by
  state, as a region*, never left to model diligence or a relevance score.
- L7 (Search-o1): raw document-dumping degrades reasoning; extracting relevant chunks before
  injection makes accuracy *rise* with corpus size. This is POSITION's precision-over-recall
  active set, independently validated: "instead of… clustering the prompt with like 10
  documents or 20 documents," extract and inject the relevant span. Confirms the budgeted,
  distilled active set over top-K injection (VALIDATION C4's direction).
- L9 (continual learning): "having a side memory system doesn't quite achieve that
  [reasoning over new domains]" — a scope caveat, not a contradiction: memory buys knowledge
  continuity, not capability. POSITION already concedes this as the open problem "skill
  distillation without drift." Do not oversell the memory lane as making units *smarter*.

### Bet 2 — Verification as the trust anchor → **STRONGLY CONFIRMED + EXTENDED**

This is the course's spine, and it validates every layer of glance's stack:

- **The gap is real and is the bottleneck** (L2): coverage scales log-linearly with samples
  while "majority voting… plateaus after 10 or 50" — generation is cheap, selection is the
  constraint. glance's proof-gated landing (done-proof, gate-runner, convergence-ratchet) sits
  exactly where the course says the leverage is.
- **Execution feedback over LLM judgment** (L2/L4): unit tests, formal checks, output
  equivalence are the named gold-standard verifiers; RLEF's whole result rests on running
  tests. Confirms sandboxed container gates as ground truth rather than model-graded review.
- **Independent critics beat self-critique** (L4, near-verbatim): "having a consensus of other
  models to critique the model sometimes works better because the models might be
  overconfident" — plus L1's "models like their own traces more." This is the cross-lineage
  blind review bet (grok + codex + native) stated as a finding. L9's multi-agent result adds
  the diversity mechanism: independent lineages are diversity by construction.
- **Blind = private test set** (L4 RLEF): the public/private split exists so the system
  "cannot simply memorize the test outputs." glance's blind-review discipline (no inherited
  framing, no known-accepted list) is the process-level version of the same
  leakage-prevention principle.
- **Verifiers themselves need auditing** (L9 DSM-V2): verifiers "claim that the incorrect
  proofs are valid," fixed by a meta-verifier asking "do these identified issues actually
  exist?" glance's standing rule — "a reviewer's finding is a hypothesis, not a verdict;
  adjudicate against the code" — is meta-verification practiced manually. The course confirms
  it and shows it can be systematized (borrow 7).
- **One warning to import** (L3): verifier precision degrades as candidate volume grows
  (collapse past ~400 samples). If glance ever fans out many candidate diffs per concern,
  the gate/review stack's discrimination will degrade with N — cap the candidate set,
  as AlphaCode capped at 10–100.

### Bet 3 — Self-improvement loops (/deepen, learning ledger, failure-memory, verify-loop) → **CONFIRMED in shape; two sharp caveats imported**

- The canonical loop the course teaches (L6: "take what the model output, filter [by
  verification], and then use that to fine-tune further — that's roughly what train-time
  scaling is") is structurally glance's loop with the write target changed: glance filters by
  gates and writes to ledger/skills/memory instead of weights. The course validates the
  *architecture* — verifier-gated selection into a reuse store — and L7's homework framing
  ("agentic context engineering") acknowledges the context-level variant as the practical
  path when you don't train.
- **Caveat 1 — consistency, not capability** (L6): "the model actually became more consistent,
  not fundamentally smarter"; pass@K does not improve, majority@K does. Expect glance's loops
  to reduce variance (fewer repeated failures, fewer re-derivations) rather than to unlock
  concerns the fleet fundamentally cannot do. Measure them accordingly (repeat-failure rate,
  re-derivation rate — VALIDATION C3's metrics are the right ones).
- **Caveat 2 — failure data is mishandled by default** (L6): "we don't really have very good
  techniques to learn from failures… a lot of the techniques just filter them out." But L5
  (SWiRL) shows the exception: **process-filtered beats outcome-filtered** — trajectories with
  sound process and failed outcomes are the highest-value learning signal. glance's
  failure-memory records failures; the refinement is to distinguish good-process failures
  (borrow 5).
- **Diversity collapse** (L9): single-source self-improvement stalls; specialized multi-agent
  setups keep climbing. glance's three-lineage review and multi-harness fleet is the
  deployed form of this; keep it — collapsing to one model family for economy would spend the
  exact asset the course says drives continued improvement.
- **Signal exists only at moderate difficulty** (L6 DAPO + L9 AZR): all-pass and all-fail
  work products carry zero learning signal. glance's observed pathologies — verify-loop
  thrashing hard units, escalate caps burned 2-for-2 — are this phenomenon; the course gives
  the principled fix (borrow 1).

### Bet 4 — Long-horizon eval via land-rate/gate-baselines/adoption, not benchmark suites → **CONFIRMED + EXTENDED**

- L8 is a sustained argument for glance's position: static benchmarks saturate and
  contaminate ("the models also have seen most of the GitHub repositories"; annotators
  underestimate SWE-bench), while the meaningful metrics are real-work-derived — GDPval's
  win-rate on professional deliverables, DeepScholarBench's monthly regeneration. glance's
  land-rate is a win-rate metric over real work; adoption counters are the daily-driver form
  of "was the output actually good enough to use." Confirmed.
- **Failure-mode scoring confirmed**: METR/GDPval both lead with failure taxonomies (poor
  planning / tool choice / premature abandonment / repetitive loops; instruction-following;
  ignored reference data) — "failure mode analysis is very useful in understanding where the
  models can or cannot improve." POSITION §6's score-by-named-error-class and the harness's
  scenario corpus are the same design.
- **Extension glance lacks**: the *reliability-conditioned horizon curve*. glance measures
  whether work lands, not how land-rate varies with task size, and not at what reliability
  level. METR's core finding (59 min at 50% vs ~15 min at 80% for the same model) shows a
  single unconditioned rate hides the axis operators actually plan around (borrow 2).
- **Second extension**: outcome quality is not binary. GDPval grades acceptable /
  acceptable-but-subpar / bad / catastrophic; roughly half of "wins" were subpar. A landed PR
  is glance's "win," but landed-then-reverted or landed-then-hotfixed is the subpar band —
  worth one counter (folds into borrow 2).

## Ranked borrows (with landing sites in glance)

1. **Difficulty-targeted dispatch (dynamic sampling for the fleet).** Evidence: L6 DAPO —
   groups with all-0 or all-1 reward are filtered because "the normalization doesn't work";
   L9 proposer reward = 1 − avg success, 0 if unsolvable; L3 Math-Shepherd's hard-problem
   zero-signal failure. glance already logs per-unit outcomes (src/task-outcomes.ts,
   src/harness-scorecard.ts, dispatch-ledger.ts). Policy: track verify-loop success
   distribution per concern class; when a unit's attempts are uniformly failing, stop
   re-dispatching at the same difficulty (decompose or escalate model *once*, then park —
   don't burn the cap on a zero-signal task); when uniformly passing, stop spending review
   cycles there. Landing: escalation policy in the verify-loop lane (src/scheduler.ts /
   src/dispatch.ts, threshold-tuner.ts as the knob-holder). Cost: small (counters exist).
   Benefit: directly attacks two logged pathologies (escalate-cap burn 2-for-2, verify-loop
   thrash) with a principled rule instead of a cap.

2. **METR-style horizon×reliability curve from the dispatch ledger.** Evidence: L8 — the 50%
   vs 80% reliability split is the operative fact (59 min vs ~15 min); GDPval's linear
   win-rate trend contradicts naive extrapolation from a single rate. glance has the raw
   data: per-unit wall-clock, attempt counts, land outcomes. Compute: land-rate as a function
   of task-size bucket, reported at 50% and 80% thresholds, trended per model/harness — plus
   one "subpar" counter (landed-then-reverted/hotfixed within N days). Landing:
   src/metrics.ts + src/adoption-counters.ts / attribution-scoreboard.ts, surfaced as a
   webapp panel next to the existing adoption counters. Cost: moderate (one aggregation + a
   revert-detector on the land ledger). Benefit: answers "is the fleet getting longer-horizon
   and at what reliability" — the question land-rate alone structurally cannot.

3. **Measured reviewer-ensemble weights (Weaver-lite).** Evidence: L3 Weaver — filtering out
   weak verifiers is "very important"; learned per-verifier weights beat naive ensembling;
   gap-closing is worth whole model classes. glance already runs a 2–3 lineage ensemble and
   adjudicates every finding; what's missing is the ledger: record, per adjudicated finding,
   which lineage raised it and whether it survived adjudication. After ~50 findings you have
   measured precision per lineage per defect class (glance's own history already hints:
   grok catches fail-opens and argv-class bugs, codex catches races and substring
   misclassification). Use it to weight attention and to detect a reviewer going stale.
   Landing: a small outcomes table in src/memory/ (decision-evidence.ts is the adjacent
   shape) + a line in the blind-review skill's closing step. Cost: low. Benefit: turns the
   review gauntlet from folklore-calibrated to measured, and gives early warning if a
   lineage's value decays.

4. **Cluster-then-gate for multi-candidate work (AlphaCode selection discipline).** Evidence:
   L7 — filter on cheap tests removes ~95% of candidates; cluster survivors by behavioral
   equivalence (model-generated test inputs); spend the expensive submission budget on one
   representative per cluster; "the selection stage can also be a bottleneck." Landing:
   wherever glance fans out parallel attempts at one concern (bounce/retry lanes,
   plan-proposals with competing implementations): run the cheap suite first, dedupe
   behaviorally-equivalent diffs, and send one representative per behavior class through the
   container gate (src/gate-runner.ts / gate-semaphore.ts). Also import L3's warning as a
   cap: verifier discrimination degrades with candidate count — keep N small (≤10). Cost:
   moderate. Benefit: container-gate minutes are glance's scarcest verification resource;
   this is the course's proven allocation policy for exactly that shape.

5. **Process-filtered failure retention in failure-memory.** Evidence: L5 SWiRL —
   process-filtered training data beat outcome-filtered ("you're not helping the model solve
   problems it couldn't solve" if you keep only known-good outcomes); L6 names
   learning-from-failure as unsolved (so this is the one evidenced mechanism available).
   Landing: src/memory/failure-memory.ts + weekly-episode: when recording a failed unit,
   have the digest distinguish "sound approach, failed on environment/flake/scope" from
   "wrong approach," and surface the former as *reusable process* (the approach is worth
   retrying under changed conditions) rather than as a symptom to avoid. Cost: small (one
   classification at digest time). Benefit: converts the largest and least-used data stream
   glance produces (failures) into targeted signal.

6. **Reason-in-documents distillation on the retrieval path.** Evidence: L7 Search-o1 —
   injecting raw retrieved documents degrades reasoning; extracting the relevant span makes
   accuracy rise with corpus size; L8 DeepScholarBench — even given perfect sources, systems
   surface only ~50% of key facts (extraction is the hard half). Landing: glance's kb/fabric
   retrieval path (src/memory/fabric-search.ts, the primer assembly): between retrieval and
   context injection, add an extract-relevant-span step with a drill-down pointer to the full
   source (POSITION L2 rule 3 already mandates the pointer). Cost: small; one model call on
   the retrieval path. Benefit: consistent with C4/C5 and independently evidenced; also
   sharpens `glance ask`.

7. **Systematized meta-verification of review findings.** Evidence: L9 DSM-V2 — verifiers
   fabricate issues; a meta-check ("do the identified issues actually exist? does the
   severity follow?") measurably improves the loop. glance's rule ("adjudicate findings
   against the code") is currently orchestrator discipline; make it a cheap structured step:
   before findings reach a fixer, one pass verifies each cited file/line/claim exists and is
   as described, tagging fabrications. Landing: blind-review skill output handling
   (.claude/skills/blind-review) + the review lane of /deepen (plans/deepen-modules ground
   rules already require adjudication). Cost: low. Benefit: protects against the measured
   failure mode of the reviewers glance leans on hardest; pairs with borrow 3's ledger.

## Rejected ideas and why

- **MCTS/tree search over agent actions (LATS, L5).** The lecture itself names the
  disqualifier: it assumes reversible actions — "if it actually takes those actions it could
  be very consequential." glance's actions (commits, lands, dispatches) are consequential;
  its worktree-isolation + gate-before-land already implements the only safe form of
  backtracking (try in isolation, discard on failure). Nothing to add.
- **Weight-level self-improvement (STAR/GRPO/DAPO/SPRINT/SWiRL as training recipes).** glance
  does not train models. Borrow the *policies* (dynamic sampling, process filtering) — the
  training machinery itself is out of scope, and L6's own evidence (plateaus, majority@K-only
  gains, reward hacking) says the returns are bounded even for those who can train.
- **AlphaCode-scale massive sampling (1M candidates).** Superseded within the course itself:
  AlphaCode 2 matched 1M-sample performance with 100 samples via a better base model and a
  learned scorer (L7). glance's lesson is the ratio, not the volume — spend on base-model
  quality and selection, never on candidate count.
- **Multi-agent fine-tuning of specialized generator/critic populations (L9).** The diversity
  benefit is real, but glance already obtains it structurally from three vendor lineages
  without owning training infra. Adopt the finding (preserve lineage diversity), reject the
  mechanism.
- **Fusion of candidate solutions (Archon, L2) as a landing mechanism.** Fusion beating
  oracle selection is a striking result, but fusing *diffs* from parallel workers is exactly
  the shared-tree merge hazard glance's isolation model exists to prevent (memory: fixers
  stashing each other's work). Possible narrow future use in plan/text synthesis, not code.
- **A benchmark suite as glance's evaluation.** The course's own evidence kills it: SWE-bench
  contamination ("models have seen most of the GitHub repositories"), annotator
  underestimation, saturation (L8). glance's real-work metrics are the GDPval-shaped choice;
  the fix is to enrich them (borrow 2), not replace them.
- **Intelligence-per-watt / local-model routing (L9).** Real trend (88.7% of chat queries
  addressable locally), but orthogonal to glance's current bets and already partially covered
  by model-route cost tiers. Revisit if fleet inference cost becomes a binding constraint.
- **Uncertainty-term-triggered retrieval (Search-o1's "perhaps"-detector).** The trigger
  mechanism assumes access to the model's reasoning stream mid-generation — a control point
  glance's supervisor architecture doesn't own (POSITION §5's transplant rule). The
  *extraction* half transplants (borrow 6); the trigger half does not.

## Sources

All files under
`/mnt/c/Users/Lars/Downloads/CS329A_Self-Improving_AI_Agents_Dossier/CS329A_Self-Improving_AI_Agents_Dossier/transcripts/`.
Each transcript is a single continuous text block; positions given as approximate fractions.

- **L1** `01_Part1_Course_Overview.txt` — generator-verifier gap & feedback-bottleneck quote
  (~70%); "models like their own traces more" (~55%); agent definition (~50%).
- **L2** `02_Part2_Test-Time_Compute_Scaling.txt` — monkeys coverage/power law (~10–20%);
  majority-voting plateau & generation-verification gap (~30%); verifiable-domain catalog,
  KernelBench (~25%); compute-optimal easy-vs-hard (~55%); Archon, fusion>oracle, +14.1%
  (~75–100%).
- **L3** `03_Part3_Robust_Verification.txt` — Cobbe verifier, 400-sample precision collapse,
  generator/verifier sizing (~10–30%); PRM800K, false-positive management (~35–50%);
  Math-Shepherd hard-problem zero-signal (~55–65%); Weaver ensemble, filter-first, 400M
  distillation 97%/<1% (~70–95%); code monkeys mention (final Q&A).
- **L4** `04_Part4_Learning_from_Feedback_Tools_Code.txt` — ReAct (~5–40%); RLEF
  public/private split & anti-memorization (~45–65%); Constitutional AI (~70–90%);
  "consensus of other models to critique… models might be overconfident" (~90%).
- **L5** `05_Part5_Planning_Multi-Step_Reasoning.txt` — LATS mechanics (~5–35%);
  irreversible-actions caveat (~35%); SPRINT (~40–70%); SWiRL, process-filtered >
  outcome-filtered, cross-tool generalization 65→75.1 (~70–100%).
- **L6** `06_Part6_Train_Time_Scaling_RL.txt` — STAR (~15–45%); DeepSeekMath/GRPO 51.7%
  (~50–70%); DAPO dynamic-sampling quote, 30→50 AIME (~75–90%); "more consistent, not
  fundamentally smarter" (~72%); "don't have good techniques to learn from failures" (~95%);
  reward-hacking bound (~95%).
- **L7** `07_Part7_Self-Improvement_Deep_Research_Agents.txt` — AlphaCode 1M/filter/cluster,
  54.3 ranking, 10@k selection bottleneck (~5–40%); AlphaCode 2, 100≈1M, 43% vs 25%, 85th
  pct (~40–60%); Search-o1 reason-in-documents (~65–90%); overconfidence/calibration (final
  Q&A).
- **L8** `08_Part8_Agentic_Evaluations_Long_Horizon.txt` — METR design, 7-month doubling,
  59min@50% vs ~15min@80% (~15–35%); failure taxonomy (~40%); contractor 5–18×,
  "low-context human" (~45%); GDPval win rates, linear trend, ignored-reference-data
  failure, subpar taxonomy, 1.6×/1.4× retry (~50–75%); DeepScholarBench <19%, live monthly
  (~75–95%); "real work is context heavy" (~70%, ~95%).
- **L9** `09_Part9_Future_Research_Areas.txt` — multi-agent diversity collapse (~15–30%);
  DeepSeek-Math V2 meta-verification quotes (~30–45%); task self-proposal, 1−success reward,
  moderate difficulty (~45–60%); "learn from failures" continuation & continual-learning /
  side-memory caveat (~60–70%, Q&A ~85%); intelligence-per-watt 88.7% (~70–80%).

glance-side documents adjudicated against:
`plans/research-long-horizon-agent-memory/POSITION.md` (full),
`plans/research-long-horizon-agent-memory/VALIDATION.md` (claim ledger C1–C9, header),
`plans/deepen-modules/00-overview.md` (ground rules, iteration ledger),
`src/` module inventory (memory/, gate-runner, dispatch-ledger, task-outcomes,
harness-scorecard, adoption-counters, threshold-tuner, scheduler, fabric-search).
