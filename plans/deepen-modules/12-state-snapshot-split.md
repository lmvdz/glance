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

## Provenance
Whole-repo report candidate 7 (Worth exploring). Coordinate with 02's follow-up (a decisions
store method would end the ledger's ride-along on the features blob).
