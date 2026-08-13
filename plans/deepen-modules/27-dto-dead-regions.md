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
The round-2 inventory decayed under this round's sibling landings; execution is an ADJUDICATION
with every liveness claim independently verified by BOTH lineages (each corrected me once):
- EXECUTED: three dead api.ts client functions deleted (fetchLearningLoop, fetchAfterActions,
  browseSymptoms — zero references anywhere incl. the typed-tests branch). The fourth,
  getOrgVoiceStatus, turned out to be the CORRECT wrapper for a live production bug: PeopleSurface
  fetched /api/org/voice-key raw (GET 404s there — PUT/DELETE only) and swallowed the 404 into
  "no key stored", a false admin surface offering to replace a live key. RESTORED + the caller
  fixed (codex H). Daemon endpoints all stay: after-action has a CLI consumer (index.ts cmdAar),
  the others carry route tests + documented contracts — retention justified per-endpoint, not by
  a blanket "CLI consumes them".
- FAMILY LIVENESS, corrected twice: of the eight round-2 "dead" families, FIVE are alive
  (HarnessScorecardDTO via insights, ReceiptRollupDTO via MetaBar/TranscriptTimeline,
  FeatureContextBundleDTO via task-model, PlanAnnotationTargetDTO via plan-doc-review.ts,
  VoiceCallTranscriptTurnDTO via useVoiceCallTranscript) and THREE dead (trace cluster,
  SubagentNodeDTO/AgentDTO.subagents, AgentSessionSummaryDTO/AgentDTO.session). Separately,
  AgentDTO.planRevisionCandidates (not one of the eight) is alive at task-model.ts:120.
- SUPERSEDED by concern 24's mirror-and-gate outcome: deleting the three genuinely-dead
  wire-mirrored families hours after they got cross-lineage-blessed conformance pairs would
  whipsaw the round's direction. They stay as conformance-documented mirrors; a future deletion
  is one omit-list entry + one field each — a named decision, exactly what the machinery is for.
- The split-by-consumer half was executed by siblings: kernel = #375's re-exports; wire
  protocol = #373's gate. Nothing of the split remains unowned.
