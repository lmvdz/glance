# Mid-turn honesty repairs — orphaned entries + queued-turn status truth

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts (`agent_start` case :6277-6283, `agent_end` case :6357-6382, `rec.streaming` accounting), webapp/src/components/chat/Composer.tsx (optional queued-count hint only), tests/squad-manager tests

## Goal

Concern 02's live verdict was KEEP SEND-THROUGH — the claude-code adapter already serializes mid-turn sends losslessly, and tool-call windows even fold the new message into the same turn. This concern repairs the two daemon-side honesty defects that drive observed (02's Resolution, defects 2 and 3), without building any queue:

1. **Orphaned transcript entries.** `AcpAgentDriver.prompt()` emits `agent_start` at prompt-SEND time; the manager's `agent_start` case resets `rec.assistantEntry = undefined` without finalizing the running entry and does not clear `assistantBuf`. Every mid-generation send therefore freezes the in-flight assistant entry as status:"running" forever and re-carries its text as the prefix of the successor entry (02's s1: seq15 frozen at 123 chars, seq17 = same 123 chars + seamless continuation; s3's seq35/36: one reply split across a finalized-early fragment and a stuck-running remainder).
2. **Status lies while turns are queued.** `rec.streaming` is one shared boolean; the FIRST turn's `agent_end` clears it and the DTO derives to idle while queued turns are still outstanding — 02's s1/s4 queued turns streamed their entire replies under status "idle". The operator sees an idle agent that is actually mid-queue; push/attention logic keyed on idle sees the same lie.

## Approach

- Track outstanding turns as a counter (or a set of unresolved `prompt()` promises), not a boolean: `agent_start` increments, `agent_end` decrements; the DTO stays "working" while >0. The transitions ledger then shows working continuously across a queued burst, which is the truth.
- On `agent_start` while an assistant entry is running: finalize it honestly (flush as-is) or, better, keep appending to it until its own turn's `message_end` — decided at implementation against the driver's actual frame interleaving (02's evidence shows continuation chunks arrive after the new prompt's agent_start on the same wire).
- Optional, UI-only, after the daemon truth is fixed: a small "N messages waiting" hint in the composer (t3code's honest-relabel borrow, BRIEF.md:120/:122) — now evidence-backed as pure presentation, since the daemon-side behavior is already a lossless queue.
- Do NOT build a send-queue, hold buffer, or relabel-into-Queue machinery in the send path itself — 02's verdict explicitly rejects that; the adapter already provides the semantics.

## Constraint carried from arbitration (02's Verify, restated as acceptance criterion)

If this concern (or any successor) ever introduces daemon-side queuing of prompts: `commentSteer`'s path (`diffLineSteerMessage` → `steerCommand` → `sendConsoleCommand`, IntervenceView.tsx:171/178) must never be ordered behind chat messages — steer goes to the front or bypasses entirely. Note from 02's live drive: steer and chat are today the same `{type:"prompt"}` command processed FIFO by the adapter, and a true immediate-steer would need interrupt semantics (`session/cancel` + re-prompt); building that is out of scope here.

## Verify

- Unit: transcript invariant — after any sequence of prompts, no assistant entry remains status:"running" once its turn ended; no entry's text is a strict prefix duplicate of a later entry from the same turn.
- Unit: status invariant — DTO reads "working" from first `agent_start` until the LAST outstanding turn's `agent_end` (counter, not boolean).
- Live: re-run 02's s1 and s4 scenarios from `plans/daily-composer/evidence-02-midturn/drive.ts` against a scratch daemon; assert no stuck-running assistant entries and no idle window while queued turns stream.
