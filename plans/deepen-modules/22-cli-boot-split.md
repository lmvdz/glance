# index.ts → boot.ts + cli/client.ts + cli/render.ts
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/index.ts (1,630 lines: cmdUp 255-line composition root; 17 proxy verbs, fetch ×14, !res.ok ×8; 5 test-only render exports)
MODE: afk

## Goal
Split by the DELETION TEST, not by "CLI vs not": (a) src/boot.ts — the composition root,
independently testable (its ordering is incident-documented, move verbatim); (b)
src/cli/client.ts — one api() helper + the proxy verbs as a declarative table (fixes the
!res.ok drift once); (c) src/cli/render.ts. The local-compute verbs (plan-validate, decompose,
curate-plane, doctor, land-assessment) are the ONLY entry points to their modules — they keep
their behavior, just organized.

## Provenance
Round-2 review, daemon agent, rank 5, Worth exploring.
