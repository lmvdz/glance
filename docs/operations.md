# Operations & troubleshooting

## Daemon health under load

`omp-squad up` is a single Bun process: one event loop serving HTTP + WebSocket, the
manager, and every agent's RPC stream. Under heavy fan-out it can stall transiently — which
*looks* like the daemon is down but is not.

**Symptom:** `curl /api/health` intermittently times out / returns nothing (`000`) while the
dashboard otherwise works, and it recovers on its own seconds later.

**Cause:** event-loop saturation, not a crash. Amplifiers, in rough order:

- **auto-supervisor** spawns a fresh `omp` subprocess per gate decision (`src/supervisor.ts`);
  with many agents hitting input gates at once, that is a burst of process spawns + JSON parsing.
- WebSocket broadcast churn — every roster/agent/transcript event fans out to all clients.
- N concurrent agents' RPC event streams parsed on the same loop.

**Confirm stall vs. crash before worrying:**

- `ss -ltnp | grep :7878` — a **stable pid** across probes means the daemon never restarted;
  a changing pid is an actual restart.
- Check the daemon's stdout/stderr. A clean log with **no stack trace** = no crash.

**Mitigations** (only if the stalls actually bite):

- The **WIP cap** (concurrent-agent limit) is the main lever — fewer simultaneous agents means
  fewer simultaneous gate decisions + RPC streams.
- Throttle the auto-supervisor's spawn rate, or turn autonomy off while running a large fan-out.

## Run the daemon so it survives

`omp-squad up` installs `SIGINT`/`SIGTERM` handlers that shut down cleanly (`process.exit(0)`).
**Do not background it inside a short-lived shell** (`omp-squad up &` from an ephemeral
session): it catches `SIGTERM` with the shell's process group and exits cleanly — which reads
like a crash in the log (clean exit, no trace) but is just the signal. Run it detached:

```bash
nohup omp-squad up --no-tui >~/.omp/squad/daemon.log 2>&1 &   # or: setsid, or a systemd unit
```

Rule of thumb: a **clean exit with no trace ≈ a signal**, not a bug; a **stack trace** is a real
crash; a **changed pid with neither** is a restart (manual `⤴ Upgrade`, a re-exec, or a parent
session respawn). One restart over a long session is normal — sustained rapid pid churn is what
to investigate.
