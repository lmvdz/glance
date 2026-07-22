# Unit-as-room: land/gate/merge verdicts appear in the unit transcript
STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/land-assessment/hook.ts (call sites only), src/gate-logs.ts (read side), webapp/src/lib/dto.ts (type mirror only), src/transcript-delta.test.ts or sibling tests
MODE: afk

## Goal
The unit's transcript becomes the single spine of what happened to the unit: land-attempt lifecycle (started / assessment / rejected / landed), gate verdicts, and the merge decision appear as first-class transcript entries. Comprehension = reading one room. Render side (typed cards) is explicitly NOT here — it belongs to the t3-face lane; until then the plain-text summary line renders via the existing text fallback.

## Approach
1. Type addition (the dissolved "envelope" remnant): `TranscriptEntry` (src/types.ts:186) gains an optional field `event?: { kind: string; payload: unknown }` — same idiom as the existing optional `pending`/`tool` fields. Mirror in webapp/src/lib/dto.ts:635 area. Kind constants live in a small module (e.g. `src/transcript-event-kinds.ts`): `unit.land.attempt`, `unit.land.assessment`, `unit.land.rejected`, `unit.land.landed`, `unit.gate.verdict`, `unit.merge.decision`. Rule from day one: a new kind needs a payload shape and at least one reader. NOTE the naming hazard flagged in design review: `TranscriptEntry.kind` (closed 5-value TranscriptKind) is a different axis from `event.kind` (open string) — document loudly at both definitions.
2. Emit sites — at the call sites where the land-assessment hook already fires (beginAttempt at src/squad-manager.ts:3604, recordLanded :3618, recordRejection :3631) and at landInner's terminal outcome (:3641), append a transcript entry: `append(rec, "system", <one-line summary>, { event: { kind, payload } })`. Gate-verdict emit sites: locate where GateReport/proof results are recorded (src/gate-logs.ts writeGateLog callers, proofFor/refreshProofState) — a small explore at implementation time; wire the same append there.
3. **Append-only, one entry per stage.** Never coalesce in place: the delta-poll cursor contract (src/transcript-delta.ts:8-15) only re-fetches entries still `status:"running"`, and settle-on-exit (settleRunningTranscript, src/squad-manager.ts:8330) falsifies any `running` entry when the agent process dies even though a land is a manager-side operation. Every emitted entry is born settled. A land attempt is 2-4 entries; that volume is fine.
4. **Resolve the record by id at emit time; drop silently if gone.** Land assessment runs in background (`void this.assess`, src/land-assessment/hook.ts:66) and can complete after the unit is removed or the manager evicted (DB mode, src/manager-registry.ts:143-156). Never hold an AgentRecord ref across that gap; never hand the hook a manager reference — its observe-only invariant (hook.ts:2-8) is load-bearing. Nothing on this path may throw into a land.
5. Untrusted strings: branch names, unit names, and any agent-influenced detail in the summary line go through `neutralizeDelimiters` + `redact` (src/digest.ts). Payloads carry raw structured data (they're data, not prompt text) but the `.text` line is prompt-adjacent (it can be re-read by the unit itself) — treat it as such.
6. Size discipline: plain length budget on detail strings (cap summary line ~200 chars; full data stays in `.event.payload` and the existing side stores). Do NOT route through the noisegate (src/output-reduce.ts) — it's a line-ranking reducer for oversized tool output, wrong category for small structured payloads.

## Cross-Repo Side Effects
None. webapp change is the dto type mirror only — any PR under this concern touching webapp components/rendering is out of scope and should be rejected (sequencing directive).

## Verify
- Unit landing in a scratch daemon (scratch-daemon skill recipe) produces attempt/assessment/terminal entries in `GET` transcript output, each with `.event.kind` set and settled status.
- Delta pollers (`?since=` path) see every entry exactly once; no phantom "Working" rows in the cockpit (no entry born `running`).
- Kill the agent process mid-land (PR #216 scenario): land-side entries still appear, none falsified to error by settle.
- A unit named with fence-delimiter garbage renders neutralized in the summary line.
- Existing transcript tests + `bun test` green (node_modules/.bin on PATH per test-path gotcha).

## Resolution
Superseded-into plans/the-room 2026-07-22 (see the-room 00-overview + DESIGN.md; this concern's reviewed content was carried/reshaped there).
