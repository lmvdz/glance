# Design: glance as its builder's daily driver

Evidence base: `plans/research-t3code/BRIEF.md` (rounds 1+2). Adversarial design run 2026-07-15: sonnet designer → two fable red teams (safety lens; adoption lens) → fable arbiter. This document records the arbitrated result; the full critiques and arbitration brief are summarized in the tables below.

## Approach

Glance loses its own builder to plain Claude Code because the incumbent's friction is already near zero. The plan therefore ships two things at once, and refuses to ship either alone:

- **An on-ramp** — `glance here` opens a thread on the current directory, **in the current terminal**, riding the operator's own claude login and config, with the webapp a printed URL away. The session runs in a standard worktree (the OMPSQ-40 isolation invariant stays law); after each finished turn the daemon applies that turn's patch to the real checkout **only if the real tree hasn't moved since the turn started** — otherwise it holds and raises attention. Edits appear where the operator is looking, without agent-vs-human races and without repealing the safety invariant.
- **A reason** — the one thing terminal claude cannot do: glance pages your phone when a long task finishes or blocks (generalizing the shipped voice-done push latch), and the checkpoint/fork lane means a casual thread is never lost work. Both land in wave 1, not three epics later.

Around both sits a **dogfood engine**: a five-second friction-capture verb (`glance grr`), adoption counters in the meta ledger, a weekly drain cadence, and a written kill criterion. Contingent epics do not execute until the counters say the on-ramp is being used. Features didn't make t3code win; the builder living in it did.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Casual-lane isolation | Worktree kept + one-directional boundary sync per finished turn, precondition-gated on an unmoved real tree | True in-place (draft's pick); worktree + open-in-editor; auto-sync-back both ways | Red team proved the in-place guardrails targeted seams that can't enforce them (shell ops never reach the toolGrants gate; detached agent-host outlives the daemon on the live tree; ref-restore is `reset --hard` in disguise). Boundary sync delivers the visible-edits feel with none of that, in days. True in-place survives as a gated charter |
| Entry surface | Terminal-first (`glance here` attaches in the current terminal); browser is `--web` / printed URL | Browser auto-open as primary (draft's pick) | The target user lives in terminals; a tab per thought adds friction vs the incumbent. Terminal-first also moots the new one-time-token auth surface for the primary flow |
| Casual session brain | Claude harness on the operator's own login/config, parity-verified | Daemon default harness (omp) | `glance here` must not be a *less-configured* brain than typing `claude`; otherwise there is no reason to switch at turn one |
| First differentiated value | Wave-0 phone push (completion + needs-input) generalized from the shipped voice latch | Full attention ladder first (draft's pick) | The ladder is weeks of plumbing before the first behavior-changing payoff; the latch is a small delta on an existing seam |
| Dogfood mechanics | First-class epic: friction ledger, adoption counters, weekly drain, written kill criterion | Absent (draft) | The BRIEF's core finding is that dogfooding is the product strategy; a plan without the feedback engine reproduces t3code's outputs while skipping its process |
| Completion events | `quiesce` vocabulary, existing SquadEvent WS + in-process awaits; fail-closed timeouts | Reuse "receipt" naming; new bus | `receipts.ts` is the cost ledger; timeout-means-settled would rebuild the polling guess with better branding |
| Attention ladder | Charter only, expansion gated on friction evidence | Build now (draft's pick) | Per-viewer machinery has no principal in file mode (single user); wave-0 push covers the need; pure-function-of-persisted-state constraint locked for expansion |
| Preview tool | In plan, off the adoption path, red-team security spec binding | Cut entirely; build as specced | Real fleet-quality borrow, zero adoption value; origin registration is the actual SSRF surface and is now specced |
| Overhead measurement | Wave-0 stopwatch now; deterministic mock-harness ratchet as the gate; live ratio published, never gated | Live-model ratio as a land gate (draft's pick) | A live-model wall-clock gate combines every flaky-gate failure mode this repo has already paid for |

## Risks

- **Boundary sync divergence UX**: held patches must be obvious and one-click resolvable, or the lane feels broken. Mitigated by the attention item + explicit apply affordance; measured by the friction ledger.
- **Adoption fails anyway**: the kill criterion exists precisely for this — two weeks of counters decide, and contingent epics stay parked.
- **Fail-open regressions**: four instances found in the draft (checkpoint failure, daemon absence, await timeout, missed events). Every one is now a fail-closed acceptance test in its concern; reviewers must treat a missing test as a spec violation.
- **Two-repo consumers** (webapp + cockpit) cannot land atomically: ladder charter locks a staged additive migration with a capability flag.
- **Push spam** under fleet load: per-category defaults are conservative (fleet completion off, casual completion on).

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| Tool-grant guardrail cannot see shell commands (RT1 A1) | critical | True in-place deferred to charter; classifier-at-approval-seam is its named prerequisite |
| Detached agent-host outlives daemon on live tree (RT1 A2) | critical | Same deferral; charter requires detachment inversion or host-side checkpoint-receipt gating |
| Ref-restore destructive on live tree (RT1 A3) | critical | Restore is never a blind checkout: scratch-worktree materialization or hunk-apply (turn-substrate concern) |
| Checkpoint failure fail-open (RT1 A4) | critical | Fail-closed acceptance test: capture fails ⇒ turn refused/attention raised |
| "Viewer-scoped" token cannot prompt (RT1 B1) | critical | One-time-token surface deferred; primary flow is terminal + existing token mechanism; findings recorded for the hardening concern |
| No t=0 reason vs `claude` (RT2 1a) | critical | Harness/config parity concern + wave-0 push + checkpoint safety as the shipped reasons |
| Push buried three epics deep (RT2 1b) | critical | Wave-0 push epic, voice-latch generalization |
| Browser-first for a terminal user (RT2 1c) | critical | Terminal-first entry |
| No dogfood loop (RT2 §3) | critical | Dogfood-engine epic + adoption gate + kill criterion in the meta doc |
| E1→E5C03 dependency inflates Epic 1 (RT2 4a) | significant | Dependency dropped; boundary-sync check is local to the on-ramp epic |
| Reasoning-first view mostly exists (RT2 2b) | significant | Collapsed to one contingent concern (thinking already first-class in the timeline) |
| awaitQuiesce timeout fail-open, lost-wakeup, id collisions (RT1 C1-C2) | significant | Typed outcomes, pre-subscribe buffer, random ids, replay dedupe — all acceptance criteria |
| Ladder staleness across restarts (RT1 C3) | significant | Charter locks "pure function of persisted state; events are hints" |
| Preview SSRF via origin registration (RT1 E1) | significant | Operator-tier registration, daemon-origin denylist, post-join validation, payload caps |
| Restart eats the casual session (RT2 1d) | significant | Wave-1 honest re-attach concern |
| Shadow-adopt redundant + guards refuse it (RT1 A7 / RT2 2d) | significant | Cut |

## Open questions

None blocking decomposition. Two deliberately parked as charters with written expansion triggers (needs-you ladder; true in-place).
