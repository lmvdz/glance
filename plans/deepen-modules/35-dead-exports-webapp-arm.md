# Dead-exports scanner: a webapp arm — the missing guard behind three findings
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: simple
TOUCHES: scripts/dead-exports.ts:11-12 (candidate universe = src/** only; webapp/** is reference-only), tests/dead-exports-ratchet.test.ts; NOTE the parser-based scanner rewrite + honest re-baseline lives on PR #370 — build on that version, not main's
MODE: afk

## Goal
Nothing scans webapp/** exports, and since tests are typechecked a test-only import keeps any
symbol compiling and green forever. This round's inventory of green-but-unreachable surfaces —
VoiceCallHudView + callIsIdleCritical (26 test render sites), the SpawnConfirmSheet/
SpawnStatusCard/SpawnProposalCard hub trio, spawnProposalFor's detection half (7 cases),
AdoptCard, the idle-copy assertions — all survive because no gate looks. Extend the candidate
universe to webapp/src/**/*.ts{,x} with *.test.* excluded from the REFERENCE set (a test-only
reference is not a liveness proof), baseline honestly, ratchet. One change converts the whole
unreachable-surface class from invisible to counted.

## Provenance
Round-3 review, webapp agent items 7 + 9c — named as the guard whose absence produced the
round's headline findings.
