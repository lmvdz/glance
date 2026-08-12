# WorkScopeProbe — the land lane's git-inspection half
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/squad-manager.ts 5572–5810 (12 methods: trackAheadUnknown, fileAheadUnknownEscalation, trackedDirtyCount, untrackedInMain, filesOnAgentBranch, uncommittedInWorktree, changedFilesVsBase, fileScopeFinding, fileLandBlockedFinding, fileLandBlockedEscalation, stageCostGateConfirm, fileMembraneBreakerFinding)
MODE: afk

## Goal
The land lane (4319–5810) is the manager's most tangled island — 44 methods, 62 distinct
`this.` fields — but the tangle is mostly this probe family living inside it: pure
git-inspection + finding-authoring that touches almost nothing beyond `repo`, `rec.dto`, and
the finding sink. Extract `WorkScopeProbe` behind a small deps port (repo path, finding sink,
log). Do this BEFORE any LandLane attempt (seam B, below the cut in round 3): the 62-field
count is a symptom of A-inside-B — re-measure the lane after this lands and decide seam B on
the new numbers. Target shape is the voice surface (23 delegations / 12 fields over a
64-method coordinator).

## Provenance
Round-3 review, daemon agent, ranked 1 of the daemon extractions.
