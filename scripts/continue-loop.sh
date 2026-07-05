#!/usr/bin/env bash
# Epic 7 (convergence loop), leaf 04 — the Claude Code `Stop`-hook driver that keeps a convergence
# session cache-warm: reads the harness's turn-end JSON on stdin, consults the verified-state
# oracle file, and either emits a block-and-continue decision (re-injecting the next-iteration
# prompt into the SAME session) or exits clean to let the session stop.
#
# SAFETY (non-negotiable, see plans/meta-autonomous-fleet/epic-7-convergence-loop/DESIGN.md §4/§5):
# this script is a STRICT NO-OP (exit 0, empty stdout) unless the session is explicitly armed via
# BOTH the sentinel file AND OMP_SQUAD_LOOP_ARMED=1, AND — when the sentinel carries a session
# identity — the harness's turn-end `session_id` MATCHES that identity. A global Stop hook that
# auto-continues would make EVERY Claude Code session immortal, and a shared env flag + sentinel
# must not let it hijack an UNRELATED session — every early-exit path below defends against that.
#
# Read-only: this script never writes the oracle or the arm sentinel — src/convergence-oracle.ts
# (leaf 01) is the sole writer; src/convergence-run.ts (leaf 05) owns arm()/disarm() lifecycle.
#
# State-dir resolution is INLINED (bash cannot import src/state-dir.ts) using the same four-step
# order as resolveStateDirFrom (src/state-dir.ts:41), mirroring scripts/squad-supervisor.sh's own
# inline mirror: env → existing ~/.glance → existing legacy ~/.omp/squad → ~/.glance.
set -euo pipefail

default_state_dir() {
	if [ -d "$HOME/.glance" ]; then echo "$HOME/.glance"
	elif [ -d "$HOME/.omp/squad" ]; then echo "$HOME/.omp/squad"
	else echo "$HOME/.glance"; fi
}
STATE_DIR="${GLANCE_STATE_DIR:-${OMP_SQUAD_STATE_DIR:-$(default_state_dir)}}"

oracle="$STATE_DIR/convergence/oracle.json"
armed="$STATE_DIR/convergence/armed"

input="$(cat)"

# 1. Infinite-loop guard: never re-block a turn that ITSELF resulted from a prior Stop-hook
#    continuation. Without this, a bug anywhere below could wedge a session forever. FAIL CLOSED
#    (M1): empty OR unparseable stdin is treated as stop_hook_active=true (exit 0, no block) — an
#    armed session must never re-block on garbage input, only on a well-formed turn-end that
#    explicitly says stop_hook_active=false.
if [ -z "$input" ] || ! stop_hook_active="$(jq -r '.stop_hook_active // false' <<<"$input" 2>/dev/null)"; then
	exit 0
fi
if [ "$stop_hook_active" = "true" ]; then
	exit 0
fi

# 2. Dual arm gate: BOTH the sentinel file and the env flag must be present. A global Stop hook
#    with either gate missing is a no-op — this is what makes it safe to register project-wide.
if [ "${OMP_SQUAD_LOOP_ARMED:-}" != "1" ] || [ ! -f "$armed" ]; then
	exit 0
fi

# 2b. Identity gate (S1): the sentinel content is the OWNING convergence session's identity. When it
#     is non-empty and the harness handed us a session_id, they MUST match — otherwise this is an
#     unrelated session that merely shares the state dir + a leaked env flag, and re-blocking it
#     would hijack it with the convergence prompt. An empty sentinel (no stamped identity) degrades
#     to presence-gating (safe under the project-scoped hook + non-persisted env flag).
sentinel_id="$(cat "$armed" 2>/dev/null || true)"
session_id="$(jq -r '.session_id // ""' <<<"$input" 2>/dev/null || true)"
if [ -n "$sentinel_id" ] && [ -n "$session_id" ] && [ "$sentinel_id" != "$session_id" ]; then
	exit 0
fi

# 3. Fail-safe: never trap a session on a missing/unreadable oracle.
if [ ! -r "$oracle" ]; then
	exit 0
fi

oracle_json="$(cat "$oracle" 2>/dev/null || echo '{}')"
if ! jq -e . >/dev/null 2>&1 <<<"$oracle_json"; then
	exit 0
fi

decision="$(jq -r '.decision // "continue"' <<<"$oracle_json")"
pending_escalation="$(jq -r '.pendingEscalation // false' <<<"$oracle_json")"
iteration="$(jq -r '.iteration // 0' <<<"$oracle_json")"
gap="$(jq -r '.gap // 0' <<<"$oracle_json")"

# 4. The state machine already declared a terminal outcome — nothing to continue.
if [ "$decision" != "continue" ]; then
	exit 0
fi

# 5. Converged: gap has closed to (or below) epsilon.
if jq -e '(.gap // 0 | tonumber) <= (.epsilon // 0 | tonumber)' >/dev/null 2>&1 <<<"$oracle_json"; then
	exit 0
fi

# 6. A low-confidence proposal is waiting on a human — hand off, never grind.
if [ "$pending_escalation" = "true" ]; then
	exit 0
fi

# 7. Hard budget cap.
if jq -e '(.budget.spent // 0 | tonumber) >= (.budget.cap // 0 | tonumber)' >/dev/null 2>&1 <<<"$oracle_json"; then
	exit 0
fi

# Every gate cleared: continue the loop by blocking turn-end with the next-iteration instruction.
jq -cn --arg r "Continue the convergence loop: run the next iteration against $oracle (iteration $iteration, gap $gap). Do not re-read prior context; work from the oracle." '{decision:"block",reason:$r}'
