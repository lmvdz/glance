# Difficulty-targeted dispatch — no learning signal from all-pass or all-fail work
STATUS: in-progress
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/dispatch.ts, src/squad-manager.ts (escalation policy), src/model-outcomes.ts / task-outcome counters
MODE: afk

## Goal
CS329A borrow #1 (plans/research-cs329a/BRIEF.md): DAPO's dynamic sampling and Absolute-Zero's
proposer reward both encode the same fact — work that always succeeds or always fails carries
zero learning signal, and compute spent there is wasted. glance's logged escalate-cap burn and
verify-loop thrash (glance-fleet memory: workflow units burning the escalate cap 2-for-2) are
this failure mode live. Use existing task-outcome counters to classify work by observed
pass-rate band and shape the escalation/retry policy: stop re-dispatching into all-fail bands
(escalate to a human or a re-scope instead), stop burning verify-loop passes on all-pass bands.

## Slice ledger
- Slice 1 (2026-08-04, iteration 10): SHADOW instrumentation shipped — src/dispatch-difficulty.ts
  (pooled per-tier classifier over model-outcomes, off/shadow/apply flag) + a once-per-tick
  Dispatcher dep with transition-only logging + the 'difficulty' skipReason + .env.example entry.
  GATING DELIBERATELY UNSHIPPED: codex's blind pass produced three High findings, all survived —
  (1) the gate can only key mid pre-spawn while outcomes record light/heavy post-routing;
  (2) family pooling defeats model-route's escalation ladder; (3) deferral generates no new
  evidence and no escalation verb exists, so all-fail classes starve. An operator apply request
  is refused loudly and runs shadow.

## DESIGN (slice 2, 2026-08-04 — answers the review's three High findings; red-teamed below)

**Evidence unit: the ISSUE, not the tier.** Per-issue attempt history is the DAPO-faithful unit
and dissolves finding 1 (class mismatch) by construction — an issue's own attempts are the class.
New tiny ledger via src/ledger.ts's `mapFile` shape: `issue-attempts.json`,
`issueId → { attempts, fails, lastAt, lastAgentId, strategies[] }`, written on the SAME terminal
paths that already write model-outcomes (finalize / workflow_terminal). The tier-pooled
shadow instrumentation from slice 1 stays as fleet-level telemetry only — it never gates.

**Class shape: none.** No family pooling, no tier pooling for gating (dissolves finding 2):
model-route stays free to escalate families WITHIN an issue's attempt budget, and the budget
counts attempts across families — which is exactly what "this task doesn't land here" means.

**The gate + budget:** an issue with `attempts ≥ 3` and `fails === attempts` is STARVED
(3 aligns with the race-once ladder: original + raced sibling + one more). A starved issue is
skipped by auto-dispatch — per-issue, so the dispatcher's existing dormant defer seam is the
right shape and needs only the dep to key on the issue.

**The escalation verb (dissolves finding 3):** starvation is needs-you material, through
EXISTING surfaces — no new card kind (BOOT-THE-ROOM noise lesson): (a) `fileScopeFinding`
("3 attempts, 0 lands — needs re-scope or your call", once per starve transition, the
race-ledger first-wins idiom prevents re-announcement); (b) the attention ladder's existing
needs-you rung via the same path land-blocked escalation uses. The verb is a HAND-OFF, not a
retry variant — race-once already spent the alternate-strategy budget before starvation counts 3.

**What clears a verdict: explicit human action, never time.** (a) An operator re-dispatch
(the attention card's action / `glance dispatch` on the issue) resets the counter — the ack IS
the clear; (b) a Plane issue-body change (re-scope) resets it — detected by the body-hash the
dispatcher already pulls for spec materialization. Time decay is rejected: evidence does not
rot by waiting, and a silent timer would re-burn units at 3am (the exact failure this borrow
exists to stop).

## DESIGN v2 amendments (red-team round, 2026-08-04 — codex 5 + grok 3 findings, all survived)

1. **Seam shape (codex+grok):** the live once-per-tick `difficulty()` dep is the WRONG seam for
   per-issue gating — slice 3 adds a separate `difficultyFor?: (repo, issue)` dep consulted
   inside the candidate loop with per-issue transition logging. The tick-global dep stays for
   the tier telemetry only. "Needs only the dep to key on the issue" was an understatement.
2. **Clear-on-body-change is DROPPED (codex):** no canonical body hash exists at gate time, and
   a typo/format/automation edit must never silently re-arm three failures. v1 clearing is the
   explicit human verb only; a semantic scope-revision clear can earn its way in later.
3. **The clear verb, fully specified (codex+grok):** operator-tier only (authz.ts mutation
   floor), an explicit action (attention-card action → `POST /api/issues/:id/redispatch`),
   which (a) writes an append-only audit row (actor, reason, prior verdict), (b) resets the
   issue-attempts row WITH the actor recorded in it, (c) never touches the add-only dispatch
   ledger. An ordinary spawn/retry NEVER implicitly clears.
4. **Race-once identity (codex):** a cleared/re-dispatched issue does NOT regain race
   eligibility — race stays once-per-issue-ever. Stated, not accidental: post-starvation a
   human is in the loop, strictly stronger than a second automated race.
5. **The surface must render, and must survive crashes (codex):** fileScopeFinding is telemetry,
   not a needs-you surface, and stamp-before-emit loses the only announcement in a crash
   window. v1: starvation is EMITTED FROM STATE — each dispatch tick (and boot) derives
   "starved && not acked" from the issue-attempts ledger and idempotently upserts a durable,
   repo-scoped attention entry. No one-shot announcement, no outbox to lose.
6. **Single write point (grok):** attempts are written where recordModelOutcome already fires
   (one site), keyed by runId for idempotency — finalize + workflow_terminal must not double-
   bill one unit, and a race "pending" placeholder writes no attempt row.

## Slice 3a done (2026-08-04, iteration 13): the evidence half — issue-attempts ledger
(ring-dedup recent runIds, judged-only, write-invalidated tick snapshot), single write point
beside recordModelOutcome (active runId preferred — finalize-race fix), per-issue difficultyFor
dispatcher seam (transition-once log, candidate-set sweep, defer honored), STARVED shadow
verdicts at 3/3. Four codex findings survived + fixed + recorded; codex's finding #1 lost to
output truncation twice — not recorded, not fabricated. grok post-fix clean.

## Slice 3b shipped PARTIAL (2026-08-04, iteration 14) — apply RETREATED to shadow a 2nd time.
Built: starvedIssues() derived reader (surface and gate read the same function), action-item
rows (API-visible), POST /api/issues/:id/redispatch clear verb (starved-rows-only, audited,
race-eligibility untouched), identifier captured on rows. Round-2 blind review (codex, 5
findings, all survived) stopped apply from lying: rows may not RENDER (webapp consumer +
no clear control), no repo on rows (?repo= views hide verdicts), clear lacks a generation
baseline (pre-clear in-flight failure instantly re-starves), audit thin, DB-mode GET/POST
manager-binding mismatch.

## 3b-final checklist (→ then STATUS: done; each item = a round-2 finding):
1. Rendered control: wire the row through the webapp consumer with a redispatch action that
   calls the POST (verify insights.ts actually surfaces non-health items; else the room card).
2. `repo` persisted on attempt rows at the write site; equality filter under ?repo=.
3. Clear = generation baseline (attemptsAtClear watermark; verdicts computed on post-clear
   evidence only; pre-clear in-flight runs bill the OLD generation).
4. Audit carries prior verdict + operator reason; both backends awaited.
5. Action carries its manager/org binding; POST resolves the originating manager (DB mode).

## Provenance
Lecture 6 (DAPO 30→50 via dynamic sampling), lecture 7 (Absolute-Zero proposer reward maximized
at intermediate difficulty). Pre-adjudicated in the brief; do not re-research.
