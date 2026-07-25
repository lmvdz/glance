# Leaving the app — a three-condition gate
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/notify.ts, src/rules.ts, src/squad-manager.ts, tests
BLOCKED_BY: 11, 12
MODE: afk

## Goal
A notification that reaches a human outside the app is rare, justified by three conditions at once,
and reviewed afterwards for whether it was worth it.

## Approach
Reference: `reference/04-beyond.html` → 1a, 1b.

1. **All three conditions must hold**, and the record names each: no rule can settle it; it blocks work
   that would otherwise be moving; and it can be answered in one sentence. Two out of three does not
   leave the app.
2. **A delay is mandatory** — long enough for the fleet to recover on its own. Many things that look
   blocking at minute zero are settled by minute nine.
3. The out-of-hours contact rule is **the human's own sentence** and is the one thing cold start cannot
   default (concern 16).
4. Every external notification gets a **"was it worth it?" review** afterwards, retained, and feeding
   back into whether the conditions were read correctly.
5. The notification itself states its blast radius, like every interruption.

## Cross-Repo Side Effects
None.

## Verify
- A notification with only two conditions satisfied is not sent, and the record says which failed.
- The delay is enforced; a condition that clears during the delay cancels the send.
- Every sent notification has a review record, and unreviewed sends are visible.
- Out-of-hours contact has no default value in a fresh install.
