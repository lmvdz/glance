---
name: bounce
description: Restart the glance daemon and PROVE the new code is actually serving — kill order, PATH, health probe, served-bundle marker, env-loaded checks — plus the "I don't see the change" staleness triage tree. Use when the user says "restart the daemon", "pick up the new code", "i restarted", or reports a shipped fix that looks unchanged.
---

# bounce — restart the daemon and prove it

Mined verdict: the restart-then-verify dance is the single most re-derived ritual in this repo's history (≥6 sessions, 4 memory notes). Backend changes are invisible until restart; the restart itself has traps; and pre-restart daemons keep emitting removed tracks/stale adapters, producing phantom bugs.

## Restart sequence

1. **Roster check** — don't bounce a fleet with working agents. `glance list` (or loopback `GET /api/agents`); wait or ask if units are mid-run.
2. **Know what the daemon executes.** It runs the GLOBAL install: `readlink -f $(which omp-squad || which glance)`. If the fix is only in a local checkout, it is NOT live until `omp update` (or the symlink points at this repo). This mistake alone caused three "fix didn't work" rounds.
3. **Kill the supervisor FIRST** (`squad-supervisor.sh` respawns the daemon), then the daemon. Use a pgrep pattern that can't match your own shell, and prefer kill-by-port over pkill-by-name (a pkill once killed the session's own shell; another aborted a compound chain with exit 144).
4. **Relaunch with `~/.bun/bin` on PATH** — squadctl restart crash-loops with `exec: omp-squad: not found` without it. Capture/restore the launch env (`plane.env` etc. only load at startup).
5. **Verify, don't assume:**
   - port bound + `GET /api/health` (or `/api/auth/mode`) 200
   - served bundle contains a marker string from the new code (`curl` the asset; check dist mtime)
   - env actually loaded (e.g. Plane wired ⇒ tickets endpoint non-null)
   - note: restart resets the in-memory dispatch dedup — reopened issues will re-dispatch; that's often the point, but say so.

## "I don't see the change" triage (in this order — each layer cost a real debugging round)

1. Does the **built dist** contain the change? (marker grep in `webapp/dist`, mtime — dist is gitignored, merges don't rebuild it)
2. Is the daemon serving **this repo's dist**? (global-symlink check above; main checkout parked on an old branch has served stale UI)
3. `Cache-Control` on index.html — browsers cache-pin the shell (fixed on main, but verify on older deploys)
4. Service worker pinning the old bundle → fresh browser session/profile
5. Stale client state — a file-mode `ompsq_token` in localStorage poisons db-mode `/api/me`
6. Only THEN suspect the code.

## Gotchas

- Detached long-running processes: separate `export` lines + plain `nohup … &` — `run_in_background` SIGTERMs the child when the tool call ends, and compound `cd X && nohup …` chains break on the first non-zero step.
- A stale daemon that survived a failed kill keeps emitting removed event tracks — if the UI shows data the code can't produce anymore, the old process is still alive.
- Docker-based gates run containers that may leave root-owned files (fixed via `--user` on main); if a build hits EACCES on `webapp/dist`, clean with a root alpine container.
