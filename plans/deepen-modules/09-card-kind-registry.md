# Card-kind registry — one home per channel-card kind
STATUS: done
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
UNBLOCKED (2026-08-04, merge train): the blocking merges (#317) landed — resumable. Original question was: merge PR #317 (concern 08 slice 1 — the shared transcript-event-kinds
module). The registry this concern wants (one registration carrying schema + face + render)
BUILDS ON that module: #317 already made the webapp's kind union and POINTER/iconClass tables
compile-time-forced from the shared list; the registry's remaining step is deriving the daemon
schema table and the webapp face/render dispatch from one registration object keyed by the
SAME shared kinds. Working it off main would fork the module; stacking on #317 recreates the
wrong-base trap. Design sketch recorded here so the slice is ready the moment the merge lands.

## Provenance
Whole-repo report candidate 4 (Worth exploring).

## Done (2026-08-11, round 3 iteration 8 — PR #376)
The registry exists and is the ONE registration: webapp/src/lib/cardKindRegistry.ts carries tone
policy + door label + icon per kind, satisfies-exhaustive over concern 08's shared list + the
local kinds; toneFor/DOOR_LABELS/iconClass are derivations, and (codex round) the POINTER/LOCAL
recognition maps derive from the registry keys too — a new daemon kind is now a compile error at
exactly ONE webapp entry plus the daemon schema table (itself already satisfies-forced). The
silent ''Open'' and neutral fallbacks became explicit per-kind decisions with identical rendered
text (codex proved equivalence across 3,600 tone combinations, all 24 icons, every label).
HONEST LIMITS recorded in the module: land/gate-verdict bespoke renderers own their live
rendering (registry fields are fallback-path-only there — unifying them is follow-up), and codex
M2 found the same disease one layer deeper in the daemon (projectionClasses quiet node fallback,
8/19 kinds unlisted; projectionDoorSurface silent unit default) — QUEUED for the round-3 review.
Grok narration-only (gap row). Gates: check 0, sync 3/3, schemas 47/47, webapp 2002/0, vite
green, root 5332/2-inherited.
