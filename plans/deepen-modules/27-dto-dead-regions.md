# dto.ts dead regions — delete, then split by consumer
STATUS: done
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

## Done (2026-08-11/12, round 3 iteration 10 — adjudicated against the round's own outcomes)
The round-2 inventory decayed under this round's sibling landings, and the honest execution is
an ADJUDICATION, not the original deletion list:
- EXECUTED: the four dead api.ts client functions deleted (getOrgVoiceStatus, fetchLearningLoop,
  fetchAfterActions, browseSymptoms — each had zero production callers; their daemon endpoints
  stay, the CLI still consumes them: a one-sided client deletion by design). EpisodeDTO stays
  (fetchEpisode is alive). The "dead" type-name exports with live intra-file signature uses
  (StartVoiceCallInput, VoiceConfigResponse, the voice decision unions) are structural members of
  live functions, not dead code — the round-2 name-grep overcounted.
- SUPERSEDED by concern 24's mirror-and-gate outcome: deleting the wire-mirrored families
  (session/subagents/planRevisionCandidates/trace/HarnessScorecardDTO etc.) three hours after the
  round gave those exact fields cross-lineage-blessed conformance pairs would whipsaw the
  direction the round chose. Three of the eight "dead" families are ALIVE today anyway
  (harnessScorecard via insights' shadow deliverable, receipt via TranscriptTimeline/MetaBar,
  contextBundle via task-model). The truly reader-less fields are now conformance-DOCUMENTED
  mirrors; if a future round wants them gone, each deletion is one omit-list entry + one field —
  a named decision, exactly what the machinery was built for.
- The split-by-consumer half was executed by siblings: kernel = #375's re-exports; wire
  protocol = #373's gate. Nothing of the split remains unowned.
