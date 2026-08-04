# deepen-modules — turn the flat 235-file daemon into deep modules, one seam at a time

The repeatable loop Lars asked for (2026-08-03: "we can do this over and over again to clean up
the repo into modules which reduce fatigue and increase codebase understanding"). Each concern is
one architecture-review candidate: a shallow cluster deepened behind a small interface, shipped as
its own reviewable PR with gates at baseline and a blind cross-lineage pass.

Process: `.claude/skills/deepen` (vendored from mattpocock's improve-codebase-architecture +
codebase-design skills, adapted to house practice). Vocabulary: module / interface / seam / depth /
locality / leverage — see the skill. Domain glossary: `CONTEXT.md` (repo root).

Provenance: two reviews on 2026-08-03 — the memory-lane report (two Explore agents; candidates
01–07 here) and an independent fresh-context whole-repo report (candidates 08–13). Re-run the
review phase when this queue runs dry; the codebase will have new hot spots by then.

## Ground rules (learned in iterations 1–3)

- One candidate per PR; mechanical moves and behaviour-bearing extractions in SEPARATE commits.
- Imports carry explicit `.ts` extensions — grep for `name.ts`, not `name` (false zeroes).
- `src/server.ts` (and others) contain NUL bytes: rewrite imports with a Node/Bun script, never sed.
- Boundary enforcement = set-diff allowlist tests (tests/memory-lane-boundary.test.ts is the
  template), never count ratchets — a count lets a removed coupling mask an added one.
- Gate truth: full root suite diffed against the known ratchet baseline; webapp suite; tsc both
  projects. One green targeted run proves nothing (main flakes; see targeted-tests memory).
- Blind grok + codex pass on every diff before it ships; adjudicate findings against the code.

## Iteration 36 (2026-08-04, goal mode) — CONCERNS 17 DONE + 09 needs-lars — QUEUE RESOLVED
17: the never-rendered attention pipeline is DELETED (~570 lines + tests) — with the round's
real teaching: codex proved my "superseded" claim was overclaimed (reports/attentionEvents
render nowhere — a safety-signal gap now NAMED and queued for the review round, not hidden
behind dead code), and grok's dying narration caught the stranded import that NO gate could
see, exposing that webapp tsconfig EXCLUDES tests from typechecking entirely (native
blind-spot row — a review-round candidate). 09 → needs-lars (the #317 merge). Every concern
now shows done or needs-lars: the QUEUE IS DRY. Next: the fresh architecture-review round —
the goal's completion clause — with three pre-named candidates (reports/attentionEvents
surface, webapp test-tsconfig gate, Store-interface split).

## Iteration 33 (2026-08-04, goal mode)
10 slice 1: RoomSessionCursor — the PR #216 stale-claims wiring is finally table-testable, with
three hardenings (one self-caught: channel-tagged resync). Codex round was humbling and exact:
a CRITICAL TDZ my own misread check-run waved through, the effect-ordering HIGH, and a UX
flicker MEDIUM — all fixed + tested. The layered-verification pattern held: native catch, then
reviewer catches, each finding a different failure class. grok flaked (8/9 today).

## Iteration 34 (2026-08-04, goal mode)
10 slice 2: RoomSession over the transport port — the interleavings themselves are now
scripted tests. SECOND convergent cross-lineage round (grok's TOCTOU HIGH and codex's
render-phase-ref-write M arrived at the same parameterized-markRead fix from different
directions; presence parity found by both). The port pattern is proven: ports-and-adapters
made a React wiring hazard class table-testable.

## Iteration 35 (2026-08-04, goal mode) — CONCERN 10 DONE
Slice 3 (mention-turn ledger) closes the concern: HubShell is a view; the session module owns
cursor + transport + optimistic bookkeeping with 15 tests. Both lineages CLEAN with itemized
parity checks, both independently naming the same pre-existing cross-channel card quirk —
convergence even on the non-findings now. THIRTEEN concerns done.

## Iteration 31 (2026-08-04, goal mode)
08 slice 1: the event-kind wire contract becomes one module — type-only cross-tree import, drift
is now a compile error, excess keys newly impossible. Codex 1M+1L survived (the rewrite dropped
the constants-in-list proof; stale header); its verification walked the exact compile-error
cascade a new kind triggers. The cwd accident REPEATED (bg suite ran in webapp/ after the build's
cd) — caught by test-count sanity; native row recorded, rule reinforced. grok flaked (7/8 today).

## Iteration 32 (2026-08-04, goal mode) — CONCERN 08 → needs-lars
The dto-mirror slices hit their real dependency: they are designed on concern 06's core-types
kernel, which lives on unmerged PR #315 — not on main. Compatibility verified (dto's head
mirrors are re-exportable the moment the kernel merges; the WorkLane dependency flip is
designed), then the concern flipped to needs-lars naming the merge as the open question —
concern 14's blocked-on-train precedent, not a stacked-PR gamble. Slice 1 (PR #317) stands
alone. Next: concern 10 (HubShell room-session — webapp-only, independent of the type train).

## Iteration 27 (2026-08-04, goal mode)
12 slice 1: capability lane escapes the state blob (split store methods, both modes). Codex's
blind round was the queue's deepest — 4 High data-loss windows (unawaited single-path migration,
blob-before-split write order, capabilities-only store invisible to hasState, barrier past a
swallowed failure) + the ILLUSORY-FIX Medium: the lane's changed dep still triggered a full blob
persist, so the amplification the slice claimed to remove was still fully present. All fixed +
regression-tested; ratchets caught my own two new hits (cast + error idiom) and both were paid
back. grok quota-flaked (gap row). The slice is the strongest argument yet for the blind pass:
green suites + a plausible diff hid four real crash-windows.

## Iteration 28 (2026-08-04, goal mode)
12 slice 2: features escape the blob — feature churn no longer rewrites every transcript. The
verification stack worked in layers: I caught the two-writer race myself pre-review (native
ledger row); the suite caught the format-contract test + my own new cast; codex caught what
both missed (cross-lane membership sites relying on the removed free full-save, and the
tombstone-after-swallowed-failure eraser). Five codex rows + one native row recorded. grok
quota-flaked again (6th) — its absence is now a measured reliability fact on the ledger, not
an anecdote.

## Iteration 30 (2026-08-04, goal mode) — CONCERN 12 DONE
Agents-core disposition (docs-only): after three slices, state.json on disk IS the agents lane;
every other lane persists through its own file/rows, and the deletion test passes lane-by-lane.
The dirty-tracking upgrade and the Store-interface split are recorded follow-ups with their
prerequisites named. TWELVE concerns done; open: 08/09/10 (+17 on the 14-branch), 13 needs-lars.

## Iteration 29 (2026-08-04, goal mode)
12 slice 3: transcripts escape the blob (modes converge on one layout; state.json is now the
agents core + tombstones). The queue's first CONVERGENT cross-lineage round: grok's first
successful pass in seven attempts landed 2H+3M+1L with a reproduced failing test, and two of
its findings were independently found by codex — exactly the correlated-evidence signal the
two-lineage bet was made for. Grok's unique catch (omit-then-tombstone) even applied
retroactively to slice 2's features lane. Nine rows recorded.

## Iteration 26 (2026-08-04, goal mode) — CONCERN 06 DONE
Final slice: src/core-types.ts, the 14-type shared kernel (identity, lifecycle, transcript
grammar, work-item ref) with one lane import and everything depending on it — the deletion
test a kernel should pass. codex CLEAN at its most thorough (byte-identical blocks, 160
type-only bindings, cycle erased under isolatedModules); grok quota-flaked (gap row). types.ts
1,723 → 1,454 across the concern. ELEVEN concerns done; 08/09/10/12/17 + 13 needs-lars remain.

## Iteration 25 (2026-08-04, goal mode)
06 slice 3: the AgentDTO split (the hard one) — six domain facets, DTO = their intersection,
wire-identical, 72 fields in/out verified twice (my script + codex's independent AST audit).
The slice's own freeze test was the iteration's lesson: v1 compared the DTO against its own
facets (circular — codex proved deleting etaAt stayed green); v2 is an independent 72-entry
frozen field+optionality map. Land-types item closed as a recorded no-move disposition.
Remaining in 06: the minimal core extraction.

## Iteration 18 (2026-08-04, goal mode — new PR; per-branch overview notes on their PRs)
06 slice 1: feedback types leave the shared kernel for their lane, compat re-exports keep the
world compiling. Suite 4947/1. The migration pattern (move + type-only re-export + lane-local
import) is now proven for the remaining domains.

## Iteration 19 (2026-08-04, goal mode — PR #315)
06 slice 2: FeatureDecision home = the decision ledger (barrel-routed after codex caught the
deep import my own allowlist would have fired on — reviewer and boundary test agreeing is the
system working); receipt shapes home = receipts.ts. Suite 4947/2 (dead-exports pre-existing +
one isolated-pass ordering flake). Discovery: room/channel types migrated organically long ago —
the codebase was already partly ahead of the concern.

## Iteration 17 (2026-08-04, goal mode — PR #314) — CONCERN 07 DONE
Gather port shipped: ok-typed sources end failure-as-drift for good; fingerprint v2 makes
rendered omissions drift-visible; codex 4 more survived (incl. the silent-empty recreated one
level down — the reviewer catching the same shape at every depth is the whole point). Suite
4948/1. Concern 07 is the first architectural concern taken concept→design→two-round
implementation→done entirely inside the goal loop.

## Iteration 16 (2026-08-04, goal mode — PR #314)
07 implementation core: regeneration replaces write-once. Two hardening rounds (codex 5 P1s,
grok 2 + 1 REFUTED — first non-survived grok row: asOfBuild staleness is the design). Suite
4947/1. Remaining: the manager-side gather port, then 07 flips done.

## Iteration 15 (2026-08-04, goal mode — PR #314; iterations 9–14 logged on their PR branches)
07 design round, two-round red-teamed: eight survived findings folded into DESIGN v2 (lying
quarantine pair, snapshot coherence, failure-as-drift, live-state evidence claim, barrel break,
.prev clobber, legacy migration). needs-design → in-progress; implementation slice scoped.

## Iteration 24 (2026-08-04, goal mode) — CONCERN 05 DONE
Slice 5: the ~650-line payload tail → src/observability-payloads.ts (17 exported builders,
internals private). The queue's own boundary test caught the move's deep fabric import AND the
stale allowlist entry — the allowlist discipline biting its author, exactly as designed. codex
1 Low survived (EOF whitespace) + byte-diff/cache-singleton verification; grok flaked twice
(honest coverage-gap row, no pretend-coverage). server.ts 4,890 → 3,709 over slices 3–5; the
route-table seam is complete at 6 lane modules. TEN concerns done.

## Iteration 23 (2026-08-04, goal mode) — CONCERN 11 DONE
05 slice 4 = concern 11 whole: routes/voice.ts, both lanes (mint pre-gate context + 14-route
manager-tier call cluster on decoded table params). Both blind passes CLEAN with their strongest
verification yet — codex live-probed the reserve→compensate→finalize audit flow against an
in-memory DB; grok byte-diffed every handler vs HEAD. ~310 more lines out of server.ts. Nine
concerns done. Remaining in 05: payload builders only.

## Iteration 22 (2026-08-04, goal mode)
05 slice 3: routes/org.ts — 13 session-tier org/auth admin routes as data; the seam's third
context shape (MatchContext base for pre-manager lanes, type-level relax only). Both blind
passes CLEAN on behaviour (codex ran live fall-through probes on the role|remove RegExp);
grok's 2 Low nits (dead imports, stale table doc) fixed + recorded. Suite 4947/1 (dead-exports
pre-existing only), webapp 2024/0. Remaining in 05: voice lane (with 11), payload builders.

## Iteration 11 (2026-08-04, goal mode)
05 slice 2: attention/fog lane at the route seam, viewer context explicit (Route<C> generic).
Suite 4947/1 (dead-exports pre-existing only). Both blind passes clean — no adjudicable rows.
Process note: an unchained doc-update script failed its anchor assertion TWICE while the git
commands after it ran anyway (newline, not &&) — two commits shipped with partial docs; healed
here. Rule: docs via the Edit tool or a `&&`-chained script, never a bare heredoc + git line.
(Iteration 10's note lives on the deepen/14 branch — branch topology, not an omission.)

## Iteration 9 (2026-08-04, goal mode)
05 slice 1 shipped: the route-table seam exists and is real (two lane adapters). Suite 4947/1
(dead-exports pre-existing only — best state yet). PR: deepen/05-route-table branch.

## Queue pivot (2026-08-03, Lars)

Concerns 14–16 are the CS329A borrows (plans/research-cs329a/BRIEF.md), absorbed into this queue
per Lars: work the borrows before further deepening. Order: 15 (horizon×reliability curve — no
collision with the pending PR train) → 16 (reviewer weights — stacks on src/memory/) → 14
(difficulty-targeted dispatch — BLOCKED until the #310/#311 train merges; touches
squad-manager dispatch). Deepening concerns 05–13 resume after.

## Iteration ledger

- 2026-08-03 — 01 + 02 shipped as PR #310 (src/memory/ + DecisionLedger); grok+codex clean;
  codex live-probed the adopt race. 03 executed same session (same PR, later commits).
- 2026-08-03 — 03 done: src/ledger.ts (4 shapes), six clones → declarations, land-ledger writes
  now atomic+durable; json-parse-as-cast ratchet paid back from +5 to baseline; skills manifest
  gained "deepen". Lesson: a new .claude/skills/ entry fails skills-verify until
  COMMITTED_SKILL_NAMES in scripts/skills-verify.ts lists it.
- 2026-08-03 — 04 slice 1 (feedback lane → src/feedback-lane.ts) shipped as PR #311, stacked on
  #310; suite 4927/2 (pre-existing only); grok + codex both clean (grok byte-verified the payout
  state machine; codex runtime-probed it). REFUTED the review's voice-shell deletion claim —
  those delegations are the RBAC seam; recorded in 04's concern doc. WIP guard: at 3 unmerged
  stacked deepen PRs, the loop pauses for merges.
- 2026-08-03 — 04 slice 2 (capability lane → src/capability-lane.ts, WITH state ownership) on
  PR #311; suite 4928/1 — consolidating the audit catch-handlers paid the error-message-idiom
  ratchet back to baseline (both voice-era overages now repaid by the loop; only dead-exports +1
  workos-provision remains red). grok + codex both clean.
- 2026-08-03 — 04 slice 3 (project lane → src/project-lane.ts: registry + workspace projection +
  ephemeral lifecycle, state owned, fleet behind three read thunks) on PR #311; suite 4927/2
  (dead-exports +1 pre-existing, one isolated-pass ordering flake); grok + codex both clean.
  CS329A borrows joined the queue as 14–16 (Lars's pivot); next firing = 15 horizon curve.
  SquadManager is now ~1,100 lines lighter across the three islands.
- 2026-08-03 — 15 done (continuous mode, no pacing): horizon×reliability curve (src/
  horizon-curve.ts + GET /api/horizon + MondaySurface section). TWO blind rounds each caught
  real statistical dishonesty (codex: non-monotone "up to" + outlier-anchored top band; grok:
  cumulative laundering + sentence/evidence contradiction) — every clause of the final monotone
  band-wise rule is a bought finding with a named regression test. Root 4938/1 (dead-exports
  pre-existing only), webapp 2024/0.
- 2026-08-03 — 16 done (continuous): reviewer ledger (src/memory/reviewer-weights.ts + repo
  JSONL at plans/.reviews/ + scripts/reviewer-ledger.ts closing step, wired into deepen step 7
  and blind-review). Seeded with today's REAL adjudications: codex 9/9 survived, grok 2/2,
  native 0/1 (the voice-shell refutation) — all provisional below the n=10 floor. Codex's four
  findings on the ledger harness itself (duplicate inflation, silent all-malformed, flag-eating
  CLI, output injection) are fixed + regression-tested + recorded as rows. The suite also caught
  my own new JSON.parse-as cast (ratchet works on the ratchet-payer); removed properly.
  WIP GUARD: queue's unblocked work is exhausted until the #310/#311 train merges — loop paused.
