# Mid-turn send semantics — live verdict on send-while-running

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: src/squad-manager.ts (`applyCommand` `"prompt"` case :5430-5483, `promptConnected` :5340 — read/trace only), webapp/src/components/chat/Composer.tsx (textarea disabled state — read only), webapp/src/lib/intervene.ts (`diffLineSteerMessage` :60 — must not regress), webapp/src/components/IntervenceView.tsx (steer wiring :171/178 — must not regress)

## Goal

t3code blocks nothing mid-turn either, but routes it through an explicit queue with an honest "Queue" relabel and a queued-count banner (plans/research-t3code/BRIEF.md:120, :122 — "no mid-turn steer primitive exists — steer = stop or queue"). glance does something different today: the composer textarea is disabled only during the send round-trip, not for the duration of the agent's turn (`isLoading` cleared in `finally`, not on turn completion — landscape verified), and `SquadManager.applyCommand`'s `"prompt"` case (`squad-manager.ts:5430`) has no guard against `rec.streaming` already being true — a second prompt while the first is mid-flight goes straight to `promptConnected` (`:5481`) exactly like the first one did. Nobody has driven this live to see what actually happens when a human sends a second message before the agent finishes the first. Produce a written verdict — keep send-through, build a queue, or hybrid — grounded in an observed live run, not in reading the code.

## Approach

- Drive it with the scratch-daemon skill (isolated daemon, real agent, no shared-fleet risk) — this must be observed against a real harness turn, not simulated, since the open question is about actual interleaving behavior at the driver/harness layer, which mocks would paper over.
- Scenario 1 — send during active generation: start a long-running turn (a prompt that takes the agent 20-30s+ to answer), send a second message 3-5s in. Observe: does the second message (a) get silently appended as more context the SAME turn folds in, (b) interrupt/restart the turn, (c) get processed as an entirely separate concurrent turn (racing outputs), or (d) visibly corrupt the transcript (interleaved/garbled text, duplicate entries, lost content)? Capture the transcript verbatim as evidence.
- Scenario 2 — send during a tool call: same as above but timed to land while the agent is mid-tool-call (harness-dependent; use whichever harness in this environment makes a tool call take visibly long, e.g. a slow shell command) — tool-call boundaries are a plausible place for different behavior than plain text generation.
- Scenario 3 — rapid-fire multiple sends: 3+ messages sent back-to-back before the first turn settles — does behavior degrade further, or does it stay consistent with scenarios 1-2?
- Scenario 4 — steer-vs-send race: fire `IntervenceView`'s diff-line-comment steer (`diffLineSteerMessage` → `steerCommand` → `sendConsoleCommand`, `IntervenceView.tsx:171/178`) at the same moment as a plain composer send to the same agent — confirm the steer path is not silently dropped, delayed, or reordered behind the chat message. This is the one hard constraint from arbitration: whatever the verdict, `commentSteer`'s immediate-steer path must never end up queued behind chat messages if a queue is ever built from this concern's findings.
- Write the verdict as a short decision doc (append to this concern file under a new "## Verdict" heading once driven): keep send-through (if it demonstrably just works / degrades gracefully), build a queue (if scenario 1-3 show real corruption or lost input), or hybrid (e.g. send-through during plain generation, queue only around tool calls) — with the observed transcript evidence for each scenario cited.
- If the verdict recommends a queue, do NOT build it in this concern — file it as a new concern in this epic or the next one, scoped separately, respecting the steer-never-queued constraint above.

## Cross-Repo Side Effects

None — this concern produces a written verdict, not a shipped change. If the verdict triggers follow-on work, that work is scoped and filed separately (see Approach's last bullet).

## Verify

- Deliverable is the verdict itself, not a passing test suite: a written keep/queue/hybrid decision with real transcript evidence from all four scenarios, stored in this file.
- Scenario 4's steer-never-blocked property is the one thing this concern must not merely observe but explicitly confirm holds under the verdict reached — if the verdict is "keep send-through," restate why that alone already satisfies the constraint (no queue exists to misorder into); if the verdict recommends a queue, the constraint must appear as an explicit acceptance criterion on whatever concern builds it.
