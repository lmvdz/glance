# Audit view + liveness / attention signals
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/audit/*, webapp/src/lib/*

## Goal
An audit log view, plus ambient attention routing so the operator is *notified* without staring —
"route attention, don't demand it" (`plans/squad-ui-ux`).

## Approach
- **Audit** — `GET /api/audit?limit=&action=` (`AuditEntry` `types.ts:451`), newest-first, filter by
  action; prepend live `audit` WS events so an open view stays current with no poll.
- **Liveness** — document title + favicon badge = waiting count (`input`+`error`); optional
  `Notification` on a new blocked/errored agent (permission-gated); a staleness cue on agents whose
  `lastActivity` is old. Reuse the squad-ui-ux web patterns.

## Cross-Repo Side Effects
None.

## Verify
- Audit lists actions and updates live on an `audit` event; action filter works.
- Title shows `(N) …` when N agents wait; a notification fires on a newly-blocked agent (perm granted).
