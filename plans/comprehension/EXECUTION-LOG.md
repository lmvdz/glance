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
