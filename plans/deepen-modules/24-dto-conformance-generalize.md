# DTO conformance: 1 guarded pair → 42
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical, batched
TOUCHES: tests/dto-conformance.test-d.ts (machinery complete, in the gate, applied to ValidationRecordDTO only), 25 exact-name + 17 XDTO↔X mirror pairs
MODE: afk

## Goal
LIVE DRIFT FOUND: webapp SquadEvent (dto.ts 855–873) is missing the audit, automation, and
voice-call-participant variants entirely + fields on removed/log — unrepresentable, so no
exhaustiveness check could fire; useSquad switches on 13 of the daemon's 18 kinds. Extend the
existing file ~4 lines/pair; union types need one new variant-keyed helper. COMPLEMENTARY to
the blocked kernel re-exports (deliberate divergences like TransitionEntry.reason widening
need conformance-with-omit-list, never re-export). Land in batches by DTO family — expect a
wall of real drift on first contact; every Omitted* list is an explicit decision.

## Provenance
Round-2 review, webapp agent, rank 2, Strong.

## Slice 1 (2026-08-11, round 3): 39 of 40 pairs gated; the wall, enumerated
Machinery extended (variant-keyed union checks: MissingVariants/ExtraVariants/DriftedVariants;
MismatchedSharedKeys gained an Allowed param for NAMED deliberate divergences). All pairs gated
except AgentDTO (extra-keys arm only). REAL DRIFT FIXED in webapp dto.ts (all type-only):
- SquadEvent: audit + automation + voice-call-participant variants were MISSING ENTIRELY (the
  round-2 headline); removed lacked channelId, log lacked agentId. AutomationEventDTO +
  VoiceCallParticipantDTO mirrors added.
- ClientCommand: answer/create/commission/set-mode/message/notify variants missing (create and
  commission carry shallow Record payloads — named future-granularity decisions).
- IssueRef: requires/owns/produces/scopeSource/description/lane unmirrored (dispatch scope
  contracts invisible to the UI).
- AgentSessionSummaryDTO: thinkingLevel was string (union narrowed), + steeringMode/followUpMode/
  interruptMode/systemPromptLines/tools.
- AuditEntry: target/outcome wrongly optional (the wire always stamps them), + source.
- CommandInfo: invented args field (zero readers) replaced by the real aliases/hint/source.
- FeatureDTO: + stageOverride/archived/workflowAgentId. PendingRequest: + replayed.
  TranscriptTool.callId: wrongly required. TransitionEntry: + seq/replayed, and reason's
  DELIBERATE widening is now a NAMED allowance (AllowedTransitionEntryMismatches) instead of
  invisible.

## Slice 2 (DONE 2026-08-11, round 3 iteration 9): AgentDTO
18 unmirrored source fields (approvalMode, lane, adopted, verified, requires, owns, produces,
scopeSource, harness, repoId, etaAt, queued, harnessCaps, mcpServerNames, completionPushArmed,
completionPushKind, completionArmedAt, ladderPriority) + 11 shared-key mismatches (kind +
messageCount optionality flipped; autonomyMode/effectiveMode optionality REVERSED — dto requires
what src makes optional; workflow/workflowState/workflowGraph/todoPhases cascade through the
workflow-type family needing WorkflowGraphSnapshotDTO/WorkflowRunState/TodoPhaseDTO pair checks;
availableActions/verificationState union drift; transitions resurfaces the reason allowance).
Each is a mirror-or-omit decision; the extra-keys arm is already gated so the DTO cannot invent
fields while this is open.

## Done (2026-08-11, both slices — PR #373)
44 gated pairs total (39 from slice 1 + AgentDTO three-arm + the four workflow-family leaf pairs).
Slice 2: 18 backend fields mirrored (codex verified every one exact, unions included), six
optionality corrections landed the wire's truth with zero production read changes needed, and the
codex round turned the allowance mechanism itself deeper — a REAL drift it had hidden (TodoStatus
missing abandoned: TodoPanel indexed an undeclared style) got fixed so thoroughly the todoPhases
allowance is DELETED (exact equality), and the remaining three field allowances now carry LEAF
pair gates (WorkflowRunStateDTO's 10 engine-only omissions NAMED; the node kind widening is the
one named graph divergence; Edge exact). Residual named: wrapper drift on transitions alone.
Grok narration-only both slices (gaps ledgered). Follow-up queued for the review round: codex M2
from slice 1 (daemon projectionClasses/doorSurface quiet defaults — filed under concern 09's
round too).
