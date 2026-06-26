#!/usr/bin/env bash
# squadctl — start / stop / restart / status for the omp-squad daemon.
#
# The daemon MUST launch through up.sh (it exports all the autonomy / Plane /
# webapp env, then exec's `omp-squad up`), optionally under squad-supervisor.sh
# for crash-restart. This wraps both so you never hand-roll pkill again.
#
#   scripts/squadctl.sh start     # launch supervisor -> up.sh -> daemon (detached, crash-restarting)
#   scripts/squadctl.sh stop      # stop supervisor + daemon (SIGTERM, then SIGKILL after 10s)
#   scripts/squadctl.sh restart   # stop, then start
#   scripts/squadctl.sh status    # is it up? pid / supervisor / HTTP probe / launcher
#
# Env overrides (match up.sh / squad-supervisor.sh):
#   OMP_SQUAD_STATE_DIR  state dir holding the lock + launcher (default ~/.omp/squad)
#   OMP_SQUAD_LAUNCHER   launcher script           (default $STATE_DIR/up.sh)
#   OMP_SQUAD_PORT       dashboard port            (default 7878)
set -uo pipefail

STATE_DIR="${OMP_SQUAD_STATE_DIR:-$HOME/.omp/squad}"
LAUNCHER="${OMP_SQUAD_LAUNCHER:-$STATE_DIR/up.sh}"
PORT="${OMP_SQUAD_PORT:-7878}"
LOCK="$STATE_DIR/daemon.lock"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR="$SCRIPT_DIR/squad-supervisor.sh"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

launcher_enables_webapp() {
	[ "${OMP_SQUAD_WEBAPP:-}" = "1" ] && return 0
	[ -f "$LAUNCHER" ] || return 1
	local line
	while IFS= read -r line; do
		[ "$line" = "export OMP_SQUAD_WEBAPP=1" ] && return 0
	done < "$LAUNCHER"
	return 1
}

build_webapp_if_enabled() {
	launcher_enables_webapp || return 0
	[ "${OMP_SQUAD_SKIP_WEBAPP_BUILD:-}" = "1" ] && { echo "skipping webapp build (OMP_SQUAD_SKIP_WEBAPP_BUILD=1)"; return 0; }
	[ -f "$REPO_DIR/webapp/package.json" ] || return 0
	echo "building webapp/dist for OMP_SQUAD_WEBAPP=1"
	( cd "$REPO_DIR/webapp" && bun run build )
}

# Parse the daemon pid out of the JSON lock record written by acquireStateLock
# (state-lock.ts). The record's first field is "pid"; "ppid" never matches the
# regex because the leading quote rules out the extra 'p'. Empty if no lock.
# ponytail: sed over a json dep — the field is a bare integer, not nested.
parse_pid() {
	[ -f "$1" ] || return 1
	sed -nE 's/.*"pid"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$1" | head -1
}

# Echo the live daemon pid (lock pid that is still running), or fail.
daemon_pid() {
	local pid
	pid="$(parse_pid "$LOCK")" || return 1
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; return 0; }
	return 1   # no lock, or stale lock (owner gone)
}

supervisor_pids() { pgrep -f 'squad-supervisor\.sh' 2>/dev/null; }

http_code() { curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null; }

cmd_status() {
	local pid sp code
	if pid="$(daemon_pid)"; then echo "daemon:     UP (pid $pid)"; else echo "daemon:     DOWN"; fi
	sp="$(supervisor_pids | tr '\n' ' ')"; sp="${sp% }"
	[ -n "$sp" ] && echo "supervisor: running (pid $sp)" || echo "supervisor: not running"
	code="$(http_code)"
	echo "http:       http://127.0.0.1:$PORT/ -> ${code:-(no response)}"
	echo "launcher:   $LAUNCHER"
}

cmd_start() {
	local pid
	if pid="$(daemon_pid)"; then echo "already up (pid $pid); use 'restart' to cycle." >&2; return 0; fi
	[ -f "$LAUNCHER" ] || { echo "launcher not found: $LAUNCHER" >&2; return 1; }
	[ -f "$SUPERVISOR" ] || { echo "supervisor not found: $SUPERVISOR" >&2; return 1; }
	build_webapp_if_enabled
	echo "starting: supervisor -> $LAUNCHER"
	OMP_SQUAD_LAUNCHER="$LAUNCHER" setsid bash "$SUPERVISOR" >/dev/null 2>&1 &
	# Wait (up to ~15s) for the daemon to acquire the lock.
	local i
	for ((i = 0; i < 30; i++)); do
		sleep 0.5
		if pid="$(daemon_pid)"; then echo "up (pid $pid) on port $PORT"; return 0; fi
	done
	echo "supervisor launched but daemon didn't acquire the lock in 15s; see $STATE_DIR/daemon.log" >&2
	return 1
}

cmd_stop() {
	local sp pid i
	# Kill the supervisor FIRST so it can't relaunch the daemon we're about to stop.
	sp="$(supervisor_pids)"
	if [ -n "$sp" ]; then echo "stopping supervisor (pid $(echo "$sp" | tr '\n' ' '))"; kill $sp 2>/dev/null; fi
	if pid="$(daemon_pid)"; then
		echo "stopping daemon (pid $pid, SIGTERM)"
		kill -TERM "$pid" 2>/dev/null
		for ((i = 0; i < 20; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
		if kill -0 "$pid" 2>/dev/null; then echo "still alive after 10s -> SIGKILL"; kill -KILL "$pid" 2>/dev/null; fi
		echo "stopped."
	else
		echo "daemon not running."
	fi
}

cmd_restart() { cmd_stop; sleep 1; cmd_start; }

case "${1:-}" in
	start)   cmd_start ;;
	stop)    cmd_stop ;;
	restart) cmd_restart ;;
	status)  cmd_status ;;
	_pidof)  daemon_pid || true ;;            # internal: test hook (lock-pid + liveness, no daemon control)
	*) echo "usage: ${0##*/} {start|stop|restart|status}" >&2; exit 2 ;;
esac
