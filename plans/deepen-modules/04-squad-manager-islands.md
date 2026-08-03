# SquadManager islands — delete the pass-through shells, move the self-contained clusters
STATUS: in-progress
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (voice 12590–12890, channels 12513–12590, attention 10428–10490, capabilities 2856–3018, feedback 3019–3250, projects 3319–3540), callers in src/server.ts + src/tui.ts
MODE: afk

## Goal
SquadManager's 229-method interface shrinks for zero behaviour change: ~20 voice methods are
literal `return this.voiceCall.X(...)` (deletion-test failures — expose the collaborator at the
seam instead), channels 9 and attention 6 likewise; capabilities/feedback/projects/observability
(~2,400 lines) never touch `agents` and move to sibling modules. Scan-verified near-zero risk for
17% of the file. The deeper `AgentRecord` untangling (6 clusters mutate it in place) is a LATER
concern — do not attempt it here.

## Provenance
Memory-lane report candidate 4 + whole-repo report candidate 1 (its top recommendation, paired
with 05): the two god modules absorb over a third of recent commits and every lane's tests.

## REVIEW CLAIM REFUTED — do not delete the voice shells
Adjudicated against the code 2026-08-03 (iteration 4): the ~15 voice "pass-throughs" are NOT
deletion-test failures in the current tree — every one performs the `canReadChannel(channelId,
actor)` membership gate before delegating, because `VoiceCallCoordinator` deliberately has no
Actor/RBAC concept (its module doc: "it knows nothing about ChannelStore/AgentDTO/RBAC").
They are the voice lane's AUTHORIZATION seam. Deleting them would scatter RBAC checks into every
caller — a security regression, not a deepening. If they ever move, they move TOGETHER as a
voice-surface module that keeps the gate; they never get deleted. Same caution applies to the
channels/attention delegations — verify what each shell actually adds before calling it a shell.

## Slice ledger
- Island #1 feedback lane → src/feedback-lane.ts (2026-08-03): 12 methods' implementations
  (~230 lines incl. the payout state machine) behind FeedbackLaneDeps (loadFeedback/saveFeedback/
  stateDir/paymentProvider/audit, all closures — field-init runs before ctor assignments);
  manager keeps thin delegations, so feedback-routes.ts and all 6 test files are untouched.
- Next: capabilities island (needs a `create` port — runCapability spawns units); then projects,
  observability reads.
