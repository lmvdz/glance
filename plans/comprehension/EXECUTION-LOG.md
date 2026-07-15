# Execution log: comprehension lane

## Batch 1 (concerns 01, 05)
| Concern | Model | Result | Review |
|---|---|---|---|
| 01 attention substrate | sonnet (worktree) | SUCCESS — 55fe014, merged 0ccb162 | PASS (fable) |
| 05 teaching producers | sonnet (worktree) | SUCCESS — 3ce74de, merged c40cddb | FAIL → fixed in fixer round |

Review findings (fable): 05 CRITICAL — server.ts `featureDecisions` PATCH sanitizer coerced stored
model-deltas to source:"human" and dropped evidence on the webapp's full-array round-trip; fixed by
merge-by-id (stored source/evidence/sourceRef survive; new client entries still down-tiered; PATCH
can never mint model-deltas). Minors: `..` traversal past the whereToLook stat floor (now lexical-
rejected as missing); no length caps on agent-supplied teaching fields (added: delta text 2000,
evidence ≤8×512; symptom 2000, whereToLook entry 512).

Shared-file changelog for batch 2:
- src/attention.ts: AttentionStore (record/lastSeen/seenMapFor/recentEvents), redactAttentionForActor,
  redactSeenMapForActor. Manager surface: attentionVisibleRepos, recordAttention, attentionEvents,
  attentionSeen, attentionDisabled, storedFeatureDecisions. Daemon type alias: OperatorAttentionEvent
  (src/types.ts has an unrelated AttentionEvent).
- Routes live: POST/GET /api/attention, GET /api/attention/seen (viewer tier). Kill switch GLANCE_ATTENTION=0.
- webapp/src/lib/attention.ts: reportAttention(), shouldEmit() floor helper; webapp kind type is
  OperatorAttentionKind (insights.ts owns the name AttentionKind).
- src/symptoms.ts: SymptomEntry store + validators (listSymptoms/readSymptom; manager.symptoms()/symptom());
  floors incl. MAX_SYMPTOM_LEN/MAX_WHERE_TO_LOOK_ENTRY_LEN. src/decision-evidence.ts: validateModelDelta.
- FeatureDecision.source includes "model-delta" + evidence?: string[]; MCP tools squad_record_decision
  (extended) + squad_record_symptom, both gated by OMP_SQUAD_DECISION_CAPTURE.
- server.ts featureDecisions(value, stored) is exported; call it with manager.storedFeatureDecisions(id).

Baseline note: root suite has one non-reproducing flake (three observations, never the same twice,
full-green run confirmed post-fix); acp-agent-driver "unhandled error between tests" is pre-existing.

## Batch 2 (concerns 02, 03, 06, 07)
| Concern | Model | Result | Review |
|---|---|---|---|
| 02 honest emitters | sonnet (worktree) | SUCCESS — 95e8a53 | PASS |
| 03 fog computation | sonnet (worktree) | SUCCESS — 82df3b0 | PASS |
| 06 PR body projection | sonnet (worktree) | SUCCESS — d6f2330 | PASS (1 minor, fixed) |
| 07 symptom consumption | sonnet (worktree, salvage-retry after session-limit kill) | SUCCESS — fbaafb3 | PASS (1 minor, fixed) |

Review minors fixed post-merge: prBodyFor now filters deltas on sourceRef.agentId (two units on one
feature can't cross-render); GET /api/symptoms derives repos from the actor-visible set like /api/fog
(fail closed on foreign ?repo=). Concern-07 first attempt died on a session limit mid-gate; WIP was
salvaged as 547554c and a retry agent verified it unchanged.

Shared-file changelog for batch 3:
- GET /api/fog live (actor-derived repos; computeFog accepts optional surpriseCounts, SURPRISE_BOOST=8
  already implemented — concern 08 wires data through). fogKey = `${normalizeRepoPath(repo)}\0${file}`.
- IntervenceView has: IntersectionObserver diff-viewed wiring, attentionFloorRef, PR link in AgentMetaBar.
- webapp/src/lib/attention.ts: shouldEmitDiffViewed, prReviewedEvents, reportAnswerRead (unwired, for
  concern 10), diffViewedKey.
- src/pr-body.ts buildPrBody (testExecutions renders declared "no observed test runs recorded" — receipts
  carry no command/outcome; wiring real gate provenance is a named follow-up). PendingPr carries featureId.
- Fabric now has symptom fact kind; PRIMER_LABEL + TYPE_LABELS updated; rankKbDocs extracted and shared.
- Doctor: matchSymptom overlap-coefficient auto-match on failing checks + symptom-index summary row.
