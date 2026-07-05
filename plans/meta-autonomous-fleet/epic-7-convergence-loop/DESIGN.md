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
session, and the env flag alone cannot either. `OMP_SQUAD_LOOP_ARMED` is registered in
`src/runtime-settings.ts` `FEATURE_FLAGS` (default OFF) so it appears in the settings surface.

## 6. Session handoff (leaf 06 — deferred)

At the context-window ceiling one warm session cannot continue. The DESIGN calls for "long warm
sessions chained by a clean handoff seeded with the verified-state doc." This carries a genuine
unresolved decision — spawning a fresh session is inherently cache-*cold*, contradicting the
warm-loop premise, so *when* to pay that cost and *how* the harness re-launches (operator-mediated
vs a `scripts/converge.sh` outer `while` loop calling `claude -p "$(handoffDoc)"`) must be
designed against the real harness. Left as a branch (see `06-session-handoff.md`,
`flaggedNeedsDeeper`). Leaves 01–05 deliver a bounded, single-session convergence loop that is
already useful and fully testable.
