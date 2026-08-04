# Finish the StateSnapshot split — per-lane stores
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/dal/store.ts (48-method Store interface; StateSnapshot), src/squad-manager.ts persist()/persistNow()/loadPersisted (13454–13670, ~37 persist sites)
MODE: afk

## Goal
persist() rewrites agents + all transcripts + features + capabilities as one blob through a
hand-rolled write chain; half the lanes (feedback, channels, nodes, node-records, delegation
grants, plan proposals) already escaped into their own Store methods — the migration is
unfinished. Finish it: per-lane snapshot methods (local-substitutable — FileStore/DbStore both
already exist as adapters), so a lane's write amplification and crash-window is its own.

## Slice ledger
- Slice 1 done (2026-08-04, iteration 27): the CAPABILITY lane escapes the blob —
  Store.loadCapabilities/saveCapabilities; FileStore splits to capabilities.json (existence-gated
  split-file-wins, corrupt file set aside loudly, legacy embedded fallback until the one-time
  migration lands); DbStore per-lane row methods over factored helpers; manager: emit-only
  changed dep, capabilityWriteChain with stop()-time final-flush retry, awaited migration at
  BOTH boot hydrate sites. Codex's blind round was the deepest of the queue: 4 High data-loss/
  durability windows + the illusory-fix Medium (changed → emitFeaturesChanged → full blob
  persist — the amplification the slice claimed to remove was still there) — all fixed with
  regression tests; 7 ledger rows. grok quota-flaked (gap row).

- Slice 2 done (2026-08-04, iteration 28): the FEATURES lane escapes the blob — the daemon's
  hottest mutation path stops serializing every transcript. Single-writer rule (self-caught
  pre-review: blob save + feature chain were two writers to features.json; persistNow now omits
  features and awaits the one chain, store honors only explicit callers). emitFeaturesChanged
  is features-only + emit. Codex round: 2 High survived (cross-lane membership sites —
  linkAgent/deleteFeature/adoptDerivedFeature — needed their own blob checkpoints; swallowed
  features-write failure could tombstone away a legacy boot's only copy → strict-write +
  skip-blob-on-failure), 2 Medium survived (per-entry validation gate; docs contract), 1 Medium
  adjudicated by-design (cross-lane atomicity traded for per-lane crash windows — the concern's
  own goal; generation/commit protocol noted below if it ever bites). grok quota-flaked (gap).

- Slice 3 done (2026-08-04, iteration 29): TRANSCRIPTS escape the blob — the two modes converge
  on DB mode's own separate-file layout; state.json shrinks to the agents core + tombstones.
  StateSnapshotSave formalizes optional-on-save/honor-when-passed. FIRST CROSS-LINEAGE
  CONVERGENT ROUND of the queue: grok (its first successful pass after six quota flakes,
  2H+3M+1L with a reproduced failing test) and codex (1H+1M+1L) independently found the same
  two defects — the map-value validation hole (reseedTranscriptSeq for-of-null startup abort)
  and the restart-reattach probe reading embedded transcripts. Grok's unique H1 was the
  omit-then-tombstone contract hole, which LATENTLY applied to slice 2's features too — fixed
  with a self-migrating tombstone guard for both lanes. Codex's unique Low: two more durability
  probes constructing the legacy fileset. Nine adjudicated rows.

- Agents-core disposition (2026-08-04, iteration 30) — CONCERN COMPLETE, docs-only close-out
  (no code change; no review round needed): after slices 1-3, state.json ON DISK is the agents
  lane — capabilities, features, transcripts, feedback, channels, nodes, node-records, grants
  and proposals all persist through their own files/rows. The deletion test the concern asked
  for now passes lane-by-lane: each lane's write amplification and crash window is its own.
  The 48-method Store interface itself splitting into per-lane store objects is a candidate
  for a FUTURE review round, not this concern's checklist.

## Follow-ups (recorded, deliberately not in slice 1)
- Post-stop ingress race (codex M2, adjudicated pre-existing CLASS): the HTTP server keeps
  accepting mutations while manager.stop() runs, so a write enqueued after any durability
  barrier (blob writeChain, feedback saves, capability chain alike) is lost on exit. Wants a
  stopping-flag/ingress-quiesce design across ALL lanes, not a capability-only patch.
- Per-agent transcript files + dirty tracking (the write-amplification upgrade both blind
  reviewers concur is the future path): prerequisite is the ~86-site in-place entry-mutation
  audit — a missed dirty-mark site means a mutation that NEVER persists, so this must not be
  attempted casually. Single-file write-all is correct-by-construction today.
- Store interface split into per-lane store objects (48 methods today) — a candidate for the
  next architecture-review round.

## Provenance
Whole-repo report candidate 7 (Worth exploring). Coordinate with 02's follow-up (a decisions
store method would end the ledger's ride-along on the features blob).
