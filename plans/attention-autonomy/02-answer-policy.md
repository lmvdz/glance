# 02 — Auto-answer policy core: fail-closed gate taxonomy

STATUS: open
PRIORITY: p0
COMPLEXITY: architectural
BLOCKED_BY: (none — start immediately; longest review tail)
TOUCHES: src/answer-policy.ts (new), src/answer-precedents.ts (new), src/supervisor.ts, src/squad-manager.ts
MODE: hitl — cross-lineage (grok+codex) gauntlet + blind review REQUIRED before merge

## Goal
One place decides "may the system answer this for itself," consulted by ALL THREE answerers
(maybeAutoSupervise, supervisor.ts external loop, 03's triage agent) — replacing the current
split-brain (deterministic regex here, approve-bias LLM there).

- Structurally-human ceiling, checked FIRST, tighten-only like gateClassOf: gate-class,
  source==="tool", RISKY_RE, cost/spend, plan-approval, outward/irreversible. No rule, budget, or
  model output overrides this branch.
- Positive allowlist with an evidence bar — auto-answer only when a rule MATCHES, never when a
  deny-check misses (absence of a risk signal is not evidence of safety):
  (a) worktree-scoped dev-action confirms (existing blast-radius argument, kept);
  (b) precedent-based: the human previously answered an identical (kind, normalized-title-class,
  option-set) tuple — durable answer-precedents store written on every human answer; the system
  may REPEAT that decision citing the precedent id. Model judgment alone never clears the bar.
- Every auto-answer records rule id + evidence pointer to audit (actor auto-*) and the 01
  resolution log → appears in the digest for after-the-fact review.
- supervisor.ts's "when in doubt approve" prompt retired: the LLM may only select among
  policy-permitted values, never widen them. Kill switch + per-agent/per-day budgets kept.

Named constraints: R7 #157 (blanket smol-model approval = fail-open) and the blind-review
absence-invariant.

## Verify
Adversarial vectors pinned in the suite: prompt-injected gateClass:false, risky text hidden in
options, precedent near-misses — all must fall to human. Property: no input reaches "auto"
without a named rule id.
