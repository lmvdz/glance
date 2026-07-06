#!/usr/bin/env bash
# Epic 7 (convergence loop), leaf 06 — the OUTER session-handoff loop that chains warm convergence
# segments across the context-window seam.
#
# The warm loop (leaves 01-05) keeps ONE session alive so the prompt cache stays warm, but a single
# session eventually hits the context-window ceiling and can't continue. This outer `while` loop is
# the resolved re-launch mechanism: each `claude -p "$(…--handoff)"` invocation is ONE warm segment
# whose in-session Stop hook (continue-loop.sh) drives many `--once` iterations; when a segment ends
# non-terminally (context pressure ended the session, not the goal), we relaunch a FRESH session
# seeded by ONLY the handoff doc. The on-disk oracle + failures sidecar (src/convergence-oracle.ts)
# persist across the cold seam, so no verified gain is lost and the no-regression ratchet still holds.
# The loop stops the moment the oracle reaches a terminal decision.
#
# Warm WITHIN a segment (Stop hook), cold ONLY at the seam (this loop) — the reconciliation the parent
# DESIGN flagged as the open question. Cost of the cold restart is paid once per segment, not per turn.
#
# Read-only orchestrator: it never writes the oracle/sentinel itself — it shells out to
# `convergence-run.ts --status` (gate on terminality) and `--handoff` (seed the next segment), both
# of which are read-only, and to `claude -p` (the warm segment). src/convergence-run.ts owns all state.
#
# Usage:  scripts/converge.sh <goalId> [extra convergence-run flags, e.g. --fixture]
#   OMP_SQUAD_CONVERGE_MAX_SEGMENTS  hard cap on cold restarts (default 50) — a backstop, not the exit.
set -euo pipefail

GOAL="${1:?usage: scripts/converge.sh <goalId> [--fixture ...]}"
shift || true
EXTRA=("$@")
MAX_SEGMENTS="${OMP_SQUAD_CONVERGE_MAX_SEGMENTS:-50}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run() { bun "$REPO/src/convergence-run.ts" --goal "$GOAL" "${EXTRA[@]}" "$@"; }

for ((seg = 1; seg <= MAX_SEGMENTS; seg++)); do
	decision="$(run --status 2>/dev/null || echo error)"
	case "$decision" in
		converged | escalate | budget-exhausted)
			echo "converge: terminal ($decision) after $((seg - 1)) warm segment(s)"
			exit 0
			;;
		continue) : ;;
		*)
			echo "converge: cannot read a valid oracle decision ('$decision') — aborting" >&2
			exit 1
			;;
	esac

	doc="$(run --handoff 2>/dev/null)" || {
		echo "converge: failed to build the handoff doc — aborting" >&2
		exit 1
	}
	echo "converge: warm segment $seg (resuming from decision=$decision)"
	# One warm segment: the Stop hook drives `--once` iterations within this session until it ends
	# (terminal oracle → clean stop, or context ceiling → session ends and we relaunch). Never let a
	# non-zero segment exit kill the chain — the next `--status` check decides whether to continue.
	claude -p "$doc" || true
done

echo "converge: reached MAX_SEGMENTS=$MAX_SEGMENTS without a terminal decision" >&2
exit 1
