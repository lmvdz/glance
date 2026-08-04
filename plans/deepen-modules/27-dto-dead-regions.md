# dto.ts dead regions — delete, then split by consumer
STATUS: open
PRIORITY: p3
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/dto.ts (122/893 lines dead across 8 container families: trace cluster, HarnessScorecardDTO, SubagentNodeDTO, AgentSessionSummaryDTO, PlanAnnotationTargetDTO, VoiceCallTranscriptTurnDTO, ReceiptRollupDTO, FeatureContextBundleDTO), 5 dead AgentDTO fields, 4 dead api.ts exports
MODE: afk

## Goal
Delete the dead 14%, then split survivors: kernel (blocked on PR #315 re-exports), wire
protocol (concern 24 guards it), per-surface families co-located with their single consumers.
SEQUENCE AFTER concern 23 (the corpus referencing these is exactly what no compiler reads) and
re-verify against PRs #315/#319. Check the daemon side per region — a dead DTO whose endpoint
still serves is a two-sided deletion.

## Provenance
Round-2 review, webapp agent, rank 5, Worth exploring.
