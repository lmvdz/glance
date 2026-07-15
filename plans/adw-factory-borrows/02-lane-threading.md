# Thread lane through issue → create → unit → receipts with clamped precedence
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts, src/plane.ts, src/squad-manager.ts, src/receipts.ts, tests/lane-threading.test.ts (new)
BLOCKED_BY: 01

## Goal
Lane rides the unit end-to-end — Plane label → `IssueRef.lane` → `CreateAgentOptions.lane` → `AgentDTO.lane` → `RunReceipt.lane` — with a precedence clamp that keeps privilege axes out of ticket text's reach.

## Approach
- `src/types.ts`: `IssueRef.lane?: WorkLane`, `CreateAgentOptions.lane?: WorkLane`, `AgentDTO.lane?: WorkLane`.
- `src/plane.ts`: lane comes from **Plane labels, not title tags** (red-team C4: Scout files LLM-authored titles verbatim — titles are a fail-open privilege key; labels are human-set). The dispatcher already fetches per-issue detail at dispatch time (`dispatchSpec`, src/squad-manager.ts:1357) and `fetchIssueDetail` already resolves label names (plane.ts:287) — map a `lane:hotfix|feature|chore` label onto `IssueRef.lane` there. Bulk listing stays label-free (no new API surface).
- `src/squad-manager.ts` (~4260, where `routeIntake` runs): resolve lane with precedence `opts.lane` (operator/API) > issue label > `classifyLane()` > `"feature"`, stamp onto the record + `AgentDTO.lane`, log the source.
- **Clamp rule** (the security decision): label- and classifier-sourced lanes may only apply policy axes in shadow or in the stricter direction; privilege axes (model escalation to apply-mode, ceiling raises, race enablement beyond constants) require operator-sourced lane (`opts.lane`) or the policy-store override. Concretely v1: a labeled/classified `hotfix` logs and parameterizes shadow decisions but cannot flip `modelRouteApply` on its own.
- `src/receipts.ts`: `RunReceipt.lane?: WorkLane` stamped at write from the unit — prerequisite for concern 08's lane-keyed aggregate.
- Document coverage honestly (red-team M3): only spawn paths that pass the `autoRoute` gate get classification; explicit `workflow`/`verify`/`sandbox` spawns get lane only from `opts.lane`/label, else `"feature"`. One comment at the resolution site.

## Cross-Repo Side Effects
None. `AgentDTO.lane` is additive; webapp may render it later (not in this concern).

## Verify
- `bun test tests/lane-threading.test.ts` — precedence fixtures: opts beats label beats classifier beats default; clamp: labeled hotfix does not set apply-mode.
- Scratch daemon: create a Plane issue labeled `lane:chore`, let the dispatcher spawn it, `GET /api/agents` shows `lane: "chore"`; receipt written on completion carries the lane.
