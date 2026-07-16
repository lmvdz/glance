# Restart re-attach — honest casual-session survival across a daemon restart

STATUS: open
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

(filled in when this concern executes)
