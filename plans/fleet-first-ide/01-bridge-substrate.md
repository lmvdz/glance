# Epic B — Bridge substrate (glance-side, no fork required)

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
SUB_PLAN: plans/fleet-ide-bridge/

## Charter

The three capabilities every later epic assumes, all pure glance-repo work: a terminal-native attention lane (OSC markers — any OSC-aware terminal, cockpit included, surfaces fleet attention), a one-action jump from fleet view to a unit's worktree (`glance open`), and hook-based self-reporting from foreign harness CLIs so ad-hoc sessions are attributed and later adoptable (Epic E's raw material).

Fully expanded in `plans/fleet-ide-bridge/` — concerns B01 (osc-attention-emitter), B02 (glance-open), B03 (harness-hook-reporting). All three are parallel-safe with Epic C.
