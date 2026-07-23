# projects→threads rail

STATUS: cancelled
PARENT: hub-shell

t3's rail: ⌕ Search(⌘K) top, PROJECTS header, collapsible project groups whose rows are threads (console+units unified via isConsoleThread), each name + relative time + ONE calm status dot; ⚙ Settings pinned bottom; per-project + (createConsole(repo)). Replace SpineRow's reason-subline + attention-pill density (relocate 'why' to tooltip + detail). Projects outlive units (persisted projects cache; daemon list-projects = H7 gap). TOUCHES: spine/ThreadSpine, SpineChrome, SpineRow, GroupHeader, spineGrouping.ts(+tests), spineReason.ts(rel-time), fleetRosterStore.ts. SIZE M. Reuses buildSpineGroups/collapse/roll-ups/skeleton. VERIFY: unit tests + live screenshot vs reference. Taste-critical.

## Resolution
Superseded 2026-07-22 by plans/the-room — the thesis (chat as root, expert surfaces as modes)
is absorbed as HubShell-in-webapp (the-room DESIGN.md, decision "Shell"); the method (executing
inside glance-desktop) is retired with the fork (unused, non-working — Lars directive). See
plans/the-room/07-hubshell-root.md for the successor concern.
