# SquadManager islands — delete the pass-through shells, move the self-contained clusters
STATUS: open
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
