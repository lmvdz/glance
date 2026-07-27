# Plan motion — stillness is not calm
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/squad-manager.ts, webapp/src/components/hub/*, tests
BLOCKED_BY: 01
MODE: afk

## Goal
The fleet notices when a plan has stopped moving without anyone deciding it should, and says so as a
message from the planner — never as a monitor.

## Approach
Reference: `reference/04-beyond.html` → 2a, 2b. Read both; 2b is the proof that the quiet screen's
celebration survives this feature.

1. **Each plan's threshold is its own measured normal**, computed from its own units — "this plan
   normally moves every 34 minutes, measured across its own eleven units; fifty-one hours is a
   hundred times that." A global configured threshold is explicitly wrong.
2. **Parked work carries no number at all**, "because parked is a decision."
3. The stall surfaces as **one conversational message from the planner**, marked "noticing, not
   alarming" — not a dashboard, not a badge, not a second surface competing for attention.
4. The quiet screen's "unbroken autonomy" celebration is **not withdrawn** when a stall exists. Both
   are true at once and the screen says both: "Calm and still are not the same thing."
5. It states the cause, the blast radius, and the recovery options with their consequences.
6. Track and surface the false-positive rate — the design shows "stalls noticed 2 in 8 weeks · 0 false."

## Cross-Repo Side Effects
None.

## Verify
- A plan that stops is detected against its own history, not a fixed number; asserted with two plans
  whose normals differ by an order of magnitude.
- Parked work never triggers it, ever.
- The quiet screen renders calm and stillness simultaneously without either negating the other.
- A stall message names what is NOT affected.
