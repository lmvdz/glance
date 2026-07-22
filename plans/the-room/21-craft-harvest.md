# Craft harvest — t3-face's shipped visual work becomes the room's design language
STATUS: open
PRIORITY: p2
REPOS: omp-squad, glance-desktop (read-only)
COMPLEXITY: research
TOUCHES: plans/the-room/CRAFT-HARVEST.md (output only)
MODE: afk

## Goal
The t3-face reskin (concerns 01-10, merged to glance-desktop) is real taste work that must not
die with the superseded fork. A taste-qualified review over those diffs + the R3 chat-surface
research (PR #215: H3 changed-files card spec, three-part timeline perf system, scroll anchoring
modes, string-canonical composer) produces a concrete adoption list for the room's card renderers
and composer — learnings ported, not code (delete-not-port; B-F11's clean split from the parked
t3-face 13 protocol).

## Approach
1. Reviewer (taste ≥ 7 model per model policy: opus/fable) reads the t3-face diff set in the
   glance-desktop clone + the PR #215 BRIEF Round-3 sections.
2. Output: CRAFT-HARVEST.md — per-item: what (token/pattern/motion spec), where it applies in the
   room (which concern), and a keep/skip verdict with one-line taste rationale. Feeds 07/08/10
   and the love-gate axes.
3. Also resolve PR #215's disposition: recommend merging it (docs-only research, reference intel
   for concern 08's scroll spec) — flag for Lars since merging is his call.

## Cross-Repo Side Effects
None (read-only over glance-desktop).

## Verify
- CRAFT-HARVEST.md exists, is cited by at least concerns 07/08 at their implementation time, and
  the PR #215 recommendation is recorded.
