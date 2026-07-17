# Transcript cursor integrity — streaming entries must finish rendering

STATUS: open
PRIORITY: p0
REPOS: glance-desktop, omp-squad (filed ticket only)
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/lib/fleetTranscript.ts, src/modules/fleet/store/fleetTranscriptStore.ts (or equivalent store file), fleet transcript type declarations

## Goal

A transcript entry caught mid-stream (assistant text growing, tool running) reaches its final state in the cockpit. Today it never does — this is a live bug in ConversationView and would freeze every R2 surface (ladder states, work-row grouping, timeline folds, diff availability).

## Approach

Red-team-verified mechanism: the daemon mutates streaming entries **in place without bumping `seq`** (finalization arrives via a WS channel the webview's CSP blocks), while the fleet store polls `transcript?since=maxSeq` and the daemon filters strictly `seq > since` — so a mutated entry is never re-delivered.

1. **Cursor policy**: poll with `since = min(seq of entries locally in a running/streaming state) − 1` instead of `maxSeq` — i.e. hold a floor below the oldest unsettled entry; `mergeTranscript` already upserts by seq so re-delivered entries update in place. Exclude `kind:"system"` pending-gate entries from the floor (they are appended as `running` and never mutated — including them pins the cursor forever).
2. **Widen the local types** to the daemon's real wire shape (verified richer than FleetClient admits): `tool.callId/args/result/isError/durationMs`, monotonic global `seq`, stable `id`, kinds user/assistant/thinking/tool/system. `normalizeTranscript` filters but never strips — widening types is the whole schema task; no daemon change needed.
3. **Known daemon quirks to design around, client-side**: `seq` is manager-global (per-agent gaps are normal — never use seq for positional math; use array index), and the 800-entry ring cap bounds history.
4. **File the daemon bug upstream** (omp-squad): `transcriptSeq` is not re-seeded after daemon restart — restored entries can outrank new ones → cursor deadlock + seq collisions. File as a Plane issue (OMPSQ) with the evidence pointer (squad-manager.ts append chokepoint ~L10292); fixing it is daemon work outside this plan.
5. Keep CSS-animation stability: merge must preserve object identity for unchanged entries so pulse animations don't restart on poll (existing upsert already does; add a test).

## Cross-Repo Side Effects

omp-squad: one filed Plane issue (seq re-seed after restart). No code changes in this concern.

## Verify

- Unit tests: a mocked poll sequence where a `tool` entry arrives `running` then mutates server-side — with the old cursor it stays frozen (regression demo), with the floor cursor it settles. System pending-gate entry does NOT pin the floor.
- Live (scratch daemon + real unit): drive a tool-using turn; watch ConversationView — tool row transitions running→done and assistant text reaches its final form without reselecting the unit.
- Plane issue exists and links back to this concern.
