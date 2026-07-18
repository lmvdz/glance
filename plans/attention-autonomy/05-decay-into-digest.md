# 05 — Decay-into-digest: the comprehension delivery

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/weekly-episode.ts, src/attention-digest.ts (new), src/server.ts, webapp Daily panel

## Goal
Where Lars SEES what self-resolved, without managing anything. Two deterministic zero-LLM
projections (weekly-episode contract: byte-identical markdown, honest Not-covered lines):
1. Weekly-episode section "Self-resolved attention": new attentionResolutions input to
   buildEpisode (the staleAnswers? forward-compat pattern), grouped by resolution kind with
   provenance lines: "3 units asked variations of X; answered by precedent P-12 (your answer of
   2026-07-14)".
2. Daily before/after brief: GET /api/attention/digest — deterministic funnel over the resolution
   log for the trailing day: lane count at start → arrived → auto-resolved (by rule) → absorbed →
   expired-with-note → RESIDUE (what genuinely awaits Lars). Daily panel renders it as the
   before/after infographic. absent ≠ zero honesty preserved (no log ⇒ "not wired", not "0").

## Verify
Determinism test (same inputs ⇒ byte-identical output). Scratch-daemon + agent-browser screenshot
of the Daily panel after a seeded resolution day.
