# Reasoning-first delta — default-open latest thinking + tool-check outcomes

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/chat/TranscriptTimeline.tsx (`thinking` entry render :304-318, summary-row rendering nearby)

## Goal

t3code's founder reviews reasoning, not diffs, and delegates verification to loops (plans/research-t3code/BRIEF.md:104, :142 — "devs care more about the code output and not enough about what it said and that's entirely backwards"). glance's `TranscriptTimeline` is already most of the way there: `thinking` entries render as a first-class `<details>` block that auto-opens while streaming and folds once done (`TranscriptTimeline.tsx:304-318` — `open={running}`, "Thinking" / "streaming" / "folded" states already implemented). The remaining gap is narrow: the LATEST turn's thinking should default-open even after it finishes (not just while streaming), and tool-check outcomes (pass/fail, not just that a tool ran) should surface in the summary row instead of requiring a click into each tool entry. This is deliberately small and deliberately gated — it is real polish, not adoption-path work, and should not be built ahead of evidence that review pain is an actual daily friction point.

## Approach

- `TranscriptTimeline.tsx:307`'s `open={running}` becomes `open={running || isLatestTurn}` (or equivalent) — the most recent turn's thinking entry stays expanded once its turn is the last one in the timeline, even after streaming ends; older turns keep today's fold-on-completion behavior. Requires threading "is this the latest turn's thinking entry" down to the row (likely already derivable from entry ordering/index — confirm against how `TranscriptTimeline` groups entries into turns before assuming a new prop is needed).
- Tool-check outcomes: find wherever a tool entry currently only shows "ran" without pass/fail (the `ToolCallRow`/`ToolCallGroup` components this same file already renders per :298-301) and surface a compact pass/fail indicator in the collapsed summary row — so scanning the folded timeline shows which checks passed without expanding each one. Scope this to whatever "tool-check outcome" data already exists on the transcript entry type; do not invent a new outcome-classification scheme if the entry shape doesn't already carry one — if it doesn't, that's a finding to report back, not a reason to bolt on a parallel classifier here.
- One concern, small: resist folding in any other timeline polish while touching this file.

## Cross-Repo Side Effects

None — webapp-only, presentation-layer change to an existing component.

## Verify

- Live: run a multi-turn thread, confirm the latest turn's thinking stays open after streaming completes while a prior turn's thinking is still folded.
- Live: run a turn with at least one tool call that fails a check (or one that passes), confirm the summary row shows the outcome without expanding.
- Unit test if `TranscriptTimeline.tsx` has existing render tests to extend for the "latest turn" branching logic (check for a co-located `.test.tsx` before assuming there isn't one).
