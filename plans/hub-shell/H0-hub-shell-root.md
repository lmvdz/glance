# hub-shell root: two stacked shells, hub default

STATUS: open
PARENT: hub-shell

App renders BOTH shells stacked (idiom from WorkspaceSurface's invisible/pointer-events toggle, one level up); `shellMode: hub|workspace` picks the visible one so terminal PTYs/editor buffers survive mode flips. Hub = FleetLayout promoted to root inside a new minimal `HubShell` owning the window drag region + WindowControls (Header has none in hub). Boot: hub is the unconditional default; an explicit launch target (glance <path>/Open-With) boots workspace. Retire the `fleet` tab kind (+ migration dropping persisted fleet tabs). `worktreeOpener.open()` flips to workspace mode. TOUCHES: src/app/App.tsx, new src/app/hub/HubShell.tsx + shellModeStore.ts, WorkspaceSurface.tsx, cockpitBoot.ts, worktreeOpener.ts, useTabs.ts, command-palette, migrations. SIZE M. VERIFY: shell-mode tests; live tauri dev — boots to two-pane hub, no tab bar; Open worktree → IDE with Space; terminal survives round trip; glance <file> → IDE. SERIALIZED root.
