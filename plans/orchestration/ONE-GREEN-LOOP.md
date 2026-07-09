# ONE GREEN LOOP — the only thing standing between glance and the goal

**Goal (2026-07-09, user):** *"make glance the only place a user wants to be for working with ai to
build things."*

**Verdict:** the gap is not a screen. **glance has never once finished.** Across both managers, 17
days, and 1,708 recorded land attempts, **zero autonomously-dispatched units have ever merged.**
Every PR and every test added during the six orchestration waves was landed by hand, from Claude
Code. The cockpit is excellent. The propeller has never turned.

---

## 1. What we built, and why (the through-line — keep this)

The founding brief (`plans/research-direct-vs-glance/BRIEF.md`, 2026-07-03) settled the strategy and
it still holds: **glance cannot win by being "agents in worktrees."** Claude Code already is that —
worktree isolation, full memory, skills, MCP, frontier judgment, a draft PR at the end. glance wins
only on the five things a single harness session structurally cannot do:

1. **Persistence** — it is still there tomorrow; a session is not.
2. **A standing backlog that drains itself** — nobody has to be at the keyboard.
3. **Supervise-by-exception, phone-grade** — you glance, and you know.
4. **Fleet-level observability** — many agents, one legible surface.
5. **Proof-gated serialization of many parallel lands** — one at a time is all a harness gives you.

**We have genuinely built #3 and #4.** The UI is their expression, and every part of it is earned:

- **The UI value rule** ("before building a screen, name the human decision it enables; none → don't
  build") came from the largest failure buckets in the transcript mining: *the system lies about
  state* (44 records) and *UI built as data-dump* (26 — "why would the human ever even look here").
- **GRAPH-FOLD killed 8 pages** by asking each what decision it served. Only three signals were
  genuinely *time-shaped* and belonged in the Graph. Fleet-health and autonomy were *now-scalars* →
  a header chip. Knowledge was a *lookup* with no time axis → ⌘K. Heat's file-collision and
  Federation's lease-collision turned out to be **the same fact** (≥2 live agents on one path) → one
  signal. Activity-rhythm was literally redundant with the DEPTH massif. Topology was now-structure →
  the `run` inspector. Nothing was cut for tidiness; each was cut for failing to justify a decision.
- **Four nav items because the operator has four questions.** *What needs me right now* (Fleet) ·
  *what are we building* (Tasks) · *what happened over time* (Graph) · *what can the fleet do*
  (Capabilities). `org`, `review`, `intervene` are routed *into*, never navigated *to* — you arrive
  from a decision, not from a menu.
- **Needs-you is pinned, non-collapsible, and badged on every view** because supervise-by-exception
  *is* the product. If a busy roster can bury the blocked agent, the product is a lie. (GRAPH-FOLD
  §6(g) makes this an explicit red-team guard.)
- **The UI must never be more confident than the system.** The deepest rule, and it was bought with
  an incident: validator veto + confidence were on the wire and rendered in **zero** components — the
  UI said "ready to land" over a vetoed unit (PR #67). Hence proof-provenance, done-proofs, the
  land-blocked banner, and honest empty states (#126 renders *why* a channel is empty rather than an
  empty list). Every surface shows a verified fact or admits it doesn't know.
- **One ember accent, one focal point per view**, humans and agents as visually distinct species,
  status chips as the universal state language, keyboard hints as first-class chrome. The promise is
  literally *you glance and you know*; a wall of color is a wall you have to read. In a
  mixed-authorship system the first question is always "who did this."
- **The design-review loop, the N/M-resolved gate, and the plan vote** exist because the highest-volume
  real work was never dispatch→verify→land. It was 12–15-round iteration on taste ("feels a bit
  messy", "ghost dots when I zoom"). Dispatch had no lane for an image, a hunch, or a redirect.
- **Page-contextual chat + annotate→confirm→spawn (#139)** productizes the exact loop that built
  glance: screenshot what's wrong, circle it, a unit is born under a draft-PR contract. Human-gated at
  the confirm sheet, always — an injected "spawn 100 units" must never self-execute.

None of that is the problem. Pillars **#1, #2 and #5 have never once demonstrated themselves.**

## 2. The verified diagnosis — a two-condition interlock

Both conditions are individually correct. Together they are fatal, and they were invisible because
the failure is classed `retryable`.

1. `src/land-mode.ts` probe 4 downgraded to **local-merge mode** whenever the operator's checkout was
   not on the remote default branch — *"a deliberate non-default checkout always wins."*
2. Local mode routes to `landAgent`, which at `src/land.ts:422` **refuses to merge into a checkout
   with uncommitted tracked changes** (a correct rollback blast-radius guard), returning
   `retryable: true` (`squad-manager.ts:2826` classes it `dirty-main`).

An operator working in the repo trips **both**. So: *whenever a human is actively using glance — the
only time glance is useful — glance is silently downgraded into a landing mode that refuses to land,
and retries forever without escalating.*

Probe 5 sealed it independently: it compared **`HEAD`** to `origin/<default>` while its own comment
said it compared the *local default branch*. On any feature branch HEAD is never an ancestor of
origin/main, so it re-forced local mode even with probe 4 removed.

### The evidence (live, this repo, 2026-07-09)

| Fact | Value |
|---|---|
| Land attempts, file-mode manager | 1,686 — **246 ok / 1,440 error** |
| …died on `uncommitted tracked changes` | **1,381 (82%)** |
| Land attempts, org-mode manager | 22 — 20 dirty-main refusals, 2 operator force-overrides (both failed downstream) |
| Autonomously-dispatched units ever merged | **0** |
| Last land *attempted* by the fleet | 2026-06-28 (file) / 2026-07-07 (org, forced) |
| `catastrophe` events | 65, **100% identical**: `node "escalate" exceeded its visit cap (2)` |
| `task-outcomes.jsonl` (fleet learning ledger) | **1 row** — from the force-landed unit that then failed |
| `model-outcomes` store | does not exist on disk |
| PR-mode lands, ever | **0** — `land-pr.ts` shipped 2026-07-03, never executed |

Two further ironies, both verified:

- The tracked files jamming the gate at diagnosis time were `plans/orchestration/LEDGER.md` and a plan
  doc. **The charter's own "Ledger, not chat" discipline is what blocked the factory.**
- In local mode, spawned units fork from the operator's **feature-branch HEAD**
  (`squad-manager.ts:3745-3750` only forks from `origin/<default>` in pr mode). Every unit dispatched
  in the last 17 days inherited whatever branch the human happened to be standing on.

## 3. The fix (landed in this pass)

`src/land-mode.ts`:

- **Probe 4 no longer gates.** The operator's checked-out branch is read for the `reason` string and
  nothing else. A PR-mode unit forks from `origin/<default>` into its own worktree and lands by
  pushing that branch and merging the PR on the remote — the shared checkout is never merged into,
  never reset, never read. A non-default checkout is an argument **for** pr mode ("never touch the
  tree the human is standing on"), not against it. `OMP_SQUAD_LAND_MODE=local` remains the opt-out.
- **Probe 5 reads `refs/heads/<default>`**, not `HEAD` — what its comment always claimed. It still
  forces local when the local default has unpushed commits (they would be stranded by a remote merge),
  including from a feature checkout. Absent local default ref ⇒ nothing to strand ⇒ pr.

Live result on this repo, dirty and on `feat/grok-harness` — the exact state that blocked every land:

```
{"mode":"pr","defaultBranch":"main",
 "reason":"all 5 probes passed (slug lmvdz/glance, default main; operator on feat/grok-harness,
           units fork from origin/main)"}
```

**Second-order win, mutation-proven.** `ffHealOne` (`squad-manager.ts`) is the only write PR mode ever
makes to the shared checkout (`merge --ff-only`), guarded by `current !== defaultBranch`. Its comment
called that guard redundant with probe 4. It no longer is — it is now the *only* thing enforcing it.
`tests/pr-reconciler.test.ts`'s "does NOT ff-heal a repo checked out on a non-default branch" used to
pass **vacuously** (mode was `local`; `ffHealOne` bailed before reaching the guard). It now exercises
the guard for real: deleting the guard turns it red. Comment corrected; invariant documented.

### Cross-lineage review (git-write path — both lineages, per policy)

grok-4.5 and gpt-5.6-sol reviewed the diff independently. Neither found a path where pr mode writes to
the shared checkout or merges a wrong base. They were complementary, exactly as the model policy
predicts, and three findings were verified against source and **fixed in this pass**:

1. **Transplant (both, High).** `worktree.ts:149` reuses an existing branch ref and ignores the
   caller's start point, so a `squad/*` branch forked back when the daemon forked from the operator's
   local HEAD still carries the operator's unpushed commits. Local mode merged it back into the
   checkout it came from (a no-op for those commits); pr mode would **publish them to origin/main**.
   → new `transplantedCommitsReason` gate in `land-pr.ts`, refusing **before the first push**,
   `retryable: false`. Stacked `squad/*` branches deliberately allowed. Verified: 0 false positives
   across all 35 real `squad/*` branches in this repo; an independent reachability audit found the
   same 0 live exposures. (A first cut *did* false-positive — `--exclude` patterns for `--branches`
   are relative to `refs/heads/`, so `refs/heads/squad/*` matched nothing and the gate flagged the
   agent's own commits. Caught by a negative test, which is why they were written.)
2. **Fail-open fetch (codex, High).** `hardenedGit` reports failure via a nonzero `code` and never
   rejects, so probe 5's `.catch(() => undefined)` around `git fetch` was decorative: a failed fetch
   fell through to an ancestor test against a **stale** `origin/<default>`, which trivially passes.
   The daemon would gate a scratch merge against the stale base while GitHub merged the PR into the
   real one. → probe 5 now fails closed on a nonzero fetch.
3. **ff-heal TOCTOU (codex, Medium).** `ffHealOne` checked the branch *before* the fetch and *before*
   `withRepoLandLock`; the lock serializes daemon lands, not the operator's `git checkout`. → HEAD ref
   and sha re-read inside the lock, bail if either moved.

Accepted, not fixed: the 5-minute land-mode TTL can serve a cached `pr` for up to 5 minutes after the
operator adds an unpushed commit to local `main`, stranding it (both lineages, Medium; pre-existing and
already codified in `tests/land-mode.test.ts`). Also grok's stale-diverged-local-`main` footgun: probe 5
correctly forces `local` there, which correctly re-engages the dirty refuse — the right behavior, but it
is silent. **G2 covers making it loud.**

## 4. What this does NOT fix — and the actual next unit

`OMP_SQUAD_LAND_MODE=pr` was never the whole story, and neither is this. **65 of 65 catastrophes are
the same event:** `node "escalate" exceeded its visit cap (2)`. The factory's only ending is death by
escalation. Six layered root causes have been found and fixed this way — dirty main → missing
`node_modules` → rm-by-name → root-only command routing → a gitless gate image → a fail-open
regression gate — *each discovered only after the previous fix, live.* That is not bad luck. It is
what debugging a machine you never run to completion feels like.

**The single most valuable artifact in this project is not a feature. It is one completed loop:** a
real ticket, autonomously dispatched, that builds, verifies, opens a draft PR, and appears in the
Fleet view with a Land button that works. Until that exists, every fix is verified against a proxy
(the test suite) instead of against the thing, and every new surface makes the cockpit more beautiful
and the plane no more airworthy.

### Sequenced

- **G1 — the interlock.** *Done, this pass.* Probe 4/5 rewrite + fail-closed fetch + transplant gate +
  ff-heal TOCTOU, red/green and mutation-proven, reviewed by both foreign lineages. Acceptance: the
  live probe returns `pr` on a dirty, off-main checkout. ✔
- **G1a — housekeeping the user must do** (permission layer refuses the agent): delete the 35 stale
  `squad/*` branches and the junk Plane tickets OMPSQ-427/428/431/436/437/438. None are currently
  exposed by the transplant gate, but they are the exact population it exists to catch, and the junk
  tickets re-feed the error mill on every dispatch tick.
- **G2 — make death-by-escalation legible.** The escalate visit cap must not be a silent terminal
  state. On cap, capture the last gate output + the node's escalation reason, file it as a **Needs-you**
  row with the transcript pinned, and stop. Root cause #1 ("the system lies about state") applied to the
  factory's own death. Acceptance: a deliberately-broken unit surfaces in Fleet with *why*, not a
  `catastrophe` line in an audit file nobody reads.
- **G3 — run it to completion, once, watched.** *Run 2026-07-09 on an isolated scratch daemon (file
  mode, every autonomous loop off, `LAND_CONFIRM=1`). Nothing was fixed beforehand. It told us what
  breaks.* Unit: wire the unreachable `openIntervene`. Result: the unit built the right change, and
  **still could not land**. Findings below; acceptance (a fleet-opened draft PR) NOT yet reached — the
  push is outward-facing and awaits the operator.

### What the live run found (all reproduced, none inferred)

1. **THE NEXT INTERLOCK — nothing in the loop ever commits.** The bundled verify-loop workflow's
   stages are `Implement → Verify → exit`. There is no commit stage. The agent ends with uncommitted
   edits and reports "Done". Then `proofGate` (`proof.ts:254`/`:360`) refuses a dirty worktree —
   *"worktree has uncommitted changes … commit or discard them before Verify"* — so no proof exists;
   `landReady` is never set; `autoLandWorkflow` (`squad-manager.ts:2983`) pre-gates on the same
   `proofGate` and bails. **The fleet cannot self-finish.**
   The asymmetry is the bug: `land()` sweeps WIP (`commitWip: !busy`, `squad-manager.ts:2622`) *before*
   its proof gate (`land-pr.ts:532` precedes `:583`), so **a human clicking Land can land what the fleet
   structurally cannot.** That is the founding brief's R2 ("builds but cannot finish"), with a mechanism.
   PROVEN: supplying the one missing commit by hand and re-running Verify → `ok:true, dirty:false,
   sandboxed:true`, full `bun run check && bun run test` green in the docker gate. Everything downstream
   of the commit already works, including the Wave-4 sandbox image.
2. **The gate does not cover the webapp — a fail-open of the Wave-4 class.** Root `bun run check` is
   `tsc --noEmit` on the root tsconfig (webapp has its own), and `bunfig.toml` pins `[test] root="tests"`,
   so root `bun test` never runs `webapp/**/*.test.tsx`. Live: the unit's first version **passed
   `bun run check` while failing `webapp` tsc** (a required prop passed at 0 of 4 call sites). A
   webapp-only unit can pass the entire proof gate while being broken.
3. **Steering is swallowed inside a workflow.** An operator `prompt` sent to a unit running the
   verify-loop workflow does not steer it: the workflow re-entered `stage: Implement`, re-answered its
   own original goal ("The goal is complete"), re-ran Verify, and exited. My explicit "you never
   committed, run git commit" instruction was never executed. This is R4 ("`steer()` has zero callers;
   steering rides a prompt fallback") reproduced live.
4. Two ops traps worth writing down: `bun --no-env-file` still let the repo `.env` through when the
   daemon was launched **from the repo cwd** — it booted DB mode against `~/.glance/glance.db` and
   answered every mutation `403 no active organization` (`server.ts:721`, `noFleet`). Launching from a
   cwd with no `.env` fixed it; assert the file-mode `federation:` log line rather than trusting the
   flag. And `rtk` mangles bash `grep` — three "zero match" results this session were false; use
   `rtk proxy grep` or python.

### G3 follow-ups

- **G3a — give the loop a commit. ✔ DONE, and THE LOOP CLOSED.** New `SquadManager.commitAgentWip(id)`
  sweeps a finished agent's uncommitted work onto its own branch, mirroring `land()`'s existing
  `commitWip: !busy` semantics. Wired as a new `settleWork` orchestrator dep that runs *before*
  `stateKey` reads HEAD. `verifyFeature` sweeps every live member too (the orchestrator routes
  feature units through `verify`, not `verifyAgent` — missed on the first cut, caught by grok).

  **PROVEN END TO END, unattended** (throwaway repo + local bare origin, orchestrator on, no GitHub):
  an agent was told to write a file and *explicitly not to commit*. The daemon's audit log:

  ```
  16:29:14  create      ok   Create a file named greeting.txt …
  16:29:51  commit-wip  ok   wip(looper): sweep uncommitted work before verify
  16:29:53  verify      ok   proof ok:true dirty:false sandboxed:true
  16:34:09  land        ok   merged squad/looper-… (fast-forward); verified
  ```

  `landReady: true` — a state no glance unit had ever reached — then a one-tap Land merged it.
  `greeting.txt` landed on main. **The first completed loop in this system's history.**

- **G3b — make the gate cover what the unit changed. ✔ DONE.** `check` now runs `tsc --noEmit -p
  webapp/tsconfig.json` too, and `test` runs `bun test && cd webapp && bun test`. `detectVerifyStages`
  reads those two scripts, so every unit's gate inherits the coverage. **This nearly re-broke the
  factory:** `installScratchDeps` (the PR-mode scratch merge) installed only ROOT deps, so the moment
  the gate entered `webapp/` a green branch would fail acceptance non-retryably and get parked. Caught
  by codex; fixed to provision nested packages concurrently, fail-closed, in step with
  `provisionWorktreeDeps`.

- **G3c — a real steering lane. ✔ DONE.** The founding brief's R4 ("no channel for steering, iteration,
  or taste — and that's most of the real work") is closed.

  **Root cause:** `WorkflowDriver.prompt()` guarded on `if (!this.runActive)`, which is *also* true once a
  run has FINISHED. So a prompt to a completed unit silently re-entered `execRun(message)` — a whole new
  graph traversal with the steer text as its "goal". The inner agent, which remembers the original task,
  answered "the goal is complete"; Verify re-ran; the run exited; the instruction never executed; nothing
  reported it swallowed. Fixed with a `hasRun` latch (not `runActive`): the first prompt is the goal,
  every prompt after it steers the live agent. A rejected steer now surfaces `⚠ steer not delivered`
  instead of `.catch(() => {})`.

  **Three further defects the fix itself introduced or exposed, all caught by cross-lineage review:**
  1. *(grok-4.5, High)* `getState().isStreaming` was `runActive`, so a unit **being steered reported IDLE
     while its agent wrote files** — and `commitAgentWip`/verify/land fire on idle agents. The
     orchestrator could sweep-commit and land a half-written tree. Now
     `runActive || promptInFlight || (innerTurnOpen && inner.isAlive)`, and the inner turn's
     `agent_start`/`agent_end` are forwarded outside a run (swallowed during one, where the graph owns
     the lifecycle).
  2. *(gpt-5.6-sol, Medium)* One busy flag was wrong in both directions: clearing it when `inner.prompt()`
     REJECTS after the agent already emitted `agent_start` reports idle over a live turn; never clearing
     it when `agent_end` is missed strands the unit "working" forever, never verified, never landed. Split
     into `promptInFlight` (send) and `innerTurnOpen` (turn); a dead inner and `execRun`'s finally both
     end a turn. The isolatedLineage `tester` no longer clears the coder's turn.
  3. *(gpt-5.6-sol, High)* **The steering lane would have shipped broken.** The orchestrator's `staged`/
     `landed` sets are in-memory, keyed by `workId`, and their guards run BEFORE `agentHasWork` — and no
     key changes when a steered agent edits files. Once a unit had been verified-and-staged, everything a
     later steer produced was skipped forever. New `Orchestrator.invalidate(agentId, featureId?)`, called
     from the manager the moment a prompt is delivered, clears `staged`/`landed`/`halted`. Un-halting is
     deliberate: a parked unit a human explicitly steers should resume — that is what "step in" means.

  **PROVEN LIVE, end to end** (throwaway repo, orchestrator on). Unit created `first.txt`, was swept,
  verified and staged. Then steered — "also create steered.txt" — with no human touching anything else:

  ```
  17:53:27  create      ok    Create a file first.txt …
  17:54:40  commit-wip  ok    squad(s2): agent changes
  17:54:43  verify      ok
  17:59:06  prompt      ok    New instruction: also create steered.txt …   ← the steer
  18:01:50  commit-wip  ok    squad(s2): agent changes                     ← invalidate() let it re-run
  18:01:52  verify      ok
  18:01:55  land        ok    merged squad/s2-… (fast-forward)
  ```

  The unit stayed `working` for the whole steer turn (no premature sweep), the workflow did **not** re-run
  (`Implement ×1, Verify ×1`), and both files landed on main. An earlier isolated drive confirmed the same
  on the graph side: steer executed, `first.txt` untouched, one Implement, one Verify, one exit.

- **G3d — the fleet opened its own draft PR. ✔ DONE. THE ACCEPTANCE TEST PASSES.**
  Operator-authorized, 2026-07-09. Scratch daemon against the REAL repo (file mode, orchestrator on,
  `LAND_CONFIRM=1`, dispatch/observer/scout off, Plane disarmed). One unit, told to **edit files only —
  no shell commands, no `git commit`**. It wired `openIntervene` into the cockpit and wrote a test.
  Then, with no human touching it:

  ```
  verify      error  worktree has uncommitted changes …   ← the old interlock, one last time
  commit-wip  ok     wip(intervene-wiring): sweep uncommitted work before verify
  verify      ok
  landReady   true   → floatPrOnLandReady → git push → gh pr create --draft
  ```

  → **https://github.com/lmvdz/glance/pull/149** — draft, OPEN, MERGEABLE, +194/−2 over 2 files,
  authored by the fleet, held for the operator's one-tap merge (confirm mode). The first PR glance has
  ever opened for itself. Independently verified afterwards: all four `<RosterAgentRow>` call sites
  wired, `webapp` tsc clean, **815 webapp tests pass** (804 + 11 new).

  Note that `verify error (dirty)` appears once BEFORE the sweep — that is the workflow's own verify
  stage hitting the old interlock, then `settleWork` clearing it on the orchestrator's next tick. The
  loop now self-heals the exact condition that used to kill it.

  **The unit's gate ran `origin/main`'s scripts, which do not typecheck the webapp** (G3b's fix is not
  on main yet), so its green was weaker than it looked. I verified the webapp typecheck and tests by
  hand. Land G3b before trusting a webapp unit's own gate.

### Fresh finding from the PR run — G3e ✔ FIXED

PR #149's commit was titled `wip(intervene-wiring): sweep uncommitted work before verify` — the
daemon's internal plumbing message, permanently, on a real PR a human reviews. `commitAgentWip` now
titles the commit after the WORK (`<ISSUE-ID>: <issue name>` when the unit has a ticket, else `land()`'s
existing `squad(<name>): agent changes` shape) and keeps the sweep provenance in the commit body. It is
on every commit the fleet will ever author, so it was worth the ten minutes.

## Where this leaves the goal

The five pillars glance must own (a harness cannot): persistence · a self-draining backlog · phone-grade
supervise-by-exception · fleet observability · proof-gated serialization of many parallel lands. Three
and four were already built — the UI is their expression, and it is good. **As of 2026-07-09 the other
two are no longer hypothetical:** a unit now goes dirty-worktree → commit → sandboxed proof → landReady
→ draft PR, unattended, and the merge waits for one human tap.

**G3c closed the last structural gap.** A unit can now be steered mid-life or after it finishes, and the
work a steer produces is swept, verified and landed like any other. That was the missing lane for design
work — the 12-to-15-round screenshot loops the founding brief called "most of the real work".

Still open: **G4** (the learning ledger is one row; it stays empty until real lands accumulate — now
unblocked), and landing G1/G3a/G3b/G3c/G3e themselves, so the fleet's *own* gate covers the webapp
(units fork from `origin/main`, which does not yet carry any of this).

Final gate on `feat/grok-harness`: **2390 backend + 804 webapp, 0 fail, tsc clean on both projects,
effect-ratchet green.** Ten guards mutation-proven across the four fixes.

### Cross-lineage review of G3a/G3b (autonomous git-write ⇒ both lineages, per policy)

Complementary again; every finding verified against source before acting.

- **grok-4.5:** `verifyFeature` was still on the old interlock (the orchestrator's `verify` hook routes
  feature units through it) — the fix would have missed every feature-mode unit. Also: the in-place
  guard used a textual `path.resolve`, so a symlinked worktree could have committed on the operator's
  own checkout (now resolved through `fs.realpath`; mutation-proven).
- **gpt-5.6-sol:** the `installScratchDeps` root-only install above (High). `verifyFeature` returned
  **`ok: true` for an empty member set** — `[].every()` is `true` — verifying green work it never ran
  (now fails closed). And the sweep changed HEAD *after* `stateKey` was derived from it, so durable
  `halted`/`verified` records were keyed to a HEAD that no longer existed and were re-driven on restart
  (sweep moved ahead of `stateKey` via the `settleWork` dep).
- **Both:** "idle" is an observation, not quiescence. Mitigated with an idle dwell
  (`OMP_SQUAD_WIP_SWEEP_DWELL_MS`, default 3s) plus a status re-check immediately before the write. The
  residual — an agent's own child process writing during the sweep — cannot be closed by any lock, and
  is the identical exposure `land()`'s sweep has always carried. Documented, not hidden.
- Accepted, not fixed: submodule content is not recursively swept (**this repo has no submodules**);
  `snapshotBranches` replaces rather than merges `pf.branches` (pre-existing, out of scope).

Gate after all of it: **2376 backend + 804 webapp, 0 fail, tsc clean on both projects.** Four guards
mutation-proven (delete the guard → the test goes red): the ff-heal branch check, the `settleWork`
sweep, the `verifyFeature` member sweep, the symlink in-place guard, and the empty-member fail-closed.
- **G4 — close the learning loop.** `task-outcomes.jsonl` has one row and `model-outcomes` has no file,
  so every routing decision, cost tie-break and scoreboard reads an empty table. They stay empty until
  G3 produces the first real outcome. Re-verify *after* G3, not before.

### Deliberately not doing yet, and why

- **No new UI surfaces.** The nav is right, the fold is right, Needs-you is right. `IntervenceView`
  has **zero callers** (`openIntervene` is defined and never invoked) — the flagship "step in" screen
  is unreachable. That is a real bug and a cheap fix, but it is a *steering* surface for a fleet that
  cannot finish. Wire it in G3's wake, when there is something to steer.
- **No factory root-cause hunting.** That is the trap. G3 first.
