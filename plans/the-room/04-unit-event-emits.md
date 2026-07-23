# Unit event emits — typed proof events in the unit transcript (supersedes buzz-borrows 01)
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts (TranscriptEntry), src/transcript-event-kinds.ts (new), src/squad-manager.ts (land/gate call sites), src/validator.ts or its call site (structured verdict emit), webapp/src/lib/dto.ts (mirror), tests
MODE: afk

## Goal
The trust layer's facts become typed, kind-tagged transcript events at their source: land-attempt
lifecycle, validator verdict (ValidationRecord — the "gate" this program's cards render, per A-S6),
and the merge decision appear as first-class entries in the unit's transcript. This is the emit
substrate concerns 05/12/13/16 project from.

## Approach
1. Type: optional `event?: { kind: string; payload: unknown }` on TranscriptEntry
   (src/types.ts:186-207), same idiom as pending/tool. HAZARD (document loudly at both
   definitions): TranscriptEntry.kind is a closed 5-value axis; event.kind is an open string.
2. Kind constants module `src/transcript-event-kinds.ts`. Landing-order rule (binding): NO KIND
   LANDS BEFORE ITS READER — this concern ships kinds only together with their consumers in
   concerns 05/12/13/16; kinds not yet consumed are names reserved in a comment, not shapes.
3. Emit sites: land-attempt lifecycle at the land-assessment hook call sites (beginAttempt
   src/squad-manager.ts:3604, recordLanded :3618, recordRejection :3631, landInner terminal :3641)
   and the merge finalization blocks (:3548-3566, :3950-3970 — DoneProof/issue/branch in scope).
   Validator: structured emit of ValidationRecord summary (src/types.ts:448-467) where landBranch
   reads it pre-merge — this is NEW daemon work, the current gate line at :6873 is free text.
4. Entries born settled, append-only, one entry per stage — never coalesce (delta-poll cursor only
   re-fetches running entries; settle falsifies running on process death).
5. Resolve records by id at emit time; drop silently if the unit/manager is gone (background
   assessment can outlive both — hook stays observe-only, src/land-assessment/hook.ts:2-17).
6. Untrusted strings (names, branches) through neutralizeDelimiters + redact for the .text line;
   payload carries structured data. Summary line capped ~200 chars.

## Cross-Repo Side Effects
None (dto mirror only).

## Verify
- Scratch-daemon land: attempt/assessment/verdict/merge entries appear with event.kind set, settled
  status, exactly-once via ?since= delta poll.
- Kill agent mid-land (PR #216 scenario): land-side entries still appear, none falsified.
- Fence-garbage unit name renders neutralized. bun test green.

## Resolution
Landed 2026-07-23 (PR #225): TranscriptEntry.event substrate + land-lifecycle + ValidationRecord verdict emits. Supersedes buzz-borrows 01.

Amended 2026-07-23 (federation provenance, DESIGN.md amendment): the envelope gained
`issuer`, stamped as `EVENT_ISSUER_MANAGER` at emitUnitTranscriptEvent /
ChannelStore.appendManager, never from input. Pre-amendment persisted entries lack it and
read as "manager". The authorship invariant is now "issuer verified at the chokepoint",
of which "manager-authored only" is the current single-writer special case.
