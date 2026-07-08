# Fleet Orchestration Charter (v1 — 2026-07-07)

The reusable steering prompt + operating rules for orchestrating glance work with a model-routed
subagent fleet. Derived from: full-repo research at `b5ac449`, 424 user messages across ~2 weeks of
session transcripts (118 classified failure records), and the open plans frontier (32 concerns / 9 plans).

## The vision (the contract every unit serves)

> "A factory for composable and collaborative agentic development … a full pipeline for one agent
> thread to implement a feature end to end — research, planning, sprint, testing, regression testing."

Operationally: a human states a goal; a fleet of worktree-isolated, harness/model-matched agents runs
research → plan → implement → verify → regression-gate → land **until the goal is reached** (not until
"an improvement" exists); every unit of motion is legible in one living dashboard; the system is
trustworthy enough to supervise by exception. The acid test, in the user's words: *"what exactly is the
reason all our recent sessions were done directly in claude code — and make glance better."* When
glance can't do the work, that gap **is** the backlog.

## Where past sessions went wrong (118 failure records → 5 root causes)

1. **The system lies about state** (44 records: status lies, dashboards omitting real data, claims ≠ code,
   orphaned PRs ×2 audits, "done" plans with no tickets). Largest single bucket.
2. **Verification too narrow** (39: UI shipped without being looked at — hover/zoom/ghost-dot bugs
   surviving multiple "fixed" claims; fixes declared without re-running the exact failing path;
   green tests trusted over live behavior).
3. **Handing the wheel back** (10+: "dont ask me, just do it", "no i want u to do it", "never be lazy" —
   permission-seeking between obvious steps, plans offered where execution was expected).
4. **UI built as data-dump, not decisions** (26: "why would the human ever even look here" — panels that
   expose data without justifying a human decision).
5. **Continuity loss** (8: lost Burr/Effect/storage sessions; the StorageBackend seam orphaned
   silently — found only by re-audit). Chat memory is not a ledger.

What demonstrably worked (keep doing): research→plan→implement chains; **adversarial red-teams
pre-code** (cut 2.5/4 gaps before a line was written, killed two bad premises live); **live-driving over
green tests** (caught 3 bugs fakes missed); model-cost-matched delegation; incidents converted into
permanent guards/skills.

## Non-negotiable unit contract

Every dispatched unit — regardless of model or harness — ships against this contract:

- **DONE =** landed on origin/main (or staged PR per landing policy) **+** the exact user-visible path
  driven live (screenshot for UI, command transcript for CLI/daemon) **+** `bun run check` +
  full `bun test` green **+** a regression guard for the specific failure it fixes.
- **Claims are hypotheses.** Plan STATUS, PR "merged", docs, and prior session summaries are verified
  against git/runtime before being repeated (`git cherry origin/main origin/<head>` for landed-ness;
  merge-base ancestor ≠ content landed).
- **UI value rule.** Before building a screen: state the human decision it enables. None → don't build.
  Reference images → extract explicit spatial constraints (pane vs fullscreen, chrome, density) first.
- **After-fix rule.** Re-run the *user's* path that failed — including restart/rebuild/navigation —
  not just the nearest test.
- **Harden, don't patch.** Any incident found twice becomes a deterministic guard (test, gate, script,
  ledger), filed in the same unit.
- **No silent deferrals.** Deliberately-left work is named with a reason; nothing goes to an implicit
  "later" pile.
- **Ledger, not chat.** Orchestration state lives in this directory (`LEDGER.md`), updated at every
  dispatch/land, so any fresh session can resume cold.

## Model routing matrix

| Task class | Model | Mechanics |
|---|---|---|
| Orchestration, adversarial design, ship/kill judgment, premise red-teams | **fable-5** | main session + Agent/Workflow |
| Plan/impl review, UI/UX taste judge, pre-code red teams | **opus-4.8** | Agent `model: opus` |
| Clear-spec implementation with product surface (webapp components, TUI) | **sonnet-5** | Agent `model: sonnet` |
| Bulk/mechanical: migrations (effect-ratchet burn-down), data analysis (receipts/attribution/transcripts), clear-spec backend units, independent 2nd-lens review | **gpt-5.5** | `~/.bun/bin/codex exec -s read-only --skip-git-repo-check` (analysis) or workspace-write in a worktree (impl); thin sonnet wrapper inside Workflows |
| Never | haiku | — |

Escalation is standing policy: judge the output, not the price; redo cheap work with a smarter model
without asking. Reviews of anything shipping: fable/opus, optionally +codex as an independent lineage.

## Lanes (from the repo's real frontier)

- **Lane A — Truth & fleet learning** (attacks root cause #1): research-sirvir 01–06 (recording unlock
  → key coherence → dead-wire fix → cost formula → fleet routing → degradation ladder); re-land the
  orphaned StorageBackend seam (`7528bf0`+`572b4b9` off `worktree-research-omnigent`, needs adaptation);
  harness-scorecard shadow; a permanent **orphan-audit gate** (script + CI/land hook, not a session ritual);
  fix WS dead events, in-process-only `repoLands` lock, dead scheduler backpressure.
- **Lane B — Replace-direct-Claude-Code product gap** (root causes #2/#4): console-agent-tooling (4 open),
  Intervene follow-ons, live-agent truth in the webapp, every panel re-justified by the UI value rule.
  All UI units verified by agent-browser screenshots against a *running* daemon with *real* agents.
- **Lane C — Self-extension frontier**: self-extension-factory 01–06 (Voyager critic-gate, demand queue),
  perspective-diversified-review wiring (03/04/06 + shadow log), factory-control-plane (durable event
  journal, driver-capabilities proof runner, workflow milestones).
- **Lane D — gpt-5.5 mechanical burn-down**: effect-migration legacy conversion (lower ratchet baselines
  same PR), test-suite env-leak wart (`OMP_SQUAD_REPAIR_BUDGET="abc"` noise), receipts/attribution mining
  for the model-outcomes matrix.

Sequencing bias: Lane A first among equals — trust failures poison every other lane's feedback loop
("as a user i dont fully trust the factory because I dont see anything moving automatically yet").

## Decisions (2026-07-07, user-confirmed)

- **Channel: hybrid.** Lane A + D run as direct in-session worktree subagents now; Lanes B/C move to
  glance-daemon dispatch once A's trust fixes land (daemon must run file-mode/root-factory).
- **Landing: staged draft PRs, batch approval.** Every unit opens a gated draft PR off origin/main;
  the orchestrator keeps them conflict-free; the user approves in batches. No auto-merge this wave.
- **Sequencing: Lane A first + Lane D parallel.** B/C start as A lands.

## Orchestrator loop (fable)

1. Read `LEDGER.md`; reconcile against git/PRs/Plane (never trust the ledger itself unverified).
2. Pick the next unit(s) by lane priority + dependency order; **red-team design-heavy units pre-code**
   (opus, 2 independent perspectives) — kill or cut before implementation.
3. Dispatch to the routed model in an isolated worktree; unit prompt embeds: the vision line, the unit
   contract verbatim, the acceptance test, and the scope boundary.
4. Review (opus or codex, cross-lineage when possible) → live-drive proof → land per landing policy.
5. Update `LEDGER.md` + memory; convert any incident into a guard; continue without asking. Summon the
   human only for: merge/publish/spend/delete, genuine preference forks, or `CATASTROPHE:`-grade
   contradictions.
