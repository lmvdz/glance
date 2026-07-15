# Plane write primitives: body update + fail-closed named-state move
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/plane.ts, tests/plane-writes.test.ts (new)

## Goal
Two minimal, safe Plane writers the promoter (concern 05) needs: `updatePlaneIssueBody` with clobber protection, and `movePlaneIssueToState` that never falls through to an unintended state.

## Approach
- `updatePlaneIssueBody(repo, issueId, descriptionHtml, opts?: {expectHash?: string})` — PATCH `description_html`, mirroring `transitionTo`'s request shape (src/plane.ts:360-370). Plane has no If-Match/ETag, so clobber protection is application-level (red-team S4): the caller passes the hash of the body it read; the writer re-fetches, compares, and refuses with a distinct error when the body changed underneath. Callers embed an HTML-comment promotion marker (`<!-- promoted:<sha>:<date> -->`) so re-promotion is detectable.
- `movePlaneIssueToState(repo, issueId, stateName)` — **named-state-or-no-write** (red-team S6: generalizing `reopenPlaneIssue`'s name-then-group fallback, plane.ts:378-389, fails open — a missing named state would drop the issue into whatever sorts first in the group, potentially auto-releasing to Todo). Exact name match against the project's state list; no match ⇒ typed error, zero writes. `reopenPlaneIssue` keeps its fallback (its context wants best-effort); this primitive is for state machines.
- Both writers no-op with a loud log in multi-org/DB mode until Plane config is per-org (red-team S4: squad-manager.ts:1052-1056 documents the same hazard for the dispatcher; writers are worse than reads).

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/plane-writes.test.ts` against a mocked Plane fetch: body write refuses on hash mismatch; state move refuses on unknown name and writes nothing; multi-org guard no-ops.
- Live (optional, operator Plane): `updatePlaneIssueBody` round-trip on a scratch ticket preserves the marker; `movePlaneIssueToState(..., "NoSuchState")` errors without a state change.
