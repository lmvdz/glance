# Card-kind registry — one home per channel-card kind
STATUS: open
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

## Provenance
Whole-repo report candidate 4 (Worth exploring).
