# IDE-as-mode: entries, exits, what survives

STATUS: cancelled
PARENT: hub-shell

Workspace shell keeps Header/TabBar/SidebarRail/StatusBar VERBATIM (demote = reachability, not redesign — keeps terax modules rebasable). Entries: Open worktree (C06), Open-With/CLI target, palette 'Open workspace', adopt flow. Exit: 'Threads' button at Header left + shortcut + palette item. Agent-notification activation flips to workspace before focusing a tab. Shortcuts gated on shellMode (dead while hub visible). TOUCHES: App.tsx, header/Header.tsx (one button), shortcuts, command-palette. SIZE S. AFTER H0.

## Resolution
Superseded 2026-07-22 by plans/the-room — the thesis (chat as root, expert surfaces as modes)
is absorbed as HubShell-in-webapp (the-room DESIGN.md, decision "Shell"); the method (executing
inside glance-desktop) is retired with the fork (unused, non-working — Lars directive). See
plans/the-room/07-hubshell-root.md for the successor concern.
