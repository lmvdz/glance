# PLAN-VOTE-COMMIT — assignee majority vote commits accumulated plan revisions

Opus design pass 2026-07-08, grounded in live code + verified against the running system.
User vision: "collaborative back-and-forth on the plan changes → at the end a majority vote (of who's
assigned to the plan) → if it passes, the changes get committed."

## Two substrate findings that reshape the feature (VERIFIED live)

1. **No human-assignee model exists.** FeatureDTO/PersistedFeature (types.ts:513,977) have no owner/
   assignee field; feature "members" are AGENTS (features.ts:855). Org membership exists only in DB
   mode (org-admin.ts:68). → **Unit 1 must make assignees real.** The vote is genuinely multi-voter
   only in DB mode; file mode = one operator identity = a solo, audited auto-pass (A=1 rule below).
2. **The plan revision is worktree-ISOLATED, not an uncommitted shared-tree diff** (VERIFIED: the
   user's reviser ran on branch `squad/plan-reviser-mrcpt9x7-1-537d3823` in its own worktree;
   squad-manager.ts:3698 "never run on the shared tree"). The edit is a committed `PlanRevisionCandidate`
   (types.ts:491, state candidate→accepted|rejected|superseded, comments.ts:118) on the reviser branch.
   → **commit-on-pass = land that branch's `plans/` edits** (safe merge); **reject = reap the worktree**
   (nothing to revert; shared tree never dirtied). Strictly better than the vision's assumed model.

## The composition (this reuses shipped primitives)

- Collaborative back-and-forth = the design-review loop (#120/#128): doc-anchored plan-annotation
  comments (comments.ts:16), the N/M-resolved gate (plan-doc-review.ts:53), terminal panel
  (DesignReviewView.tsx:507). **The vote is that panel's new terminal step.**
- Revision lifecycle already exists (PlanRevisionCandidate). The vote is the human gate flipping
  candidate→accepted (commit) or →rejected (discard).

## A. State machine (a PlanVote round; append-only plan-votes.jsonl, fold-on-read like comments.ts)
DRAFT (edits accumulating) → PROPOSED (assignee calls a vote; snapshots candidateId, planPath,
baseSha, assignee roster) → VOTING → PASSED (auto-commits) | REJECTED | EXPIRED. Outcome drives
transitionPlanRevisionCandidate on the existing candidate.

## B. Quorum + majority (the design's recommended rules — USER TO CONFIRM)
- **Pass = strict majority of the FULL assignee set**: approvals > A/2 (abstentions count as
  not-approve — silence must not commit to a shared plan). A=3→need 2; A=4→need 3; A=2→need 2
  (unanimous, deliberate).
- **A=1** (file mode / solo owner): the one approval auto-passes (1>0.5), AUDITED + labelled
  "committed by sole assignee" — not silent.
- **A=0**: cannot call a vote ("assign someone first"); author auto-added as assignee on first save,
  so A=0 is rare.
- Tie (exactly A/2): fails the strict `>`; waits or expires. No coin-flip. One assignee one vote;
  calling ≠ voting; author has no extra weight.

## C. Vote UI (DesignReviewView terminal state)
Gated on reviewGateOpen (all comments resolved — keeps the back-and-forth terminal). "Call for vote"
(assignee-only) → quorum line ("needs 2 of 3") + per-assignee StatusChips (pending neutral / approve
success-green / reject ember-danger; viewer's chip interactive) + live tally over WS. Pass → emerald
"Committed to plans/<x> · <sha>" + implementation-session button. Reject → "discarded, plan unchanged."

## D. Commit-on-pass / reject
Pass → land the head candidate branch scoped to plans/<planDir> (reuse landAgent → land.ts:381,
hardenedGit). Commit msg `plan(<dir>): adopt reviewed revision — <summary>` + `Approved-by:` co-author
trailer + `Vote-round:`. Comments archived (audit), not deleted. Reject → candidate→rejected + reap
worktree (tree never touched). Idempotent via per-round committedAt; concurrent commit → first writer
wins. Base-SHA guard (H3).

## E. Trust/security
POST routes admin-gated (authz.ts); actor = db:<userId> or operator (server.ts:1131); app-layer check
actor.id ∈ feature.assignees. No double-vote (fold dedupes by actorId). A=1 self-approve audited.
Commit inherits git-harden authz. Every call/cast/pass/reject/commit → appendAudit (audit.ts:41).

## F. Backend
POST /api/features/:id/plan-vote/{call,cast} + GET; PlanVoteRound type + PlanVoteCall/CastBodySchema
(http-body.ts, drift-guard mirrored); src/plan-votes.ts (new, mirrors comments.ts fold-on-read via
getStorageBackend().appendDurable). Call-button gated on reviewGateOpen; casting independent.

## G. Units (parallel-safe)
1. **Assignees real** (BLOCKING): assignees?: string[] on Feature DTO+persist, default [author||operator],
   GET/PUT /assignees (admin) + TaskDetail editor (org-picker DB mode / operator file mode).
2. **Vote backend + schema** (dep 1): PlanVoteRound, plan-votes.ts, 3 endpoints, quorum math (pure,
   unit-tested), audit.
3. **Vote UI** (dep 2): terminal chips/tally/call in DesignReviewView + pure derivations.
4. **Commit-on-pass + reject** (dep 2): land candidate branch on pass, reap+reject, base-SHA guard,
   idempotent. Accept (LIVE): 2 assignees approve → revision COMMITS to plans/<x> (git log verified);
   reject → git status clean.

## H. Red-team + guards
1. Single-assignee rubber-stamp → intended for solo plans; audited + trailer + UI label, never silent.
2. Reject leaves tree dirty → CANNOT: revision is worktree-isolated, reject just reaps; shared tree
   never touched (the structural win over the assumed model).
3. Revision changed under the voters → round snapshots baseSha+revisionSha at call; commit refuses if
   the plan doc's committed SHA ≠ baseSha; a newer candidate marks the round superseded → voids it
   ("re-call the vote"). Voters commit exactly what they saw, or nothing.
