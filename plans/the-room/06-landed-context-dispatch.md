# Landed-context at dispatch — siblings learn producer results (buzz-borrows 02, carried over)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (createWithId prompt assembly ~:5902, steer prompt composition), src/land-assessment/store.ts (read API), src/digest.ts (consumers), tests
MODE: afk

## Goal
A newly dispatched or steered unit whose declared `requires` overlaps a recently landed sibling's
`produces` receives a manager-authored fenced "Recently landed" context block in its prompt. This
is the agent-side counterpart of channel cards (which serve humans) and the surviving replacement
for the twice-killed outbox: the spawn gate (requiresConflict, src/ownership.ts:122) means
dependents spawn AFTER the land, so dispatch is the moment they exist.

## Approach
Carried over verbatim from plans/buzz-borrows/02-landed-context-at-dispatch.md (adversarially
reviewed 2026-07-21) — read that file on the worktree-research-buzz branch (or its copy once
concern 24 lands the disposition) for the full approach: land-assessment store + transitions
fallback read; overlap helper (do NOT reuse requiresConflict — wrong direction, skips stopped
owners); compose at the appendSystemPrompt join (:5902); steer-path injection bounded to lands
since last turn; neutralize+redact/fenceUntrusted on all agent-influenced strings;
deliverPeerMessage untouched; block bounded with a tested cap.

## Cross-Repo Side Effects
None. UI-invisible.

## Verify
Per buzz-borrows 02: land A (produces src/foo/), dispatch B (requires src/foo/) → B's opening
prompt contains the fenced block naming A's land/branch/sha; no-requires dispatch → ≤5-line digest
or nothing; flag-off fallback works; fence-garbage neutralized; prompt-size cap asserted in tests.
