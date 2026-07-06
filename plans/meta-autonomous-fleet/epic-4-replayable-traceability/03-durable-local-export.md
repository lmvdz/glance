# Durable-by-default local export + bounded retry
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/trace-exporter.ts, src/squad-manager.ts, tests/trace-exporter.test.ts

## Goal (what is built)
Spans leave the daemon by default: a `LocalFileExporter` appends every exported span batch as NDJSON to
`<stateDir>/traces.jsonl`, and `traceExporterFromEnv` always includes it (unless `OMP_SQUAD_TRACE_LOCAL=0`),
so `traceExporterFromEnv` never returns `undefined` in the default config. `TraceExportQueue.drain`
retries a failed batch up to N times before counting it failed, instead of a silent single-shot drop.
This is DESIGN D4.

## Approach (how)
- `src/trace-exporter.ts` — add `class LocalFileExporter implements Exporter` (near the other exporters,
  ~line 152). Constructor takes an absolute file path. `export(spans, resource)` appends one NDJSON line
  per batch `{ at: Date.now(), resource, spans }` via `fs.appendFile` (import `node:fs/promises`), after
  `fs.mkdir(dirname, { recursive: true })`. No SSRF guard (local file, not a URL). Keep it dependency-free.
- `src/trace-exporter.ts:193 traceExporterFromEnv` — change signature to
  `traceExporterFromEnv(log?, stateDir?)`. After the OTLP/Langfuse/Datadog pushes, if
  `stateDir && process.env.OMP_SQUAD_TRACE_LOCAL !== "0"`, push
  `new LocalFileExporter(path.join(stateDir, "traces.jsonl"))`. Because the local exporter is now
  usually present, the `if (!exporters.length) return undefined` guard rarely fires — that is intended.
- `src/trace-exporter.ts:171 TraceExportQueue.drain` — wrap each `exporter.export(...)` in a bounded retry:
  try up to `RETRY_MAX` (const = 3) attempts with a short `await new Promise(r => setTimeout(r, backoffMs))`
  between attempts (backoff 50ms × attempt); only on final failure increment `stats.failed` and log. The
  overflow-drop in `enqueue` (line 163) stays as the last-resort bound — retry addresses transient
  failures, drop addresses unbounded backlog. Leave `stats` shape as-is plus keep the existing dropped/
  failed/exported counters accurate.
- `src/squad-manager.ts:547` — the call site is
  `this.traceExporter = traceExporterFromEnv((m) => this.log("warn", m));`. Add `this.stateDir` as the
  second arg: `traceExporterFromEnv((m) => this.log("warn", m), this.stateDir)`. Confirm `this.stateDir`
  is initialized before line 547 (it is — it's a constructor field read elsewhere in the class).
- `tests/trace-exporter.test.ts` — add: (a) `LocalFileExporter` writes an NDJSON line to a temp file that
  round-trips back to the input spans; (b) `TraceExportQueue` with an exporter that throws twice then
  succeeds ends with `stats.exported > 0` and `stats.failed === 0` (retry worked); (c)
  `traceExporterFromEnv(undefined, tmpDir)` with no OTLP env returns a defined queue.

## Scope boundary (what NOT to touch)
Do not add rotation/retention to `traces.jsonl` (append-only, matches receipts.jsonl ponytail). Do not
change the receipt/audit persistence (already durable). Do not touch `buildTrace`, sampling, or the UI.
Do not read `traces.jsonl` back anywhere — it is a one-way export sink for external tools, not a second
read path for `manager.trace`.

## Verify (concrete command + expected observable outcome)
`bun test tests/trace-exporter.test.ts` — green, including the retry-recovers and local-sink round-trip
cases. Live smoke: start the daemon with no `OMP_SQUAD_TRACE_EXPORT_*` env set, drive one run to
completion, then `wc -l <stateDir>/traces.jsonl` shows ≥ 1 line whose JSON parses to `{ at, resource, spans }`.
