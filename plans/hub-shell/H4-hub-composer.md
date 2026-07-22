# hub composer + thread top bar

STATUS: cancelled
PARENT: hub-shell

Grow ComposerShell (footerLeft/right slots exist) into the hub: 'Ask for follow-up changes or attach images', footerLeft = model chip+effort+mode+access, footerRight = cost/token ring + send. Real today: mode→setMode(autonomyMode), ring→contextPct + receipt cost/tokens. Gaps render-disabled until daemon (H7): per-thread model + mid-thread switch, effort, access/sandbox. Thread top bar: title + Open(→workspace) + Commit&push (disabled until POST /api/agents/:id/land, H7). IntervenePane header→this bar; 'why stopped'→quiet status line. TOUCHES: IntervenePane.tsx, ComposerShell.tsx, new composer/HubComposerControls.tsx + CostRing.tsx, fleetClient.ts (land stub). SIZE M. Idiom from DaemonModeToggle/PromoteToUnitButton (Promote stays as a chip). VERIFY: live steer + ring on scratch daemon. Taste-critical.

## Resolution
Superseded 2026-07-22 by plans/the-room — the thesis (chat as root, expert surfaces as modes)
is absorbed as HubShell-in-webapp (the-room DESIGN.md, decision "Shell"); the method (executing
inside glance-desktop) is retired with the fork (unused, non-working — Lars directive). See
plans/the-room/07-hubshell-root.md for the successor concern.
