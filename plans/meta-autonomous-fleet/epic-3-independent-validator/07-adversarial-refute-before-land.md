# Adversarial refute-before-land — N skeptics, majority-refute kills
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
SUBPLAN: plans/meta-autonomous-fleet/epic-3-independent-validator/07-adversarial-refute/  (author when reached)

## Goal (what is built)

Strengthen the single-judge veto (leaf 02) into an ensemble: N independent skeptic agents each try to
**refute** that the diff satisfies the declared criteria; a majority-refute vetoes the land. This
composes with — does not replace — the deterministic proof gate.

## Why this is NOT a leaf yet (needs a deeper sub-plan)

Unresolved design decisions remain that a Sonnet implementer cannot be handed blind:

- **Ensemble size & quorum** — N (3? 5?), majority vs any-refute, tie-breaking; cost/latency budget per
  land (each skeptic is an independent `omp -p` call; the DESIGN cost-risk row already flags LLM cost).
- **Independence model** — distinct model lineages per skeptic vs same model different seeds/prompts;
  how to guarantee they aren't correlated. Interacts with the model-policy table (fable/opus/sonnet).
- **Refute prompt design & scoring** — a refuter's job is adversarial (find the ONE unmet criterion),
  which is a different prompt contract than leaf 01's per-criterion scorer; how to aggregate refutations
  into a single `ValidationRecord`.
- **When to escalate vs veto** — a split jury (1 of 3 refutes) should probably drop to propose-only
  (Epic 5) rather than hard-veto; that coupling to Epic 5's confidence trigger must be designed jointly.
- **Caching** — per-skeptic caching by fingerprint, and whether a re-run must re-poll all N.

## Attach points (verified, for the future sub-plan)

- Replaces/wraps the judge call inside `validatorGate` / `scoreAgainstCriteria` (`src/validator.ts`,
  leaves 01/02) — the ensemble sits behind the same `Judge` seam, so the land-gate wiring is unchanged.
- Escalation-on-split couples to Epic 5's `maxEffectiveMode`/`effectiveAutonomyMode`
  (`src/autonomy.ts`, see `plans/meta-autonomous-fleet/05-hitl-safeguards.md`).

## Verify (once decomposed)

Feed a diff that satisfies criteria to a naive reader but violates one on close inspection; confirm a
majority of skeptics refute and the land is vetoed, while a genuinely-complete diff survives all N.
