# Land lifecycle cards — attempt / assessment / merge in the room
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/transcript-event-kinds.ts, webapp/src/components/hub/LandCards.tsx (new), tests
BLOCKED_BY: 04, 05, 08
MODE: afk

## Goal
The land story reads in the room: land-attempt, land-assessment (commit-addressed assessment
output), and land-merge (the merge decision, with done-proof material) cards — the unit's whole
landing narrative co-located where humans watch (unit-as-room generalized to channels).

## Approach
1. Three kinds + readers together, riding concern 04's emits and 05's projection. Faces: attempt
   (branch, sha, target), assessment (risk/recommendation from the land-assessment projection),
   merge (outcome, PR url/number when PR-mode, done-proof verified tier).
2. Doors: merge card → gate-verdict door's post-mortem/proof surface (13); assessment card →
   land-assessment detail if a surface exists, else face-only proof card (face IS the proof —
   allowed: a doorless proof card is explicitly legitimate for kinds whose full material is
   pinned).
3. #fleet filter: land-merge only by default; originating channels get all three.

## Cross-Repo Side Effects
None.

## Verify
- Scratch-daemon land: originating channel shows attempt→assessment→merge in order; #fleet shows
  merge only; PR-mode land carries the PR link; faces render from pinned data with no fetch.

## Resolution
Landed in train wave3: attempt/assessment/merge card faces; merge card doors into the proof surface.
