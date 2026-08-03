# Measured reviewer-ensemble weights — Weaver-lite for the blind-review gauntlet
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/memory/ (new small ledger via src/ledger.ts shapes), .claude/skills/blind-review (closing step), .claude/skills/deepen step 7
MODE: afk

## Goal
CS329A borrow #3 (plans/research-cs329a/BRIEF.md): Weaver shows that filtering weak verifiers
and weighting the rest recovers verification accuracy worth whole model classes (86.2% with a
400M judge ensemble ≈ 97% of an o3-scale judge). glance runs a cross-lineage reviewer ensemble
(grok + codex + native) on every shipping diff and adjudicates every finding — but keeps no
record of which lineage raised what and whether it survived adjudication. Add a small ledger
(one row per adjudicated finding: lineage, concern class, survived?) written as a closing step
of blind-review/deepen runs, and a periodic read that reports per-lineage precision by concern
class. The anecdotes ("grok catches fail-opens codex misses") become measured weights that tune
where each reviewer's findings get benefit of the doubt.

## Provenance
Lecture 3 (Weaver; "consensus of other models to critique… models might be overconfident").
Pre-adjudicated in the brief; do not re-research.
