# Card-kind registry — one home per channel-card kind
STATUS: needs-lars
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: daemon card emit sites, src/schema/channel-card.ts, webapp face/render dispatch tables
MODE: afk

## Goal
Adding one channel card kind currently touches five dispatch tables across daemon and webapp
(emit → schema → face → render) — a kind's behaviour has no locality. Deepen: a card-kind
registry where one registration carries schema + face + render so the tables are derived, not
hand-synchronized. tests/channel-card-kinds-sync.test.ts stops being the only thing holding the
tables together.

## needs-lars (2026-08-04, iteration 36)
OPEN QUESTION FOR LARS: merge PR #317 (concern 08 slice 1 — the shared transcript-event-kinds
module). The registry this concern wants (one registration carrying schema + face + render)
BUILDS ON that module: #317 already made the webapp's kind union and POINTER/iconClass tables
compile-time-forced from the shared list; the registry's remaining step is deriving the daemon
schema table and the webapp face/render dispatch from one registration object keyed by the
SAME shared kinds. Working it off main would fork the module; stacking on #317 recreates the
wrong-base trap. Design sketch recorded here so the slice is ready the moment the merge lands.

## Provenance
Whole-repo report candidate 4 (Worth exploring).
