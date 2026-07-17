# Structured validator-input experiment (replay-only)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
MODE: hitl
BLOCKED_BY: 06, 08
TOUCHES: src/land-assessment/replay/validator-experiment.ts

## Goal
Phase 3's evidence for a *later* validator-integration decision, scoped to what is actually measurable without a criterion-level oracle: token/cost delta, plus a human-rated study of the disagreements.

## Approach
- Replay-only: re-run `validator.ts`'s existing prompt construction (`judgeUserPrompt` + `budgetedExcerpt`) over historical corpus diffs twice — once with the raw diff (status quo), once with the assessment's structured findings substituted — comparing verdicts and token cost. The live `validator.ts` path is NEVER touched.
- The honest claims (arbitrated): (1) cost delta is a real metric; (2) verdict agreement between the two input conditions is NOT a quality metric (no ground truth). Where the two conditions disagree, sample N≥20 disagreements for human rating ("which verdict was correct?") — that rating step is Lars's or a designated human's (hence MODE: hitl), and the output is a small qualitative study, explicitly labeled not-decision-grade for enforcement.
- If the disagreement study suggests structured input is materially better, the follow-up (building a criterion-level oracle — hand-labeled criterion×diff→satisfied set) becomes a NEW concern in a later phase; it is out of scope here.

## Cross-Repo Side Effects
None.

## Verify
Experiment runs over ≥50 corpus diffs without touching live validator paths (grep proof: no import of hook/live-gate modules from validator.ts changes); report shows cost delta + disagreement sample with human ratings attached; the report's own header carries the not-decision-grade caveat.
