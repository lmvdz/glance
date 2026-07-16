# Composer sanctity (Epic D)

Parent: plans/daily-driver/00-meta.md · Design: plans/daily-driver/DESIGN.md · Evidence: plans/research-t3code/BRIEF.md

## Outcome

Whatever the operator typed survives the tab crashing mid-sentence, and glance's already-different-from-t3code mid-turn send behavior (send-through-as-further-prompt-command, not queue) is verified live rather than assumed before anyone builds queue machinery on top of it. A third, small, contingent delta closes the remaining gap between the timeline's already-thinking-first rendering and t3code's "review reasoning, not diffs" habit — but only if the friction ledger says it's worth it. This epic rides alongside on-ramp (A), dogfood engine (B), and attention wave-0 (C); none of its three concerns block or are blocked by them.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 draft-persistence | Composer input/history/attachments are ephemeral `useState` — killing the tab loses the in-progress draft; t3code lost user drafts six times before landing on a versioned, migratable store | mechanical | webapp/src/components/chat/Composer.tsx, webapp/src/lib/chat/draftStore.ts (new) |
| 02 midturn-send-semantics | landscape shows sends during a turn just ride through as further prompt commands, no queue, no block — this may already be BETTER than t3code's queue-and-relabel, but nobody has driven it live to see whether it steers, interleaves, or corrupts | research | src/squad-manager.ts (read-only trace), webapp/src/lib/intervene.ts (read-only — commentSteer must never regress) |
| 03 reasoning-first-delta | TranscriptTimeline already renders thinking entries first-class, auto-open while streaming, folded when done — the remaining delta is small and CONTINGENT on friction-ledger evidence that review pain is real | mechanical | webapp/src/components/chat/TranscriptTimeline.tsx |
| 04 midturn-honesty-repairs | filed FROM 02's live verdict (keep send-through, no queue): repair the two observed daemon-side lies — mid-generation sends orphan the running transcript entry as permanently-"running", and the shared `rec.streaming` boolean derives idle while queued turns still stream | mechanical | src/squad-manager.ts (agent_start/agent_end cases, streaming accounting), webapp/src/components/chat/Composer.tsx (optional hint only) |

## Order / batches

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02 | disjoint files (webapp composer state vs. daemon prompt-dispatch trace), no cross-deps — either order, either can run alone |
| — | 03 | not batched now — gated open pending friction-ledger evidence (see BLOCKED_BY in 03) |

## Dependency graph

- 01 draft-persistence: none.
- 02 midturn-send-semantics: none (informs whether a future queue gets built; does not block or depend on 01). DONE 2026-07-16 — verdict: keep send-through (see the concern's Resolution); spawned 04 here and plans/daily-onramp/07 (p0 ACP turn-timeout ship-blocker).
- 03 reasoning-first-delta: gated on friction-ledger evidence of review pain (plans/daily-dogfood-engine's friction ledger), not a file-level BLOCKED_BY — record the gate note in the concern itself.
- 04 midturn-honesty-repairs: evidence-complete via 02's Resolution; p2 — sequence behind wave-1 concerns. Independent of 01/03; touches squad-manager.ts, so ordinary cross-epic rebase discipline (00-meta "Shared-file discipline") applies.

## Not yet specified

(none — 03's exact evidence threshold is deliberately left to whoever reviews the friction ledger at expansion time, per arbitration §13)

## Notes

- Queue-not-block composer machinery is explicitly cut from this epic (plans/daily-driver/00-meta.md "Out of scope") until 02's live verdict says otherwise — 02 is a research concern, not a build concern.
- Annotation-to-prompt-segments and any other composer gold-plating are pre-adoption scope creep — not in this epic (arbitration §12).
- 01's schema-versioning discipline (v1 + migration seam) is the t3code lesson (BRIEF.md:120 — v8 in production, six lost-draft incidents before it landed); webapp/src/lib/chat/sessionStore.ts is the in-repo structural precedent (pure-function core + three browser-only load/persist/subscribe functions) but carries no version field itself — 01 is the first versioned localStorage store in this webapp.
- 02's live drive must not perturb IntervenceView's diff-line-comment steer path (webapp/src/lib/intervene.ts `diffLineSteerMessage` → `steerCommand` → `sendConsoleCommand`, wired at webapp/src/components/IntervenceView.tsx:171/178) — if a queue is ever built from 02's findings, that path is never queued behind chat messages (arbitration §12, RT1 F1).
