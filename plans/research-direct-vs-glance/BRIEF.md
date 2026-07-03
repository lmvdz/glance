# Why direct Claude Code still beats glance — and what makes glance win

**Date:** 2026-07-03
**Method:** Four parallel miners over the full session archive for this repo — ~75MB / 28 main-dir transcripts + all 8 worktree-session dirs (2026-06-27 → 2026-07-03) — plus a promise-vs-reality grounding pass over all 27 auto-memory files, README/brand/docs, and code (file:line verified). Every claim below is cited to a transcript event or code path.

**The question:** every recent session was done directly in interactive Claude Code, even though glance exists to do this work. Why — and what has to change for glance to be the tool of choice?

---

## The scoreboard

Across ~43 hours of transcript in this repo's peak week:

- **Fleet-landed units: ~3** (two test files + C01/C05 of change-driven-loops, on branches).
- **Interactively landed: everything else** — the Active Work pane, durable-resume, regression gate C02–C04, live transcript UI, gate widget, the entire omp-graph dashboard, 12 design skills, PRs #1–#26.
- The user never once said "send it to the fleet." The only fleet usage was deliberate dogfooding — and **every one of the three pipeline dogfood runs required interactive rescue**.

The user's words compress the arc: *"we did a lot of work with a very poor developer"* → *"why is 306 taking so long"* → *"yes, do it this time but i dont want to keep having to do this.."* → *"uhh, why dont we fix the ui?"* → *"1"* (= land it yourself) → *"as a user i dont fully trust the factory because I dont see anything moving automatically yet."*

---

## The seven reasons, ranked by evidence weight

### R1. The factory lies about state — so every result needs interactive re-verification anyway

- "306, 309, 310 are all false-dones" (2026-06-28): Plane said Done; nothing had landed.
- The change-driven-loops pipeline reached `exit` with `outcome: succeeded` while **four of ten concerns were never implemented at all** and batch-2 branches were stale forks that overlapped on `types.ts`.
- The 26-agent plan-reality audit (2026-06-30) found plans "stale, dead, or lying" — best-of-n an outright STATUS lie, manager-tower mislabeled done, omp-planner built then deleted.
- The stale re-dispatch incident (2026-07-03): closed concerns re-dispatched from a 5-day-old base, producing "Ready to land" branches **two of which would have reverted main to stubs**.

Once "Done" can mean "nothing landed" — or worse, "would clobber main" — the cost of using the fleet is the fleet's work *plus* a forensic audit. Doing it interactively from the start is strictly cheaper. Truth is triplicated (plan STATUS lines / Plane / roster) and reconciled one-way; that's the mechanism of every lie.

### R2. The fleet can build but cannot finish — and it lands into the wrong world

- Every dogfood ended with a human merge: no Land affordance for ad-hoc units (`dto.branch` null → `landReady` never set → operator-land returned `{committed:false, merged:false}` no-op), daemon death mid-implement (C02–C04 done by hand), fixup-cap suicide on two *pre-existing* flaky tests leaving green branches unmerged.
- Claude's settled working model, verbatim from the transcript: *"daemon builds each unit in an isolated worktree → I merge the verified branch directly into main."* A pipeline whose seventh stage is always a human git command erodes the point of dispatching.
- Deeper: the daemon lands into the **local checkout**, while the user's actual merge surface is **GitHub PRs** ("can you merge it i want to test it"; every land in the corpus was a human PR merge). origin/main drifted **~112 commits behind local main**. The fleet's merge world and the user's merge world are different worlds.

### R3. Units are context-poor: they get none of what makes the interactive session smart

A glance unit receives task text + (sometimes) a BM25 fabric primer. It does **not** get: CLAUDE.md, auto-memory (units repeatedly fell into the chunk-size-warning trap that memory explicitly documents), the user's skills (/verify, /research, /plan), MCP servers, or the model policy — dispatch sets no model (omp default), scouts/supervisor hardcode `--smol`, and `model_stylesheet` exists in the engine with **zero bundled workflows using it**. Meanwhile the interactive session runs frontier-model judgment with full memory. The result is documented: agents nerd-sniped by build warnings, verify-loop thrash on hard units, "a single in-harness agent editing the main tree directly succeeded where the squad failed twice."

### R4. There is no channel for steering, iteration, or taste — and that's most of the real work

- The highest-volume work streams (webapp, omp-graph dashboard, login art) were minute-cadence screenshot loops: "feels a bit messy", "ghost dots when I zoom", "the look and feel of the omp-graph is a bit ass", "can we rotate it to be more similar to [Image #16]" — 12–15 rounds each. Dispatch→verify→land has no lane for an image, a hunch, or a redirect.
- What exists is broken or unwired: `RpcAgent.steer()` has **zero callers** (steering rides a prompt fallback); the diff endpoint uses `git diff HEAD` so the review panel **goes blank the moment the agent commits**; there is **no request-changes/iterate flow at all**; the one human touchpoint (plan approval gate) failed three ways at once — gate answers landing in a dead process, chat "Approve" sending a prompt instead of an answer, recovery via raw REST. User verdict: *"it still feels a bit wonky that we couldn't do this properly."*

### R5. Half of engineering is read/judge/decide work, and glance has no primitive for it

Audits, code reviews, plan reconciliation, research pipelines, red-teams — all ran as in-harness subagents because a fleet unit's only deliverable is a mergeable branch. The /plan skill was explicitly rewired (2026-07-02): worktree-isolated in-harness agents **mandatory**, "/squad fleet mode as the option." Claude Code's own subagents replicate the fleet's core value (isolation + parallelism) with no daemon, no Plane config, no restart-to-deploy — and results return into the conversation.

### R6. Operational fragility makes "is the factory even on?" a research question

- The auto-dispatcher is never constructed without Plane env ("motor but no fuel line"); enabling tenancy/DB mode **silently disables the whole factory**; autonomy depends on which launcher script started the daemon, diagnosable only via `/proc/<pid>/environ`.
- The daemon runs the **global install**, so merged fixes aren't live until a manual update+restart ("hmm i still see the old UI after running squadctl.sh restart"); Claude can't even restart it (safety classifier: "needs your hand"), so it builds against throwaway daemons instead.
- Crash-loops (`exec: omp-squad: not found`, SQLite mkdir), in-memory dispatch dedup deadlocks fixed only by "i restarted", WIP cap silently dropping units, cold-start failures. Every fleet run implicitly required an interactive Claude session standing by as SRE. And the circular dependency bites: **you cannot dispatch "fix the daemon" to the daemon** — ~90% of this period's coding was glance itself.

### R7. The safety story is inverted: autonomy is opt-out, safety is opt-in

`up.sh` runs AUTODISPATCH=1 + AUTOLAND=1 + LAND_CONFIRM=0 + yolo units + smol auto-supervisor answering gates before the human sees them — while the **regression gate defaults OFF** (`land.ts:183`), the **gate sandbox defaulted OFF** until PR #22, red-baseline lands escape, and the acceptance gate is agent-authored ("`proof.ok` measures 'repo still compiles', not 'the goal was achieved' — reward hacking is not hypothetical"). So full autonomy was declared too dangerous to start ("it would unleash the fleet on the whole backlog and autoland to main"), and the only usable mode was a neutered one supervised turn-by-turn — from Claude Code.

---

## The uncomfortable comparison glance must beat

A Claude Code background job today: type the ask → it enters a worktree → works with full memory/skills/MCP/frontier model → narrates as it goes → answers questions → opens a **draft GitHub PR** → you review and merge in the world you already live in. That is glance's promised loop, minus the daemon, delivered with trust. (This brief was produced exactly that way.)

So glance cannot win by being "agents in worktrees" — Claude Code already is that. It wins on what the harness can't do alone: **persistence across sessions, a standing backlog that drains itself, phone-grade supervise-by-exception, fleet-level observability, and proof-gated serialization of many parallel lands.** Every fix below points at making those five things trustworthy, and delegating the *judgment* back to runtimes that already have it.

---

## What to build (ranked; each item cites its evidence)

### Wave 1 — Truth and finishing (attacks R1, R2: the trust killers)

1. **Land = GitHub draft PR, not local merge.** Make the unit's deliverable a pushed branch + draft PR (auto-created at landReady), with the dashboard Land button = merge the PR. Anchors truth in the user's real world, kills the origin-drift problem, gives every unit a review surface for free. *(R2; "can you merge it i want to test it"; ~112-commit drift.)*
2. **Single source of truth with two-way sync + post-merge proof.** "Done" may only be written by a land that can point at commits reachable from main (post-merge proof); plan-sync becomes bidirectional; the lifecycle-truth plan (PR #24, already decomposed) is exactly this — execute it. *(R1; false-dones, STATUS lies, stale re-dispatch.)*
3. **Flip the safety defaults, keep autonomy honest:** regression gate default ON (`land.ts:183`), auto-supervisor default OFF for gate-class questions (a smol model answering approval gates is how trust dies invisibly), LAND_CONFIRM stays ON until item 2 ships. *(R7.)*

### Wave 2 — Make units as smart as the session (attacks R3)

4. **Round-trip the ACP driver with Claude Code as a real unit runtime.** It's built (`acp-agent-driver.ts`), fake-tested, never run live. A Claude-Code-backed unit inherits skills, CLAUDE.md, memory, MCP, and model policy in one move — the single highest-leverage unwired asset in the repo. *(R3, R5.)*
5. **Until then: context injection + model policy at dispatch.** Always build the fabric primer (not only when `featureId` is set), prepend a distilled "traps" digest from auto-memory (chunk-warning, PATH, flaky spawn tests), and set models per the documented policy (Sonnet for implementation, frontier for judgment) — wire `model_stylesheet` into research-plan-implement. *(R3; nerd-snipe + thrash evidence.)*

### Wave 3 — A steering lane (attacks R4)

6. **Fix the review loop:** diff vs. fork-point (`git diff <base>...HEAD`, not `diff HEAD`) so the panel survives commits; add a request-changes action that reopens the unit with the feedback attached. *(R4; blank diff, no iterate flow.)*
7. **Wire `steer()` and make the gate un-missable:** chat input to a working unit sends a real steer frame; gate answers verify the target process is alive and confirm receipt in the UI; execute the astryx-chat borrows (PR #26) for the AssistantChat surface. *(R4; dead-process gate, "okay i typed Approve now what".)*
8. **Accept images in the unit chat.** Screenshot-in feedback is the user's dominant iteration mode; a fleet that can't receive a screenshot can't host UI work at all. *(R4; 12–15-round design loops.)*

### Wave 4 — Answer units and operability (attacks R5, R6)

9. **A second deliverable type: the report.** `glance ask "audit X"` → unit whose output is a rendered report in the dashboard/chat, no branch required. This is half of all real usage (audits, research, reviews) currently monopolized by in-harness subagents. *(R5.)*
10. **Kill the deploy gap:** daemon serves from the repo checkout (or self-updates on land), `glance doctor` one-shots the topology diagnosis (Plane armed? autonomy constructed? which install? which env?), building on the factory status strip (a785920/49c1820) that already answers "is it alive." *(R6; "motor but no fuel line", global-install staleness, restart rituals.)*

**Sequencing rationale:** Waves 1–2 change the answer to "do I trust what came back?"; that's the adoption gate. Waves 3–4 change "can I work the way I actually work?" — necessary for glance to host design/judgment work, but worthless while results still need forensic audits.

---

## Appendix: capability delta (interactive Claude Code vs. glance unit, as-verified)

| Dimension | Interactive Claude Code | glance unit today |
|---|---|---|
| Start latency | seconds, in-tree | Plane issue → 60s dispatch tick → worktree + cold start (flaky) → WIP cap may silently drop |
| Steering | native, instant | `steer()` unwired; prompt fallback; no image input |
| Questions back | first-class | Queue + push, but smol auto-supervisor may answer first; gate answers can hit dead processes |
| Context/memory | CLAUDE.md + auto-memory + history | task text + optional BM25 primer; re-hits documented traps |
| Skills/MCP | all | two host tools (`squad_kb_search`, `squad_message`) |
| Model | policy-driven, frontier judgment | omp default; scouts/supervisor hardcoded `--smol`; stylesheet unused |
| Review | watch the diff form, redirect | `git diff HEAD` blank after commit; no request-changes |
| Verification | /verify + human judgment | proof/verify gates, but regression gate + sandbox opt-in; agent-authored acceptance; reward-hackable |
| Landing | draft PR in user's GitHub world | local merge into a checkout ~112 commits ahead of origin |
| Failure recovery | pivot immediately | repair budget → park/CATASTROPHE; state loss on daemon death (pre-durable-resume) |
| Where glance genuinely wins | single thread; shared-tree collisions | true parallel isolation, merge serialization, restart survival, phone supervision, standing backlog |
