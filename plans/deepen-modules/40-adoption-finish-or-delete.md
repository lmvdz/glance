# Adoption — a complete vertical missing its one mount line
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: simple
TOUCHES: src/server.ts:2746 (POST /api/agents/adopt, live) + :1186 (GET /api/adoption, read by doctor-probe.ts:270), src/schema/http-body.ts:442, webapp/src/lib/adoptPromote.ts (promoteChat :128 LIVE via AgentMetaBar.tsx:5; adoptSession :135 + adoptableSessions :92 ZERO non-test callers), webapp/src/components/ui/AdoptCard.tsx:28 (exported from the barrel, rendered only by its test)
MODE: interactive

## Goal
Half-dead: the promote half is wired; the adopt half is a complete vertical (route + schema +
bridge + component + tests) with no mount point — the missing piece is literally
`adoptableSessions(entries).map(AdoptCard)` on whichever surface already fetches presence
entries. PRODUCT GATE (needs-lars if hit): finish (one mount + wiring PR) or delete the adopt
half (route stays if doctor-probe needs GET /api/adoption; the UI vertical goes). Not an
extraction — a decision that should be made rather than left, precisely because the cost of
finishing is one line and the cost of leaving it is another green-but-unreachable surface for
concern 35's scanner to count forever.

## Provenance
Round-3 review, daemon agent item 4; carried from round-2 (surfaceless adoption).
