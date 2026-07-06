# Design — Epic 7 convergence loop

Design decisions the leaves depend on. Every judgment call below is made here so each leaf
carries zero unresolved decisions.

## 1. The oracle file is the process boundary

Two processes must agree on "is the loop done?": the **TS state machine** (writer, runs inside
the driven session's tool calls) and the **bash Stop hook** (reader, runs at turn-end, cannot
import TS). Their only contract is a JSON file on disk. Its location is derived from
`resolveStateDir()` (`src/state-dir.ts:51`) so it lands in the one canonical glance state root
(env `GLANCE_STATE_DIR`/`OMP_SQUAD_STATE_DIR` → `~/.glance` → legacy `~/.omp/squad`). The bash
hook re-implements the *same* four-step resolution inline (it cannot import `state-dir.ts`).

Paths (owned by leaf 01, mirrored by leaf 04):
- Oracle: `<stateDir>/convergence/oracle.json`
- Arm sentinel: `<stateDir>/convergence/armed`

`VerifiedState` schema (leaf 01, exported from `src/types.ts`):

```ts
interface VerifiedState {
  goalId: string;          // meta-goal identifier
  iteration: number;       // 0-based cycle count
  gap: number;             // unmet-criteria count/score from the INDEPENDENT validator; 0 = done
  epsilon: number;         // convergence threshold; continue only while gap > epsilon
  pendingEscalation: boolean; // a low-confidence proposal is waiting on a human → STOP
  budget: { spent: number; cap: number }; // turns (or token-proxy) consumed vs hard cap
  decision: "continue" | "converged" | "escalate" | "budget-exhausted";
  updatedAt: number;       // epoch ms
}
```

Writes are **atomic** (write temp + rename), mirroring `src/automation-log.ts`'s spool
discipline, so the hook never reads a half-written file.

## 2. Injected deps — decouple from Epics 1/3

`src/convergence.ts` follows `OrchestratorDeps` (`src/orchestrator.ts:24`): every external effect
is a function on a `ConvergenceDeps` interface, so the state machine is pure policy and unit-tests
with fakes. This is what lets Epic 7's leaves ship before Epics 1/3 land.

```ts
interface ConvergenceDeps {
  // Epic 1 planner adapter: emit/refresh the frontier against verified state.
  plan: (goalId: string, verified: VerifiedState) => Promise<PlanFrontier>;
  // Epic 2/existing fleet: dispatch the frontier's next unit(s), resolve when they settle.
  dispatch: (frontier: PlanFrontier) => Promise<DispatchOutcome>;
  // Epic 3 validator adapter: score output vs declared acceptanceCriteria → gap + confidence.
  validate: (goalId: string) => Promise<{ gap: number; confidence: number; failures: string[] }>;
  // Leaf 03: no-regression check comparing prior-iteration failures vs current.
  ratchet: (prev: string[], curr: string[]) => { allow: boolean; newRegressions: string[] };
  // Leaf 01: persist the verified-state artifact each cycle.
  writeOracle: (s: VerifiedState) => Promise<void>;
  // Epic 5 confidence exit threshold; below → pendingEscalation=true, STOP as a proposal.
  confidenceFloor: number;
  budgetCap: number;
  epsilon: number;
}
```

The real adapters (leaf 05) are thin: `plan` calls `src/planner.ts` (Epic 1), `validate` calls
`src/validator.ts` (Epic 3). Until those exist, leaf 05 ships a **fixture adapter** over a small
meta-goal so the end-to-end acceptance test runs; the real import is a one-liner swap gated on
Epics 1/3 landing (a clear `throw` names the missing module if invoked without it).

## 3. Contraction, not just iteration

The loop only converges if each step is a contraction — provably closer, never undoing a verified
gain. Three guarantees enforce that:
- **Independent oracle** (`validate` dep, Epic 3): `gap` is the independent validator's diff
  against declared `acceptanceCriteria` (`FeatureCriterion[]`, `src/types.ts:418`) — never STATUS,
  never green self-tests. Looping around a self-grader amplifies lies with a warm cache.
- **Ratchet** (leaf 03): iteration N+1 may not introduce a failure that N did not have. Reuses
  `decideRegressionGate` / `extractGateFailures` (`src/land.ts:219,209`) — the same monotonicity
  logic the post-merge `OMP_SQUAD_REGRESSION_GATE` already uses. A new regression → `escalate`.
- **Confidence exit** (Epic 5): validator confidence below `confidenceFloor` → set
  `pendingEscalation`, emit a proposal (report primitive), STOP. Above `budgetCap` → hard stop.

## 4. Stop-hook contract (leaf 04)

Claude Code fires the `Stop` hook at turn-end with a JSON object on stdin containing
`stop_hook_active` (true when the current turn already resulted from a prior Stop-hook
continuation — the infinite-loop guard). The hook's stdout controls the outcome:
- Emit `{"decision":"block","reason":"<continuation prompt>"}` → the turn does **not** end; the
  reason is injected as the next instruction (this is the auto-continue).
- Exit 0 with empty stdout → allow the session to stop.

Decision table the hook implements:

| Condition | Action |
|---|---|
| `stop_hook_active == true` | exit 0 (never re-block a hook-driven turn — guard) |
| arm sentinel missing OR `OMP_SQUAD_LOOP_ARMED != 1` | exit 0 (not a convergence session — no-op) |
| oracle unreadable / missing | exit 0 (fail safe: never trap a session on a bad file) |
| `decision != "continue"` | exit 0 (state machine already declared terminal) |
| `gap <= epsilon` | exit 0 (converged) |
| `pendingEscalation == true` | exit 0 (hand to human) |
| `budget.spent >= budget.cap` | exit 0 (hard cap) |
| else | `{"decision":"block","reason":"Continue the convergence loop: run the next iteration against <stateDir>/convergence/oracle.json (iteration N, gap G)."}` |

## 5. Arming lifecycle (leaf 05)

The run entrypoint (`src/convergence-run.ts`) `arm()`s the sentinel at loop start and `disarm()`s
it in a `finally` on any terminal decision (`converged` / `escalate` / `budget-exhausted`) or
crash. Dual gate (file + `OMP_SQUAD_LOOP_ARMED`) means a stale sentinel alone cannot immortalize a
session, and the env flag alone cannot either. Two hardening measures make "the env flag alone
cannot immortalize" actually hold under a shared state dir (S1 review fix):

- **The arm flag is `ephemeral`** (`src/runtime-settings.ts`): surfaced/persisted for visibility but
  NEVER written into `process.env` by `applyFeatureFlags` at daemon boot. A persisted-and-applied
  arm flag would leak into every daemon-spawned agent session, eroding the dual gate to a single
  (env-only) gate. Arming happens strictly per-process, in the run entrypoint.
- **The sentinel is identity-stamped.** `arm()` writes the owning session's identity
  (`OMP_SQUAD_LOOP_SESSION` / Claude Code's `CLAUDE_SESSION_ID`) into the sentinel file, and
  `continue-loop.sh` blocks ONLY when the harness's turn-end `session_id` matches it. So even if an
  unrelated concurrent fleet session inherits both gates (a stale env flag + the shared sentinel), a
  mismatched `session_id` makes the hook a no-op for it — it can never be hijacked with the
  convergence prompt. An empty identity degrades to presence-gating (backward compatible), which is
  still safe under the two measures above.

### Single-iteration driver (`--once`, S2)

The Stop hook re-injects "run the next iteration against the oracle," and `convergence-run --once`
is the command that prompt drives: it reads the current oracle, runs EXACTLY ONE `runIteration`
(real `plan` + real `validate` against the tree the live session just modified), rewrites the
oracle, and exits — one process per warm turn. `runToConvergence` stays for `--fixture`/headless
in-process runs. In real mode `dispatch` is a documented no-op (the live session does the work
between turns), so spinning `runToConvergence` in-process would be the wrong production driver.
`--once` (re)stamps the identity sentinel each turn so the next Stop hook stays gated to this
session, and disarms once an iteration reaches a terminal decision; it is idempotent on an
already-terminal oracle (advances nothing, disarms).

## Known limitations (recorded from the Epic 7 review — the explicit next sub-plan)

Leaves 01–05 deliver a bounded, single-session convergence loop that is useful and fully tested,
but two capabilities are deliberately deferred and MUST be the content of the follow-up sub-plan:

1. **The ratchet guarantee is DORMANT** (S3). `src/convergence-ratchet.ts` is wired and unit-tested
   (`ratchet`/`ratchetFromOutput` delegate correctly to `land.ts`'s `decideRegressionGate`), but the
   real `validate` adapter returns `failures: []` in every shipped path, so the ratchet never fires.
   Its input is meant to be an actual verify/test-suite failure set (the same signal the post-merge
   `OMP_SQUAD_REGRESSION_GATE` uses) — a DIFFERENT thing from "acceptance criteria not yet
   satisfied." Feeding the unmet-criteria list instead would misfire the ratchet on iteration 1 of
   any not-yet-done goal (an unmet criterion looks "new" against the empty prior-failures seed),
   escalating every fresh goal before it can iterate. A real per-iteration suite failure-set only
   exists once **real `dispatch`** runs — the deferred warm-loop/real-dispatch scope. Until then the
   no-regression monotonicity guarantee is present in code but inert. Wiring it means: a real
   single-iteration `validate` that runs the suite and returns its failure-set, AND persisting the
   prior-iteration failures across the `--once` process boundary (the oracle schema deliberately
   omits them today, per §1).

2. **Session handoff at context-window pressure** (leaf 06). RESOLVED and shipped — see §6.

## 6. Session handoff (leaf 06 — shipped)

At the context-window ceiling one warm session cannot continue. The DESIGN calls for "long warm
sessions chained by a clean handoff seeded with the verified-state doc." The unresolved decision —
*when* to pay the cold-restart cost and *how* the harness re-launches — is settled: the mechanism is
the **outer `scripts/converge.sh` `while` loop** calling `claude -p "$(…--handoff)"`. Each run is one
warm *segment* (the Stop hook drives `--once` iterations within it); when a segment ends
non-terminally the loop relaunches a fresh session seeded by ONLY the handoff doc. Warm WITHIN a
segment, cold ONLY at the seam — the cost is paid once per segment, not per turn. The watermark is
the harness's own context ceiling (a segment ends when the session can't continue); the persisted
oracle's `decision` — not a token counter — is the source of truth the outer loop gates on, and it
survives the cold seam (leaf 01 contract + the failures sidecar). `handoffDoc`/`seedFromHandoff` on
`src/convergence-oracle.ts` carry the payload; `--handoff`/`--status` on `src/convergence-run.ts`
(over the exported `currentState()`) are the read-only gates; `tests/convergence-handoff.test.ts`
proves the cold-seam round-trip and the terminality gate. Cold-session sufficiency holds because
Epics 1/3 read the oracle + on-disk artifacts, not session memory. See `06-session-handoff.md`.
