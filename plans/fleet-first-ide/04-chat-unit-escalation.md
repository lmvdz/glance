# Epic E — Chat→unit escalation

STATUS: done — epic merged (see 00-meta close-out); verified on main, 2026-07-21 reality audit
PRIORITY: p2
REPOS: glance-desktop, omp-squad
COMPLEXITY: architectural
BLOCKED_BY: epic I

## Charter (loop expands into a sub-plan when unblocked)

Chat and units become the same thing at different sizes. The cockpit's BYOK chat panel gains a daemon-backed session mode; "promote to unit" turns a conversation into a worktree-isolated, gated, landable unit without changing windows (the reverse of intervene). Ad-hoc CLI sessions detected via Epic B's hooks become adoptable: capture the diff, promote to a unit, run it through the gates. Daemon-side: session-create-from-transcript endpoint, diff-capture intake. Cockpit-side: chat transport switch, promote affordance, adoption flow from the notification bell.

Expansion trigger: Epic I merged (shared-workspace primitives are what escalated chats land into).
