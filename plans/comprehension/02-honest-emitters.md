# Honest attention emitters: viewport diff-viewed, pr-reviewed, answer-read
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 01
TOUCHES: webapp/src/components/IntervenceView.tsx, webapp/src/lib/attention.ts, webapp/src/lib/api.ts, webapp/src/components/CommandPalette.tsx, src/index.ts

## Goal
Attention events that mean what they claim: a file is "seen" only when its diff section actually entered the viewport of a visible tab; an answer is "read" only on an explicit display path. Mount alone emits nothing.

## Approach
1. **diff-viewed** (`IntervenceView.tsx`): attach an `IntersectionObserver` to each per-file diff section (the `diffs?.map(...)` list). Emit `{kind:'diff-viewed', repo, file, agentId}` when a file section intersects ≥50% AND `document.visibilityState === 'visible'`, subject to the pure `shouldEmit` 5-minute floor from concern 01. The 4s working-poll must not re-emit: floor key is `(agentId,file)`, not content hash. Keep all decision logic in `webapp/src/lib/attention.ts` pure helpers (tested); the component only wires observers.
2. **pr-reviewed** (`IntervenceView.tsx` / wherever the PR link renders): on click-through to the PR URL, emit `{kind:'pr-reviewed', repo, agentId, prNumber}` plus one `diff-viewed`-equivalent map entry per file in the *currently loaded* diff set (send as individual events or a batched loop — keep the API single-event; a loop is fine at these volumes).
3. **answer-read**:
   - Webapp: when a fabric `answer` row (concern 10) or any answer detail is expanded/rendered — for now, wire the palette's answer-row selection (`CommandPalette.tsx`) to emit `{kind:'answer-read', repo, answerId}`. If no answer rows exist yet (concern 10 later), leave the palette emission behind a small helper that concern 10 calls — do not invent UI.
   - CLI (`src/index.ts`): in `cmdAsk`'s interactive display path (after printing a non-`--json` answer) and in `--read <id>`, POST the same event via the daemon API with the CLI's token. Guard: `--json`/`--no-wait` paths emit nothing (machine consumption).
4. No `debrief-heard` anywhere in this concern (reserved for concern 11).

## Cross-Repo Side Effects
None.

## Verify
`cd webapp && bun test && bunx tsc --noEmit` green (pure helpers: floor keying, visibility gating decisions). Manual: open Intervene on a multi-file diff, don't scroll — only above-the-fold files appear in `attention-seen.json`; scroll to the bottom — the rest appear; background the tab and scroll — nothing new; `glance ask --json` marks nothing read.
