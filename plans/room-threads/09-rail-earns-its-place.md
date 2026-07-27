# The rail earns its place — doors, names, and empty states
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/hub/ChannelRail.tsx, webapp/src/components/CapabilityPanel.tsx, webapp/src/components/CommandPalette.tsx, webapp/src/lib/channelTimeline.ts, tests
MODE: afk

## Goal
Every standing surface answers a question someone actually has, under a name they would use.

## Approach
1. **Audit the workbench doors.** Fleet, Tasks, Graph, Capabilities all sit at equal weight in the
   rail. "Capabilities" fails three ways at once, and it is the test case: it is named for its
   implementation (a capability-pack registry), it answers a setup question asked roughly once rather
   than a continuous one, and it is EMPTY until someone imports a pack — so a first boot clicks it and
   learns nothing. Move setup-shaped surfaces behind the command palette, which already indexes them.
   Keep in the rail only what a person opens repeatedly.
2. **Empty states must teach.** A door that can be empty says what it is for and how to fill it. Blank
   is not a state, it is an absence — the same rule this program keeps re-learning at the data layer,
   applied to the UI.
3. **Identity at a glance, address on demand** (DESIGN.md standing rule). `pinnedChip` in
   `lib/channelTimeline.ts` already does this for repo paths and generated branch names; extend it as
   new chips appear, and keep `full` populated so the exact value stays reachable.
4. Rename anything else in the rail that names a mechanism rather than a job.

## Cross-Repo Side Effects
None.

## Verify
- No rail door leads to a surface that is empty by default with nothing explaining it.
- A pinned chip shows a name; its full value is reachable and asserted present.
- Every rail label survives the test: would someone say this word for what they want to do?
