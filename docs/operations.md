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

## Canonical launch — use the launcher + supervisor, not bare `omp-squad up`

Bare `omp-squad up` boots on **defaults** (confirm-mode landing, no reap, default caps) — it does NOT
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

The daemon does **not** hot-reload its own source — after the fleet lands a change to omp-squad itself,
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
   happens elsewhere. It can store `provider` and `externalRef`, but omp-squad never sends money.
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

## Enabling Tremendous reward payouts

**What it does:** When `OMP_SQUAD_TREMENDOUS_API_KEY` is set, `markFeedbackRewardPaid` sends a
real payout via [Tremendous](https://www.tremendous.com) (email delivery; recipient picks gift card,
PayPal, ACH, Visa, etc.) instead of only updating the ledger. Idempotent: each reward maps to one
Tremendous order via `external_id`, so retries never double-pay.

**Go-live checklist:**

1. Create a Tremendous account and obtain an API key.
2. In your Tremendous dashboard, note a funding source id and create a redemption campaign; note its id.
3. Set the following env vars in `up.sh` (start with `sandbox` to test):

   ```sh
   OMP_SQUAD_TREMENDOUS_API_KEY=<key>
   OMP_SQUAD_TREMENDOUS_FUNDING_SOURCE_ID=<funding-source-id>
   OMP_SQUAD_TREMENDOUS_CAMPAIGN_ID=<campaign-id>
   OMP_SQUAD_TREMENDOUS_ENV=sandbox     # change to "production" after confirming
   ```

4. Restart the daemon (`scripts/squadctl.sh restart`).
5. Approve one feedback reward and trigger `mark-paid` via the API or dashboard. Confirm an order
   appears in your Tremendous sandbox dashboard.
6. Once confirmed, change `OMP_SQUAD_TREMENDOUS_ENV=production` and restart.

**Error handling:** a failed payout (network error, bad config, invalid recipient) leaves the reward
in `approved` state and logs the error — it does not crash the daemon. Retry by calling `mark-paid`
again (idempotent). Check `OMP_SQUAD_TREMENDOUS_FUNDING_SOURCE_ID` and `OMP_SQUAD_TREMENDOUS_CAMPAIGN_ID`
are set correctly; missing values surface as a payout failure message, not a startup error.

## Enabling cross-host federation

**What it does:** Connects two or more omp-squad daemons via a WebSocket coordinator so operators
can see each other's agents and file leases in real time, and cross-repo branch collisions are
flagged.

**Go-live checklist:**

1. Pick a host on the tailnet to run the coordinator. On that host:

   ```sh
   export OMP_SQUAD_COORDINATOR_TOKEN=$(openssl rand -hex 32)
   export OMP_SQUAD_COORDINATOR_HOST=0.0.0.0
   export OMP_SQUAD_COORDINATOR_PORT=7900
   bun /path/to/omp-squad/src/coordinator-main.ts
   # → omp-squad coordinator listening on ws://0.0.0.0:7900 (token-gated)
   ```

   For a persistent deployment, wrap in a systemd unit or `scripts/squad-supervisor.sh`.

2. On each operator host, add to `up.sh`:

   ```sh
   export OMP_SQUAD_COORDINATOR=ws://<coordinator-tailnet-ip>:7900
   export OMP_SQUAD_COORDINATOR_TOKEN=<same token>
   export OMP_SQUAD_OPERATOR=<your-username>   # or leave unset to use OS username
   ```

3. Restart each daemon (`scripts/squadctl.sh restart`). The startup log will show:
   `federation: joined ws://… as <operator>`.

4. Open the command center on either host. The **Federation** panel (in the project view) should
   list the peer operator and their agents once both daemons have announced presence.

**Notes:**
- Without Tailscale, WireGuard-level encryption is absent — run the coordinator on loopback
  or within a trusted private network and rely on `OMP_SQUAD_COORDINATOR_TOKEN` for auth.
- Peer identity for inbound commands uses `tailscale whois <peer-ip>` — resolves only on a real
  tailnet. Without it, inbound actors remain `viewer`-tier (read-only).
- DB mode does not auto-start the global federation sync; each org manager handles its own presence.

## Operational knobs: resource gate, Scout cap, trace private

### Resource gate

Enable host-pressure spawn gating by setting `OMP_SQUAD_RESOURCE_GATE` in `up.sh` (the canonical
launcher sets it; bare `omp-squad up` does not):

```sh
OMP_SQUAD_RESOURCE_GATE=1                # enable admission gating
OMP_SQUAD_MAX_LOAD_PER_CPU=1.5           # block when load1/ncpu exceeds this (default 1.5)
OMP_SQUAD_MIN_FREE_RATIO=0.1             # block when free-memory fraction < this (default 0.1)
OMP_SQUAD_MAX_RSS_MB=1024                # kill an agent process if its RSS exceeds this MB (default 1024)
```

Both `OMP_SQUAD_MAX_LOAD_PER_CPU` and `OMP_SQUAD_MIN_FREE_RATIO` are re-read on every admission
check, so you can tighten thresholds by editing `up.sh` and restarting without redeploying.

### Scout LLM-call cap

The Scout backlog harvester makes one LLM call per scan. In a busy multi-agent fleet this can add
up. Cap it:

```sh
OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR=30   # default; set 0 for unlimited
```

Monitor current usage via `omp-squad automation` or `GET /api/automation` — the response includes
the Scout's call count for the trailing window.

### Trace export to a private/loopback collector

Trace collector URLs from `OMP_SQUAD_TRACE_EXPORT_*_URL` env vars (OTLP, Langfuse, Datadog)
commonly point to `localhost` or an RFC1918 address (a local OTLP agent, a private Langfuse
instance, a tailnet Datadog gateway). The shared SSRF guard blocks these by default.

To allow it, set `OMP_SQUAD_TRACE_ALLOW_PRIVATE=1`. This exempts **only** the exact origins of
the collector URLs you configured — not arbitrary private IPs. Any redirect, metadata IP, or
unconfigured URL is still blocked.

```sh
OMP_SQUAD_TRACE_ALLOW_PRIVATE=1
OMP_SQUAD_TRACE_EXPORT_OTLP_URL=http://localhost:4318/v1/traces
```
