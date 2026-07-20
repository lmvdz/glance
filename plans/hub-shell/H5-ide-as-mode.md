# IDE-as-mode: entries, exits, what survives

STATUS: open
PARENT: hub-shell

Workspace shell keeps Header/TabBar/SidebarRail/StatusBar VERBATIM (demote = reachability, not redesign — keeps terax modules rebasable). Entries: Open worktree (C06), Open-With/CLI target, palette 'Open workspace', adopt flow. Exit: 'Threads' button at Header left + shortcut + palette item. Agent-notification activation flips to workspace before focusing a tab. Shortcuts gated on shellMode (dead while hub visible). TOUCHES: App.tsx, header/Header.tsx (one button), shortcuts, command-palette. SIZE S. AFTER H0.
