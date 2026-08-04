# Voice lane — pull its HTTP/WS surface out of server.ts
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/server.ts (~180 voice references, incl. the 138-line token-mint handler at 2225–2363), src/voice-call-manager.ts and the 10-file voice cluster
MODE: afk

## Goal
The voice cluster below the surface is well-shaped (BrokerClient port, binding store,
journal/projection) but its interface smears through server.ts, bypassing the coordinator. Deepen:
a voice routes module (natural first client of 05's route table) + the token-mint/rate-limit/
audit-reservation orchestration moved behind the voice lane's own interface.

## Provenance
Whole-repo report candidate 6 (Worth exploring). Sequencing: after or with 05.
