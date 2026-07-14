# Epic I — Shared-workspace intervention

STATUS: blocked
PRIORITY: p2
REPOS: glance-desktop, omp-squad
COMPLEXITY: architectural
BLOCKED_BY: C04, C05, C06, C07, B03

## Charter (loop expands into a sub-plan when unblocked)

Intervening stops being a form and becomes opening the unit's worktree as a peer of the agent: the cockpit editor surfaces glance's presence/lease state (who holds which file), a conversation pane speaks to the unit's harness over ACP (never keystroke injection — the terax `send_to_agent` anti-pattern is the negative proof), and hand-back returns the unit to the pipeline with the human's edits visible to the agent. Daemon-side: presence/lease read API if not already exposed; per-unit ACP session attach endpoint. Cockpit-side: editor gutter/status presence indicators, conversation pane bound to the intervene lane.

Expansion trigger: C04–C07 merged and lived-with; B03 merged (attribution substrate). The loop runs a fresh /plan-style decomposition against the then-current cockpit code — do not pre-plan against code that doesn't exist yet.
