# Mid-turn send semantics — live verdict on send-while-running

STATUS: done
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

## Resolution

2026-07-16 — driven live, all four scenarios plus four controls, against a real claude-code agent. Rig: isolated scratch daemon booted from this branch's code (scratch-daemon skill: own state dir, repointed HOME seeded with only the claude OAuth credentials, loops off, port 7997), chat units created exactly as `glance here` does (`POST /api/console {harness:"claude-code", ephemeral:true}` — `approvalMode:"yolo"` via the create command for the tool-call scenarios so nothing stalls on a permission gate), prompts sent over the same WebSocket `{type:"prompt"}` command the webapp composer and IntervenceView steer both use, observed via 300ms transcript/roster delta-polls plus the transitions ledger. Adapter: `@zed-industries/claude-code-acp` 0.16.2 via npx, SDK-default model (unpinned). Driver script + raw per-scenario transcripts committed under `plans/daily-composer/evidence-02-midturn/`.

### Verdict: KEEP SEND-THROUGH — do not build queue machinery. File the three repairs below instead.

The adapter already gives us t3code's queue semantics for free, plus one behavior strictly better than t3code's: **no mid-turn send was ever lost, in any scenario.** What's broken is not the semantics — it's three daemon-side honesty/robustness defects the drive exposed, one of them a ship-blocker that has nothing to do with mid-turn sends.

### What actually happens (corrected mechanical model, observed not inferred)

1. **A mid-turn send never interrupts, restarts, or corrupts the in-flight turn.** S1: story turn A ran byte-continuous to completion (3,886 chars) with B sent ~1s into generation; the "restart" a naive transcript read suggests is a daemon-side rendering artifact (below), proven by the successor entry beginning with the orphaned entry's exact 123-char prefix and continuing seamlessly — no duplication, no regeneration.
2. **The second message is queued at the adapter/SDK layer and processed as its own full turn after the current one.** S1's B was answered 3s after A finished: "It looks like you're asking me to abandon the story, but I've already completed it in my previous response." — i.e. the model saw B only after A was done. Option (a) fold-in happened in exactly one window (next point); options (b) interrupt and (d) corruption never occurred.
3. **Exception — tool-call windows fold in.** S2: B sent mid-`sleep 40`; the tool ran its full 40s untouched and ONE reply answered both: `"The output was:\n\n\`\`\`\nSLEEP_DONE\n\`\`\`\n\nMANGO"`. During a tool call there is no in-flight generation, so the SDK folds the new message into the same turn. This is genuinely better than a queue — the closest thing to working mid-turn steering observed.
4. **Rapid-fire degrades gracefully at the semantic level.** S3 (A + 3 sends inside 1.4s): four serialized full turns; APPLE, BANANA and CHERRY each delivered in their own turn's reply. Nothing lost, nothing interleaved. What broke instead was the driver timeout (defect 1).
5. **Steer is not a primitive — it is literally the same command.** `steerCommand` (webapp/src/lib/agent-control.ts:127) emits the identical `{type:"prompt"}` a composer send emits. S4 (chat send and diff-line steer in the same tick, chat first = worst case): both user entries landed FIFO, both were answered as their own turns, the steer acknowledged (`STEER-RECEIVED` + Read tool calls on the named file). Not dropped, not reordered — and also demonstrably **not immediate**: a "steer" today cannot redirect an in-flight ACP turn at all; it is a queued follow-up that lands after the current turn (and after any chat message sent before it).

### Defects observed (all daemon-side; none change the verdict, all get filed)

1. **SHIP-BLOCKER, independent of mid-turn sends: `AcpAgentDriver.send()`'s default 60s timeout applies to `session/prompt`, whose JSON-RPC response only arrives at TURN END** (src/acp-agent-driver.ts:467, :495). Control s0long: a single healthy 75s tool turn — no second send anywhere — errored the agent at exactly +60s ("acp request session/prompt timed out") while the turn completed underneath and its reply streamed into a permanently-"running" entry on an agent already marked error. Queued sends amplify it (each queued prompt's 60s clock starts at send, burning while it waits — s3's error), but any `glance here` turn >60s dies alone. Filed as plans/daily-onramp/07-acp-prompt-turn-timeout.md (p0).
2. **Mid-generation sends orphan the running transcript entry.** The driver emits `agent_start` at prompt-SEND time (acp-agent-driver.ts:491-492); the manager's `agent_start` case resets `rec.assistantEntry` without finalizing it and does not clear `assistantBuf` (squad-manager.ts:6277-6283). Result, every mid-generation send: the partial entry freezes as status:"running" forever, and its text re-appears as the prefix of the successor entry. S1 seq15/seq17, s4 seq42/seq45, s3 seq35/seq36 (a reply split across a finalized-early fragment and a stuck-running remainder). Filed in plans/daily-composer/04-midturn-honesty-repairs.md.
3. **Status lies while turns are queued.** `rec.streaming` is one shared boolean: the first turn's `agent_end` clears it (squad-manager.ts:6360) and the DTO derives to idle while queued turns are still pending — s1's B-turn and s4's B- and C-turns streamed their entire replies under status "idle" (transitions ledger: `working→idle turn-progress` mid-queue; no return to working). The composer re-enables on the send round-trip (`isLoading` cleared in `finally`, AssistantChat.tsx:756) — that part is fine under send-through — but the operator has no signal that messages are waiting or that the agent is still working through them. Filed in the same 04 concern (outstanding-turn counter; optional t3code-style queued-count hint, now evidence-backed as UI-only work).

Pre-existing blemishes attributed by controls, not this concern's scope: tool entries permanently status:"running" even on clean single turns (control s0tool); an API-level content-filter 400 permanently errors a chat unit with no recovery path (found when the first long-generation probe — a 150-item number list — tripped Anthropic's output filter ON ITS OWN, control s0num; probe swapped to prose and the contaminated run discarded).

### Scenario evidence (verbatim excerpts; full transcripts in evidence-02-midturn/)

- **S1 send-during-generation** — A `+7.5s`, B `+11.5s`; A completes seamlessly `+38.1s`; B answered as own turn `+41.4s`: "It looks like you're asking me to abandon the story, but I've already completed it in my previous response." Orphaned entry seq15 (123 chars, status running forever); successor seq17 startsWith(seq15) === true, contains-twice === false.
- **S2 send-during-tool-call** — `sleep 40` starts `+12.2s`, B `+21.9s`, tool uninterrupted, single fold-in reply `+55s`: SLEEP_DONE + MANGO in one message.
- **S3 rapid-fire ×3** — sends `+10.3/+11.0/+11.7s`; four full serialized turns (3907/4253/4418/3157+1405-split chars); fruits delivered per-turn (33→APPLE, 34→BANANA, 35+36→CHERRY); `acp request session/prompt timed out` → status error at `+71.9s` while turn D still streamed.
- **S4 steer-vs-send same tick** — user entries FIFO (seq43 chat, seq44 steer); DRAGONFRUIT turn then STEER-RECEIVED turn (+ Read tool calls). WS frame order preserved end-to-end.
- **Controls** — s0 prose alone: clean 32s turn, idle finish. s0num: number-list probe trips the API content filter alone. s0tool: tool entries stuck "running" with no mid-turn send. s0long: single 75s turn errors at 60s.

### The steer constraint, confirmed under this verdict

Verdict is keep-send-through, so the arbitration constraint ("commentSteer's immediate-steer path must never end up queued behind chat messages if a queue is ever built") holds vacuously — no queue exists at the daemon layer and none is being built. Two facts recorded for whoever ever revisits: (1) today the ADAPTER already serializes a steer behind any chat message sent before it, FIFO — the constraint as worded is not satisfiable at the harness layer without interrupt semantics (`session/cancel` + re-prompt), because an ACP "steer" cannot redirect an in-flight turn at all; (2) the constraint is restated as an explicit acceptance criterion in plans/daily-composer/04-midturn-honesty-repairs.md, which is where any future queue-shaped work would grow from.
