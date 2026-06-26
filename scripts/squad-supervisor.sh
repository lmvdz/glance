#!/usr/bin/env bash
# Crash-restart supervisor for the omp-squad daemon.
#
# Runs the configured launcher (up.sh, which sets all the autonomy/resource env then exec's the
# daemon) and relaunches it on ANY exit — crash, OOM, or clean signal — with exponential backoff
# capped at 60s. The single-writer state lock makes a stray relaunch-while-already-up fail fast and
# back off, so this never produces two daemons. Launch THIS (detached) instead of the daemon directly:
#
#   setsid bash scripts/squad-supervisor.sh >/dev/null 2>&1 &
#
# Override the launcher / log with OMP_SQUAD_LAUNCHER and OMP_SQUAD_DAEMON_LOG.
set -uo pipefail

LAUNCHER="${OMP_SQUAD_LAUNCHER:-$HOME/.omp/squad/up.sh}"
LOG="${OMP_SQUAD_DAEMON_LOG:-$HOME/.omp/squad/daemon.log}"

# Force git signing off for the launcher, daemon, and every child it spawns.
GIT_CONFIG_COUNT="${GIT_CONFIG_COUNT:-0}"
case "$GIT_CONFIG_COUNT" in
	*[!0-9]*) GIT_CONFIG_COUNT=0 ;;
esac
base="$GIT_CONFIG_COUNT"
export "GIT_CONFIG_KEY_$base=commit.gpgsign" "GIT_CONFIG_VALUE_$base=false"
base=$((base + 1))
export "GIT_CONFIG_KEY_$base=tag.gpgsign" "GIT_CONFIG_VALUE_$base=false"
export GIT_CONFIG_COUNT=$((base + 1))

if [ ! -f "$LAUNCHER" ]; then
	echo "[supervisor] launcher not found: $LAUNCHER" >&2
	exit 1
fi

backoff=2
while true; do
	echo "[supervisor] launching $LAUNCHER at $(date -Is)" >>"$LOG"
	bash "$LAUNCHER" >>"$LOG" 2>&1
	code=$?
	echo "[supervisor] daemon exited (code=$code) at $(date -Is); next attempt in ${backoff}s" >>"$LOG"
	sleep "$backoff"
	# exponential backoff, capped — a clean exit resets to fast, a crash-loop slows down.
	if [ "$code" -eq 0 ]; then backoff=2; elif [ "$backoff" -lt 30 ]; then backoff=$((backoff * 2)); else backoff=60; fi
done
