# Love gate — Lars's acceptance run on the whole room
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: scratch-daemon + agent-browser rig; plans/the-room (verdict record)
BLOCKED_BY: 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17
MODE: hitl

## Goal
The t3-face-13 protocol re-targeted at the webapp room. Lars's reaction is the real gate;
instrumentation serves his judgment, never substitutes for it.

## RE-TARGETED 2026-07-25 — this gate is on room-threads, not on the current room

Originally this gated the wave 1–3 room. That no longer makes sense: seven rounds of design
(`plans/room-threads/reference/`, ~72 states) have specified a replacement for the surface this
concern was going to judge. Cold-booting the room we are already replacing measures the wrong thing
and spends the one reaction we get.

So concern 23 now gates **room-threads** — it is the finish line of that plan, not a gate in front
of it. Consequences:

- The "no new-surface feature work until it passes" clause no longer blocks room-threads. Building
  room-threads IS the work this gate judges.
- The protocol below still stands, but runs against the room-threads shell once concern 03 lands,
  and against a fleet at REAL volume — the premise the whole plan rests on (that a linear feed
  buries human messages at 80–160 events/hour) has never been tested at that scale.
- The falsifiable axes below are superseded by the design's own success criteria, which are sharper
  and already written: see `plans/room-threads/reference/README.md`.

## Protocol
Scratch-daemon with real seeded fleet data (landed units, a pending request, a plan, receipts);
Lars cold-boots the URL. Falsifiable axes:
1. Cold-boot first frame — reads as the product's home (a chat workspace), not a panel in a
   dashboard.
2. The rail — channels + active work legible at a glance; the standing entrance works.
3. The timeline — cards read as proofs; human messages not buried (firehose check; needs-you
   near-empty law holds).
4. The composer — address an agent, get an ack, spin one up, all from chat without leaving.
5. The doors — into depth and back, including one deliberately dead/historical door that degrades
   honestly (landed-and-removed unit's gate-verdict card).
Instrumentation: agent-browser walkthrough recording; two-browser multiplayer smoke (concern 19's
recipe, if 18/19 have landed — else single-identity run noted); door-open latency numbers attached.

## Verify
- Verdict recorded here (pass / specific misses) in Lars's words; on pass, DIRECTION.md's
  foundation-gate reference updates to point at this record (with concern 24).
