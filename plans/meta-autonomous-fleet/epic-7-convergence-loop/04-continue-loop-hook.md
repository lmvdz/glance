# Stop-hook driver script

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: scripts/continue-loop.sh (new)

## Goal (what is built)

The `Stop`-hook script that keeps a convergence session cache-warm: it reads the harness's
turn-end JSON on stdin, consults the verified-state oracle file, and either emits a block-and-
continue decision (re-injecting the next-iteration prompt into the *same* session) or exits clean
to let the session stop. Arm-gated, `stop_hook_active`-aware, budget-capped — the exact decision
table in `DESIGN.md §4`.

## Approach (how — cite real file:symbol attach points)

- New `scripts/continue-loop.sh`, `#!/usr/bin/env bash`, `set -euo pipefail`, executable
  (`chmod +x`). Depends on `jq` (already used across `scripts/*.sh`).
- Resolve the state dir INLINE (bash cannot import `src/state-dir.ts`) using the same four-step
  order as `resolveStateDirFrom` (`src/state-dir.ts:41`): `$GLANCE_STATE_DIR` → `$OMP_SQUAD_STATE_DIR`
  → `~/.glance` if it exists → `~/.omp/squad` if it exists → `~/.glance`. Then
  `oracle="$dir/convergence/oracle.json"`, `armed="$dir/convergence/armed"` — mirroring
  `oraclePath`/`armPath` from leaf 01.
- Read stdin JSON into a var; `stop_hook_active=$(jq -r '.stop_hook_active // false' <<<"$input")`.
- Decision table (any early exit is `exit 0` with empty stdout = allow the session to stop):
  1. `stop_hook_active == true` → exit 0 (never re-block a hook-driven turn — the infinite-loop
     guard).
  2. `[[ "${OMP_SQUAD_LOOP_ARMED:-}" != "1" ]]` OR `[[ ! -f "$armed" ]]` → exit 0 (not a
     convergence session — the dual arm gate; a global Stop hook is a no-op here).
  3. `[[ ! -r "$oracle" ]]` → exit 0 (fail safe — never trap a session on a missing/unreadable
     oracle).
  4. Parse `decision`, `gap`, `epsilon`, `pendingEscalation`, `budget.spent`, `budget.cap`,
     `iteration` with `jq`. If `decision != "continue"`, or `gap <= epsilon`, or
     `pendingEscalation == true`, or `budget.spent >= budget.cap` → exit 0.
  5. else print a block decision to stdout and exit 0:
     `jq -cn --arg r "Continue the convergence loop: run the next iteration against $oracle (iteration $iteration, gap $gap). Do not re-read prior context; work from the oracle." '{decision:"block",reason:$r}'`
- Numeric comparisons via `jq` boolean output, not bash arithmetic (gaps may be fractional — use
  `jq -e` e.g. `jq -e '(.gap | tonumber) > (.epsilon | tonumber)'` to avoid bash float breakage).
- Keep it dependency-light and side-effect-free (it only READS the oracle; the TS state machine is
  the sole writer).

## Scope boundary

Do NOT write or mutate the oracle, arm sentinel, or any state file. Do NOT register the hook in
`.claude/settings.json` (leaf 05 does that). Do NOT resolve the state dir by shelling into node/bun
— resolve inline so the hook has zero TS runtime dependency. Do NOT emit anything on stdout except
the single block-decision JSON on the continue path.

## Verify

Drive it with fixture stdin against a temp state dir:
```
export OMP_SQUAD_STATE_DIR=$(mktemp -d); export OMP_SQUAD_LOOP_ARMED=1
mkdir -p "$OMP_SQUAD_STATE_DIR/convergence"; touch "$OMP_SQUAD_STATE_DIR/convergence/armed"
echo '{"goalId":"g","iteration":2,"gap":3,"epsilon":0,"pendingEscalation":false,"budget":{"spent":2,"cap":50},"decision":"continue","updatedAt":0}' > "$OMP_SQUAD_STATE_DIR/convergence/oracle.json"
echo '{"stop_hook_active":false}' | bash scripts/continue-loop.sh   # → prints {"decision":"block",...}
```
Expected observable outcomes:
- Above (armed, gap>ε, budget left) → stdout is `{"decision":"block","reason":"Continue the
  convergence loop..."}`.
- Set oracle `gap` to `0` → stdout empty, exit 0 (converged, session stops).
- Set `pendingEscalation` true → stdout empty (hand to human).
- Set `budget.spent` `>= cap` → stdout empty (hard cap).
- `echo '{"stop_hook_active":true}' | bash scripts/continue-loop.sh` → stdout empty (guard).
- `rm "$OMP_SQUAD_STATE_DIR/convergence/armed"` (or unset `OMP_SQUAD_LOOP_ARMED`) with a
  continue-able oracle → stdout empty (arm gate: an unrelated session is never trapped).
