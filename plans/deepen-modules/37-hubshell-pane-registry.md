# HubShell pane registry — collapse the 5-branch ternary
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: webapp/src/components/hub/HubShell.tsx (873 lines, 78 hooks: 27 useState / 18 useEffect / 17 useMemo / 10 useCallback / 6 useRef; pane block 498–661: nested ternary 609–661 with 5 branches + 34 props from 6 sources; pop-cleanup switch 557–559; 5 scattered push sites), webapp/src/lib/voice/roomCall.ts 845–918 (the pane MODEL — deep, pure, tested; leave it)
MODE: afk

## Goal
RoomSession removed transport, not size — HubShell is still a god component. The pane model
(WorkspacePane union, push/pop/reconcile, 74 pure lines) is already deep; the RENDER is the
shallow half: a 52-line ternary ladder, a pane-conditional hook, and a cleanup switch that
knows pane kinds by name (reconcileArtifactPane is the tell). Adding a 7th pane kind touches
7 places today. Seam: a pane registry keyed by WorkspacePane with
`{ render(ctx), onPop(ctx), reconcile?(entry, ctx) }` over a single RoomWorkspaceContext that
HubShell builds once — likely shaped as a `useRoomWorkspace(channelId, call)` hook returning
~163 lines of state out of the shell. Follow-ups in the same pass if cheap: the search block
(:156-158 + effect) as useChannelSearch; managerCardEntry/resultTitle/channelSubtitle (:64-93)
into lib/channelTimeline.ts.

## Provenance
Round-3 review, webapp agent items 2 + 5; carried (PaneStack parameterization).
