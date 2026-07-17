# Restart re-attach — honest casual-session survival across a daemon restart

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts, src/index.ts (REPL client reconnect loop), src/server.ts, tests/restart-reattach.test.ts (new)
BLOCKED_BY: 02

## Goal

Lars restarts the daemon roughly hourly. A `glance here` session must not silently die or silently hang when that happens — it must resume if the harness genuinely supports it, and otherwise say so plainly, replay the prior transcript as context into a fresh session, and mark the seam visibly. The dogfood loop does not survive its first restart without this.

## Approach

**The non-resumable reality, already coded.** The boot-restore loop (squad-manager.ts:8677 onward) already SKIPS restoring any persisted agent whose harness capability `resumable` is false (`harnessResumable(p)`, squad-manager.ts:4943, gated at the `if (!this.harnessResumable(p))` branch, squad-manager.ts:8722-8724 — "a non-resumable harness … can't be cold-restored soundly; a fresh session would replace the dead one. Skip rather than respawn under the wrong state."). The `claude-code` harness `here` rides (concern 02) is ACP-protocol, `capabilities.resumable: false` (`ACP_CAPS`, harness-registry.ts:312-318) — so every `here` session is, today, on the "skip" branch. After a restart, the old agent id simply does not exist in the roster; a client polling it gets nothing, with no explanation. That silence is the bug this concern fixes — not the skip decision itself, which is correct (respawning a live ACP session under the wrong state would be worse).

**Honesty instead of silence — the dead-agent-honesty pattern already shipped once.** commit a192134 ("dead-agent honesty + self-heal") fixed the exact same shape of lie in the voice lane: a roster-present agent in status `error` was being treated as live by the caller, so failures went unreported. The fix there was `isBoundAgentLive` treating `status: "error"` as dead and routing to a recovery path with a spoken explanation, rather than optimistically narrating a healthy send. Apply the same discipline here: when the restore loop's `!this.harnessResumable(p)` branch skips a `here`-class persisted agent, do not let it vanish without a trace — materialize a minimal terminal placeholder record (or a small parallel "recently-skipped" map keyed by id, cheap: id, repo, last persisted transcript, a `deadReason` string) that `GET /api/agents/:id` and `GET /api/agents/:id/transcript` can still answer truthfully from for a bounded window after restart, instead of a bare 404 that looks identical to "id never existed."

**Client-side reconnect loop.** The `here` REPL (concern 02, src/index.ts) already polls `GET /api/agents/:id/transcript?since=` for live updates. Extend it with the same proactive dead-connection detection shipped for voice (idle keepalive + proactive reconnect, commit d119efe): on a connection refused (daemon down / mid-restart), back off and retry the base URL itself (not the agent id) until the daemon answers again; once it does, re-check the SAME agent id. Two outcomes:
  - The id resolves live and un-changed → nothing to do, transcript polling resumes (this only fires for a future resumable harness; not `claude-code` today).
  - The id resolves to the dead-placeholder record above (or a clean 404 if the placeholder window already lapsed) → this is the honest "did not survive" case.

**Re-attach.** On the honest "did not survive" outcome: read the placeholder's persisted transcript (capped to a reasonable tail, e.g. last N entries or last M turns — full replay of an arbitrarily long casual session is unbounded context, not a fix), start a FRESH `here` session in the same repo via the exact same create path concern 02 uses, and fold the captured tail into that new session's very first prompt as explicit prior context (same spirit as the existing feed-forward pattern that folds prior reviewer comments into a workflow's first prompt — `decoratePrompt`, squad-manager.ts:4957-4962 — a proven precedent for "prepend recovered context into turn one" in this codebase, applied here to a transcript tail instead of review comments). Print/render a visible, unmissable system-style entry at the top of the new session in both the CLI REPL and the webapp transcript view: "session restarted — the previous session was not resumable (harness \"claude-code\"); continuing with your prior context." This is never silent and never presented as a seamless resume it isn't.

**Future-proofing, not overbuilding.** If a future harness registers `capabilities.resumable: true` and rides `here`, the EXISTING restore path already resumes it with zero changes from this concern — the dead-placeholder + re-attach machinery only activates on the non-resumable branch. No new capability flag needed; `harnessResumable(p)` is already the single source of truth this concern reads from.

## Cross-Repo Side Effects

none

## Verify

- Unit (`tests/restart-reattach.test.ts`): a `here`-class persisted agent with a non-resumable harness produces a dead placeholder (not silent 404) after a simulated restart; the placeholder's transcript is readable; a resumable-harness persisted agent is untouched by this change (still restores exactly as it does today).
- Fail-closed: if the placeholder itself can't be constructed (e.g. persisted transcript corrupt/unreadable), the client still gets an honest error — never a silent hang, never a fabricated "resumed" state.
- Live: start `glance here`, run one turn, restart the daemon (`glance up` again / kill+relaunch per the bounce skill), confirm the CLI REPL detects the restart, shows the honest marker, opens a fresh session with the prior turn's content visible as context, and a fresh prompt works normally from there.

## Resolution

Executed 2026-07-16 (feat/daily-driver-w1 lineage). The whole loop was driven live against a scratch
daemon (isolated state dir, port 7941) with the operator's real claude login in a tmux REPL — twice,
because the first bounce failed exactly the way only a live run can reveal (below).

**What shipped.**
- `src/reattach-context.ts` (new, pure): `buildDeadPlaceholder` (total — a corrupt persisted
  transcript degrades to an empty tail with the failure named in `deadReason`, never a throw out of a
  boot sweep), `composePriorContext` (speech-only, tail-capped at 30 entries / 8k chars, most-recent
  wins; `displayText` beats the audit copy), `reattachMarker`.
- `squad-manager`: both non-resumable skip sites (the restore-path branch at `harnessResumable` and a
  new `recordNonResumableSkips` start() epilogue over the boot snapshot) record a bounded-window
  (24h TTL, expiry checked on read) in-memory placeholder; `getTranscript` answers from it;
  `reattachDeadSession(newId, priorId)` stitches the successor — visible `system` marker appended
  (CLI dims it, webapp's TranscriptTimeline renders system entries), `adopted` lineage transition,
  prior-context tail RETURNED to the client, never auto-sent. Resumable records are untouched
  (`harnessResumable(p)` stays the single source of truth; a future resumable harness rides the
  existing restore path with zero changes here — tested).
- `server`: new `GET /api/agents/:id` — live DTO, else `{dead:true, deadReason, transcriptEntries}`
  from the placeholder, else honest 404. `POST /api/console` accepts `reattachOf` and returns
  `priorContext`.
- `here.ts` client: `sessionFate` three-way read (live / dead / missing); poll-side death detection
  (placeholder answer, or a clean miss right after a connection loss — `noteDisconnect`); a plain
  `rm` while the daemon stayed up KEEPS the pre-04 "removed on the daemon side" message (an rm is a
  choice, not a death); `rebind` resets the delta cursor (the new daemon's seq counter restarts below
  the old floor), re-queues typed lines, and folds the recovered context into the operator's OWN
  first prompt (`decoratePrompt` feed-forward precedent) with `displayText` carrying the bare typed
  text — webapp user bubbles show what was typed, the transcript keeps the audit copy. Fail-closed:
  a failed re-attach prints the error and exits clean; a failed context-bearing send re-holds the
  context for the next attempt.

**Live-found defect the tests missed: transcripts were never durable.** First bounce came back
"no prior context was recoverable" — `persistNow` writes transcripts, but NO transcript-affecting
path ever called `persist()`, so state.json always predated the conversation (it happened to date
from this concern's own adapter-pid stamp). A `kill -9` ate every turn since the last incidental
write. Fix: chain-deduped `persist()` at the two turn seams (operator-prompt append, `agent_end`) —
one write per prompt + one per completed turn, every agent kind benefits. Second bounce, full loop
proven live: MANGO-77 turn → `kill -9` → relaunch → REPL banner "⟲ the daemon restarted and this
session didn't survive it" → "re-attached (fresh session … · prior context rides your next message)"
→ marker in the new transcript → asked "what was my secret codeword?" → **"MANGO-77"** → normal
prompting from there. `/exit` released the ephemeral registration as before.

**Standing-gap investigation (orphaned ACP adapter chains): REAP, never reuse — and it shipped.**
Reuse is impossible by construction: the ACP transport is JSON-RPC over the dead daemon's own stdio
pipes — no socket, no detached host, nothing to re-dial (`session/load` wouldn't help even where
supported; the pipe itself died). A graceful stop already kills the child (`AcpAgentDriver.detach()`
kills, unlike RpcAgent's detach); the orphans come from ungraceful death, where the `npx →
claude-code-acp` chain reparents to init and idles forever — observed live (~10 such chains from
pre-04 runs sat on the host before this concern ran). Shipped as `src/acp-orphan-reaper.ts` +
persisted identity: the driver exposes `pid`/`spawnedCommand`, the manager stamps `acpPid`/`acpCmd`
onto the persisted record after every successful start, and `recordDeadPlaceholder` fires a
fire-and-forget reap that is fail-closed on the KILL side — the live /proc cmdline must still match
the persisted argv's distinctive token (recycled pids and SIBLING DAEMONS' adapters are never
touched — scratch daemons run in parallel routinely), uid must match, descendants die first,
SIGTERM then a re-verified SIGKILL escalation, every refusal logged. Verified live twice: session
adapter pid persisted → daemon `kill -9` → chain confirmed reparented to init → relaunch → chain
gone. Pre-existing orphans (no persisted pid) are deliberately NOT swept — the reaper refuses to
guess; they need one manual cull.

**Tests** (`tests/restart-reattach.test.ts`, 18): placeholder honesty incl. the corrupt-transcript
fail-closed path and the resumable/tombstoned exclusions over a real state.json boot; TTL lapse;
stitching (marker + context returned, honest no-context variant); turn-boundary durability;
sessionFate; poll death-detection ×3; rebind fold + cursor reset + failed-send context re-hold;
planReap verification (descendants-first, gone/recycled/unverifiable refusals) plus a LIVE reap of a
real process including the refusal path leaving a mismatched pid untouched, and the boot end-to-end
sweep.

**Known limits (recorded, not hidden).**
- The recovered context is a folded transcript tail, not session state — tool results, files read,
  and the model's working memory are gone; the marker says so ("continuing with your prior context",
  never "resumed").
- Placeholders are in-memory: a SECOND restart before re-attach loses the tail (the client then gets
  the honest no-context variant — 404 after `sawDisconnect` still reads as death). Durable
  placeholders weren't worth the write amplification for an hourly-restart window.
- Mid-turn kills lose the in-flight assistant stream (persist fires at turn end); the operator's
  prompt itself survives.
- A REPL that was fully offline across the entire bounce (laptop lid) re-attaches on its next poll
  tick — covered by the same sessionFate read; no push notification for it (epic C's lane).
