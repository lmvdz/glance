# hub composer + thread top bar

STATUS: in-review (partial) — gd PR #49 ships the daemon-real half (ModeChip + ContextRing in ComposerShell footer, type-to-start HubHero); thread top bar + model/effort/access chips wait on H7 fields rather than rendering dead controls
PARENT: hub-shell

Grow ComposerShell (footerLeft/right slots exist) into the hub: 'Ask for follow-up changes or attach images', footerLeft = model chip+effort+mode+access, footerRight = cost/token ring + send. Real today: mode→setMode(autonomyMode), ring→contextPct + receipt cost/tokens. Gaps render-disabled until daemon (H7): per-thread model + mid-thread switch, effort, access/sandbox. Thread top bar: title + Open(→workspace) + Commit&push (disabled until POST /api/agents/:id/land, H7). IntervenePane header→this bar; 'why stopped'→quiet status line. TOUCHES: IntervenePane.tsx, ComposerShell.tsx, new composer/HubComposerControls.tsx + CostRing.tsx, fleetClient.ts (land stub). SIZE M. Idiom from DaemonModeToggle/PromoteToUnitButton (Promote stays as a chip). VERIFY: live steer + ring on scratch daemon. Taste-critical.
