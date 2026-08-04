# Voice lane — pull its HTTP/WS surface out of server.ts
STATUS: done
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

## Close-out (2026-08-04, iteration 23 — delivered as 05 slice 4)
src/routes/voice.ts: the mint lane (config + the 138-line token-mint/rate-limit/audit-reservation
orchestration, dispatched pre-!manager-gate with voiceScope/role/actor/manager?/rate-thunk made
explicit) and the call lane (14 manager-tier /api/voice-calls + channel voice-call routes as
RegExp table entries, captures decoded by the table). voiceCallErrorResponse and
resolveVoiceMaxConcurrentPerOrg (+ warn-once state) moved with their lane. ~310 lines out of
server.ts. Deliberately NOT moved: the voice audio WS upgrade path (separate upgrade surface,
not HTTP route dispatch) and CSP/origin env wiring (server-shell concerns, not lane logic).
Blind passes: codex CLEAN (live in-memory-DB probes of reserve→compensate→finalize + %2F
decode probes on all 14 routes), grok CLEAN (byte-diff of every handler vs HEAD, placement
markers, decode probes). Suite 4947/1 (pre-existing dead-exports only), webapp 2024/0.
