# Finish the StateSnapshot split — per-lane stores
STATUS: open
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

## Follow-ups (recorded, deliberately not in slice 1)
- Post-stop ingress race (codex M2, adjudicated pre-existing CLASS): the HTTP server keeps
  accepting mutations while manager.stop() runs, so a write enqueued after any durability
  barrier (blob writeChain, feedback saves, capability chain alike) is lost on exit. Wants a
  stopping-flag/ingress-quiesce design across ALL lanes, not a capability-only patch.
- Remaining blob lanes for later slices: features (would also end the decision ledger's
  ride-along — 02's follow-up), transcripts, then the agents core.

## Provenance
Whole-repo report candidate 7 (Worth exploring). Coordinate with 02's follow-up (a decisions
store method would end the ledger's ride-along on the features blob).
