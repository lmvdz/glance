# Operations & troubleshooting

## Daemon health under load

`glance up` is a single Bun process: one event loop serving HTTP + WebSocket, the
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

`glance up` installs `SIGINT`/`SIGTERM` handlers that shut down cleanly (`process.exit(0)`).
**Do not background it inside a short-lived shell** (`glance up &` from an ephemeral
session): it catches `SIGTERM` with the shell's process group and exits cleanly — which reads
like a crash in the log (clean exit, no trace) but is just the signal. Run it detached:

```bash
nohup glance up --no-tui >~/.omp/squad/daemon.log 2>&1 &   # or: setsid, or a systemd unit
```

Rule of thumb: a **clean exit with no trace ≈ a signal**, not a bug; a **stack trace** is a real
crash; a **changed pid with neither** is a restart (manual `⤴ Upgrade`, a re-exec, or a parent
session respawn). One restart over a long session is normal — sustained rapid pid churn is what
to investigate.

## Canonical launch — use the launcher + supervisor, not bare `glance up`

Bare `glance up` boots on **defaults** (confirm-mode landing, no reap, default caps) — it does NOT
read the autonomy/resource env. The configured launcher is **`~/.omp/squad/up.sh`** (sets Plane wiring,
`OBSERVE_AUTOFIX`, `LAND_CONFIRM=0`, `MAX_WIP`/`MAX_AGENTS`, etc., then `exec`s the daemon). Run it under
the crash-restart supervisor so it survives crashes/OOM and a clean exit:

```bash
setsid bash scripts/squad-supervisor.sh >/dev/null 2>&1 &   # supervises ~/.omp/squad/up.sh
ss -ltnp | grep :7878                                        # confirm one daemon, stable pid
```

### squadctl — start / stop / restart / status

`scripts/squadctl.sh` wraps the launcher + supervisor so you never hand-roll `pkill`:

```bash
scripts/squadctl.sh start     # supervisor -> up.sh -> daemon (detached, crash-restarting)
scripts/squadctl.sh status    # daemon pid (from the state lock) + supervisor + HTTP probe
scripts/squadctl.sh restart   # stop, then start — the way to pick up self-landed code (below)
scripts/squadctl.sh stop      # stop supervisor FIRST (so it can't relaunch), then the daemon
```

`stop` kills the supervisor before the daemon so the watchdog can't immediately respawn it, then
`SIGTERM`s the daemon (clean shutdown releases the state lock) and escalates to `SIGKILL` after 10s.
`status`/`stop` resolve the daemon pid from `~/.omp/squad/daemon.lock`, so a stale lock (owner gone)
reads as DOWN. Override `OMP_SQUAD_STATE_DIR` / `OMP_SQUAD_LAUNCHER` / `OMP_SQUAD_PORT` for a
non-default daemon.

For **planning** (vs. the agent/inbox monitor views), use the **project view**: the sidebar drills
into each repo → its features → their tasks (description / acceptance criteria / context / properties),
served behind `OMP_SQUAD_WEBAPP=1` like the rest of the SPA.

**On-boot OOM guard.** A relaunch re-adopts orphaned worktrees, but only those with *unlanded work*,
capped at `OMP_SQUAD_MAX_AGENTS` (`adoptOrphanedAgents` / `selectAdoptable`). Before that cap, every
orphaned worktree was re-spawned at once — N simultaneous `omp` hosts that could exhaust memory and
take the box (WSL) down. Done/clean agents are dropped on boot; their still-open issues are picked up
again gradually under the WIP cap.

The daemon does **not** hot-reload its own source — after the fleet lands a change to glance itself,
relaunch (`scripts/squadctl.sh restart`, or re-run `up.sh`) to pick it up. (Auto-reload-on-self-landed-code
is tracked in OMPSQ-130.)

## Feedback Loop operations

Public intake is off unless `OMP_SQUAD_FEEDBACK=1`. Keep it off for daemons that are not meant to
receive user reports from product pages. When enabled, `/feedback/widget.js` is public and
`/api/feedback/items` accepts public POSTs; operator review APIs stay behind the normal dashboard auth.
Campaigns, items, validations, and reward records are durable; public screenshots are written as files
under the daemon state dir.

### Campaign setup

Create one campaign per product/site/repo with `POST /api/feedback/campaigns`:

- `name`, `repo`, and a long random `token` are required.
- `allowedOrigins` should be exact HTTPS origins (`https://app.example.com`), not `*`, except for
  local testing. Submissions whose browser `Origin` is not on the campaign are rejected.
- `rewardCents` / `rewardCurrency` only create a reward ledger entry; they do not trigger payout.

Embed the campaign on the product page:

```html
<script
  src="https://squad.example.com/feedback/widget.js"
  data-campaign="fc_..."
  data-token="long-random-token">
</script>
```

The raw campaign token is necessarily visible to that page's browser. Treat it as a scoped intake
secret: do not commit it to reusable docs/examples, do not reuse it across campaigns, keep
`allowedOrigins` tight, and replace the campaign if the token leaks outside the intended site.

The public widget submits only `POST /api/feedback/items`. All other feedback endpoints are operator
surface: list/create campaigns, list/read items, `accept`, `reject`, `promote`, validation, and reward
state changes.

### Review flow

1. Read the queue with `GET /api/feedback/items`; inspect screenshots before trusting a report.
2. Add validation responses when a report needs more signal (`POST /api/feedback/items/:id/validation`).
3. `accept` real work, `reject` noise/spam, then `promote` accepted or needs-validation items to Plane.
   Promotion creates and links one Plane issue; rejected items cannot be promoted.
4. For reward campaigns, use the reward endpoints as an audit ledger: `pending` can become `approved`
   or `void`; `approved` can become `paid` or `void`. Call `mark-paid` only after the human payout
   happens elsewhere. It can store `provider` and `externalRef`, but glance never sends money.
   Reconcile `paid` entries against the external payout system periodically; the ledger is the audit
   trail, not the payment rail.

### Safety limits

- Serve off-box widgets over HTTPS only; reports can include email, URL, browser metadata, and screenshots.
- Put internet-facing daemons behind a trusted reverse proxy/tunnel that terminates TLS and preserves
  the real client IP for rate limiting; do not expose a raw `0.0.0.0` listener directly to the internet.
- Screenshots often contain PII/secrets. Review before promotion; Plane issue bodies include screenshot
  metadata/path, so keep Plane access scoped to the team that may see it.
- Public intake has an in-process per-campaign/IP rate limit
  (`OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN`, default `30`; restart resets it). Keep another edge limit in
  front for internet-facing daemons.
- Screenshot uploads are capped by `OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES` (default `2000000`); title
  (160 chars), description (5000), validation notes (1000), and metadata (20 fields) are clamped.
  Only one PNG/JPEG screenshot is accepted.
- File-mode attachments are written under `<stateDir>/feedback/attachments/...`; DB mode stores the
  records in DB tables but file attachments still consume daemon disk. Monitor/prune disk on long-running
  or high-volume campaigns.
