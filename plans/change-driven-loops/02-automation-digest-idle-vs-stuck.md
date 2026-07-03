# Automation digest: distinguish healthy-idle from stuck

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/insights.ts, webapp/src/lib/insights.test.ts, webapp/src/components (digest caller)
PLANE: OMPSQ-340 — https://app.plane.so/inkwell-finance/browse/OMPSQ-340/

## Goal
The synthesis dashboard can already say "scanned N, spawned 0" but cannot tell a
*healthy-idle* loop (nothing changed, correctly quiet) from a *stuck/dead* one (ticker
died). Teach `automationDigest` that difference using data already on disk — no new
file, no new endpoint.

## Approach
1. **Thread `now` into `automationDigest`** (`webapp/src/lib/insights.ts:326-374`).
   Current signature: `automationDigest(rollup, usage, scoutCap = 30)`. New:
   `automationDigest(rollup, usage, now, scoutCap = 30)`. The server-side `rollup()`
   already carries a per-loop `lastAt` (`src/automation-log.ts:197`) and already takes
   a `now` param — so the data is present; the digest just needs the clock.

2. **Classify per loop** in the anomaly loop (`insights.ts:336-358`). For each rollup
   row, compute `idleMs = now - row.lastAt`. Use the loop's known cadence (Observer/
   Scout/Opportunity 60s, Orchestrator 30s, Dispatch 60s — encode a small
   `LOOP_INTERVAL_MS` map; default 60s) to threshold:
   - `idleMs > STUCK_FACTOR * interval` (default `STUCK_FACTOR = 3`) AND the row has no
     recent skip activity → **stuck**: push an anomaly `"<Loop> last ticked Nm ago —
     may be wedged"`.
   - `idleMs` within threshold and the loop's recent events are skips
     (`row.lastSkipReason` if surfaced, else just "no meaningful work") → **healthy-idle**:
     NOT an anomaly. This is the key change — today a quiet loop is indistinguishable
     from a dead one, so neither is flagged; now the dead one is.
   - Keep the existing "found N spawned 0" and error anomalies unchanged.

3. **Surface the skip reason** where available. Extend the rollup row (server side,
   `automation-log.ts` rollup) to carry `lastSkipReason?: string` (the most recent
   skip event's reason for that loop) so the digest can render *why* a loop is idle
   ("idle: gate inputs unchanged") rather than a bare "idle". Small addition to the
   existing rollup reducer.

4. **Update the one caller** that builds the digest (search `automationDigest(` in
   `webapp/src/`) to pass `Date.now()`. Keep `scoutCap` as the trailing optional arg.

## Cross-Repo Side Effects
Depends on concern 01 (`skipReason` field) being present so `lastSkipReason` can be
populated. The rollup shape gains one optional field — its other consumers ignore it.

## Verify
- `bun run typecheck` (webapp) clean.
- Unit test: a rollup row with `lastAt = now - 10*60_000` and no skips → stuck anomaly
  present; a row with `lastAt = now - 60_000` and `lastSkipReason` set → NO anomaly,
  digest exposes the idle reason.
- Run the daemon, open the dashboard with one loop disabled/wedged → it flags as
  stuck; a quiet-but-live loop shows "healthy-idle: <reason>".
