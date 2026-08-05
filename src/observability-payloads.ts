/**
 * Observability payload builders (plans/deepen-modules/05, final slice) — the ~650 lines of
 * fleet-wide GET payload assembly that used to trail server.ts as module-level functions:
 * the per-manager trace cache, the *Across aggregators (receipts/fabric/audit/automation/
 * learning-loop), usage/heat/activity rollups, the /api/graph cluster (config, repo allowlist,
 * graph/commit/attribution/scoreboard/provenance, unified-diff parsing), aggregate health,
 * governance, and the action-items feed.
 *
 * These are the OBSERVABILITY LANE'S data layer: every function is pure over
 * `(managers, url/query, actor/role)` — no server-instance state — which is exactly why they
 * could move without a context type. server.ts's handleObservability stays the dispatch site;
 * it imports these builders like any other lane module. Incident-bought invariants moved with
 * their functions (per-manager WeakMap trace-cache isolation, persisted-ledger-not-live-roster
 * sourcing, the bootstrap-admin "must not lie by omission" union rule).
 */
import * as path from "node:path";
import { readAudit, type AuditQuery } from "./audit.ts";
import { buildScoreboard, type Scoreboard } from "./attribution-scoreboard.ts";
import type { AutomationEvent, AutomationLoop, AutomationQuery, AutomationRollupRow } from "./automation-log.ts";
import type { ComplianceFinding } from "./compliance.ts";
import { envInt } from "./config.ts";
import { ingestHarnesses } from "./ingest/index.ts";
import type { FabricSnapshot } from "./memory/index.ts";
import { learningFlags, type MetricName, type MetricRollupRow } from "./metrics.ts";
import { readModelOutcomes } from "./model-outcomes.ts";
import { buildAttribution, planFromEnv } from "./omp-graph/attribution.ts";
import { buildGraph, type GraphDoc } from "./omp-graph/index.ts";
import { buildProvenance, type ProvenanceDoc } from "./omp-graph/provenance.ts";
import { buildTaskClassMatrix, type TaskClassMatrixDoc } from "./omp-graph/task-class-matrix.ts";
import { normalizeRepoPath } from "./project-registry.ts";
import { readAllReceipts } from "./receipts.ts";
import { boundedNumber } from "./routes/table.ts";
import { liveAgents as liveAgentCount } from "./scheduler.ts";
import type { TraceResponse } from "./spans.ts";
import { hardAgentCeiling } from "./spawn-identity.ts";
import type { SquadManager } from "./squad-manager.ts";
import { resolveStateDir } from "./state-dir.ts";
import { readTaskOutcomes } from "./task-outcomes.ts";
import type { Actor, AuditEntry, Role, RunReceipt } from "./types.ts";
import { assessHealth, defaultHealthLimits, type HealthSample } from "./watchdog.ts";

/**
 * Per-runId trace cache: `manager.trace()` scans EVERY receipt on disk (`readAllReceipts`), which is
 * fine for an occasional click but not for one wired raw behind a fast poll. A finalized run's trace
 * never changes, so once every receipt in its tree has `endedAt` set, the response is cached; a run
 * still in flight (any receipt missing `endedAt`) is recomputed every call — that scan is cheap (one
 * active run's worth of receipts), so correctness costs nothing there.
 *
 * Scoped PER MANAGER (topology review finding 1): a bare module-level `Map<traceId, …>` would be
 * shared across every `SquadManager` instance in the process — in DB-registry mode each org gets its
 * own manager, so a shared cache would serve org A's cached receipts/costs/spans to org B on a
 * colliding trace id (and the root-factory manager would leak into every org, and vice versa). Keying
 * by the manager INSTANCE (a `WeakMap`) makes that structurally impossible — manager A's entries live
 * in manager A's Map, full stop — and needs no explicit org/manager-id plumbing since the same
 * long-lived manager instance already IS the isolation boundary (ManagerRegistry, ManagerRegistry.md).
 *
 * No receipt-count invalidation: `readAllReceipts` always does a full directory scan regardless of
 * `id`, so a cheap "has this trace grown?" check doesn't exist — computing it costs the same as
 * recomputing the trace outright. Instead of trusting the TTL alone (finding 2: a re-dispatched
 * feature's new run could otherwise stay invisible under a stale-but-unexpired `feat:<id>` cache hit
 * for up to `TRACE_CACHE_TTL_MS`), a hit is cheaply re-validated against the manager's live in-memory
 * roster (`manager.list()` — no disk I/O): if any roster entry shares the cached feature id and started
 * AFTER the entry was cached, a new run has begun under that feature and the hit is treated as a miss.
 *
 * Bounded two ways so distinct, never-repeated trace ids (a click-through of many one-off runs)
 * can't grow a manager's cache forever: `sweepExpiredTraceCache` runs on every insert (the map is
 * small — O(cache size), cheap next to the trace scan that just ran) evicting every TTL-expired entry,
 * not just the requested id; and `TRACE_CACHE_MAX` FIFO-evicts the oldest-inserted entry (Map iteration
 * order = insertion order) once the sweep still leaves that manager's cache at capacity.
 */
type TraceCache = Map<string, { at: number; response: TraceResponse }>;
const traceCachesByManager = new WeakMap<SquadManager, TraceCache>();
export const TRACE_CACHE_TTL_MS = 30_000;
export const TRACE_CACHE_MAX = 200;

/** The manager-scoped cache Map, lazily created. Exported (only) for test setup/inspection. */
export function traceCacheFor(manager: SquadManager): TraceCache {
	let cache = traceCachesByManager.get(manager);
	if (!cache) {
		cache = new Map();
		traceCachesByManager.set(manager, cache);
	}
	return cache;
}

export function sweepExpiredTraceCache(cache: TraceCache, now = Date.now()): void {
	for (const [key, entry] of cache) {
		if (now - entry.at >= TRACE_CACHE_TTL_MS) cache.delete(key);
	}
}

/** True when a run for `id`'s feature started strictly after `cachedAt` — a re-dispatch the cached
 *  response predates. Roster-only (no disk scan), so re-validating a hit costs nothing next to the
 *  full trace recompute it's meant to avoid. Non-feature trace ids (bare / `run:`-prefixed — always
 *  scoped to one immutable run) never go stale this way, so they're always considered fresh. */
function hasNewerRunForTrace(manager: SquadManager, id: string, cachedAt: number): boolean {
	if (!id.startsWith("feat:")) return false;
	const featureId = id.slice(5);
	return manager.list().some((dto) => dto.featureId === featureId && (dto.startedAt ?? 0) > cachedAt);
}

export async function tracePayload(manager: SquadManager, id: string): Promise<TraceResponse> {
	const cache = traceCacheFor(manager);
	const hit = cache.get(id);
	if (hit) {
		if (Date.now() - hit.at < TRACE_CACHE_TTL_MS && !hasNewerRunForTrace(manager, id, hit.at)) return hit.response;
		cache.delete(id); // expired, or superseded by a new run under the same feature — evict either way
	}
	const response = await manager.trace(id);
	// Only cache once the trace looks finalized: it must have at least one receipt (an empty/not-yet-
	// journaled trace is never "finalized" — caching it would hide receipts that land moments later for
	// up to TRACE_CACHE_TTL_MS) and no receipt still mid-run (no receipt missing endedAt).
	if (response.receipts.length > 0 && response.receipts.every((r) => r.endedAt !== undefined)) {
		sweepExpiredTraceCache(cache);
		if (cache.size >= TRACE_CACHE_MAX) {
			const oldest = cache.keys().next().value; // Map preserves insertion order — FIFO
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(id, { at: Date.now(), response });
	}
	return response;
}

/** Every persisted receipt across every manager the caller can see — a tenant session's array is always
 *  1 manager (unchanged behavior); the bootstrap-admin break-glass array can be several, so this unions
 *  them rather than reading only the first (which would silently drop every other org's history). */
async function allReceiptsAcross(managers: SquadManager[]): Promise<RunReceipt[]> {
	return (await Promise.all(managers.map((m) => m.allReceipts()))).flat();
}

/**
 * Knowledge-view incident, layer 1: `/api/fabric` and `/api/fabric/search` used to read the single
 * per-request `manager` like a plain feature route (post `!manager` gate), instead of joining
 * `handleObservability`'s break-glass union — the exact disease #113 fixed for graph/usage/heat/
 * activity/action-items/governance/health. A bootstrap-admin without a root factory (the daemon's
 * default: `OMP_SQUAD_ROOT_FACTORY` unset) never resolves a single `manager` at all and fell
 * through to `noFleet`'s bare `[]`; even WITH a root factory, this route's own `manager` would
 * only ever be the root's, silently omitting every other live org's facts. Unions each reachable
 * manager's own `.fabric()` — a tenant session's array is always its own 1 manager (see
 * `observabilityManagers`), so this is a no-op union for it; isolation is unaffected.
 */
export async function fabricSnapshotAcross(managers: SquadManager[], actor: Actor, opts: { repos?: string[]; includeLeases?: boolean }): Promise<FabricSnapshot> {
	const snapshots = await Promise.all(managers.map((m) => m.fabric(actor, opts)));
	if (snapshots.length <= 1) return snapshots[0] ?? { actor: actor.id, generatedAt: Date.now(), scope: [], agents: [], digests: [], hotAreas: [], scout: [], leases: [], decisions: [], failures: [], symptoms: [], episodes: [], answers: [] };
	return {
		actor: actor.id,
		generatedAt: Math.max(...snapshots.map((s) => s.generatedAt)),
		scope: [...new Set(snapshots.flatMap((s) => s.scope))].sort(),
		agents: snapshots.flatMap((s) => s.agents),
		digests: snapshots.flatMap((s) => s.digests),
		hotAreas: snapshots
			.flatMap((s) => s.hotAreas)
			.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
			.slice(0, 50),
		scout: snapshots.flatMap((s) => s.scout),
		leases: snapshots.flatMap((s) => s.leases),
		decisions: snapshots.flatMap((s) => s.decisions),
		failures: snapshots.flatMap((s) => s.failures),
		symptoms: snapshots.flatMap((s) => s.symptoms),
		episodes: snapshots.flatMap((s) => s.episodes),
		answers: snapshots.flatMap((s) => s.answers),
	};
}

/** Same disease, `/api/audit`: union each manager's own audit log (fetched uncapped via `limit: 0`,
 *  matching `readAudit`'s own "<=0 ⇒ no cap" contract) before re-sorting newest-first and applying
 *  the CALLER's requested limit — a per-manager pre-merge cap would silently drop entries that
 *  should have made the merged top-N. */
export async function auditPayloadAcross(managers: SquadManager[], query: AuditQuery): Promise<AuditEntry[]> {
	const perManager = await Promise.all(managers.map((m) => m.auditLog({ ...query, limit: 0 })));
	const merged = perManager.flat().sort((a, b) => b.at - a.at || b.id - a.id);
	const limit = query.limit ?? 200;
	return limit > 0 ? merged.slice(0, limit) : merged;
}

function mergeAutomationRollups(rows: AutomationRollupRow[][]): AutomationRollupRow[] {
	const merged = new Map<AutomationLoop, AutomationRollupRow>();
	for (const list of rows) {
		for (const r of list) {
			const cur = merged.get(r.loop) ?? { loop: r.loop, events: 0, llmCalls: 0, found: 0, filed: 0, spawned: 0, errors: 0, lastAt: 0 };
			cur.events += r.events;
			cur.llmCalls += r.llmCalls;
			cur.found += r.found;
			cur.filed += r.filed;
			cur.spawned += r.spawned;
			cur.errors += r.errors;
			if (r.lastAt >= cur.lastAt) {
				cur.lastAt = r.lastAt;
				cur.lastSkipReason = r.lastSkipReason;
			}
			merged.set(r.loop, cur);
		}
	}
	return [...merged.values()].sort((a, b) => a.loop.localeCompare(b.loop));
}

/** Same disease, `/api/automation`: union each manager's recent events (fetched uncapped, same
 *  `limit: 0` convention as auditPayloadAcross) then re-sort/re-limit, and sum the per-loop rollups
 *  field-by-field (a straight count/sum aggregation — `lastAt`/`lastSkipReason` take the max). */
export async function automationPayloadAcross(managers: SquadManager[], query: AutomationQuery & { windowMs?: number }): Promise<{ events: AutomationEvent[]; rollup: AutomationRollupRow[] }> {
	const perManager = await Promise.all(managers.map((m) => m.automationActivity({ ...query, limit: 0 })));
	const merged = perManager.flatMap((r) => r.events).sort((a, b) => b.at - a.at || b.id - a.id);
	const limit = query.limit ?? 200;
	return { events: limit > 0 ? merged.slice(0, limit) : merged, rollup: mergeAutomationRollups(perManager.map((r) => r.rollup)) };
}

function mergeMetricRollups(rows: MetricRollupRow[][]): MetricRollupRow[] {
	const merged = new Map<MetricName, MetricRollupRow>();
	for (const list of rows) {
		for (const r of list) {
			const cur = merged.get(r.name) ?? { name: r.name, count: 0, sum: 0, avg: 0 };
			cur.count += r.count;
			cur.sum += r.sum;
			cur.avg = cur.count ? cur.sum / cur.count : 0;
			if (r.byTag) {
				cur.byTag ??= {};
				for (const [tagKey, tagVals] of Object.entries(r.byTag)) {
					cur.byTag[tagKey] ??= {};
					for (const [val, bucket] of Object.entries(tagVals)) {
						const b = (cur.byTag[tagKey][val] ??= { count: 0, sum: 0, avg: 0 });
						b.count += bucket.count;
						b.sum += bucket.sum;
						b.avg = b.count ? b.sum / b.count : 0;
					}
				}
			}
			merged.set(r.name, cur);
		}
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Same disease, `/api/metrics/learning-loop`: `flags` is pure env resolution (`learningFlags()`),
 *  identical regardless of which manager answers, so it's read once; the per-metric rollups are
 *  summed across every reachable manager. */
export function learningLoopPayloadAcross(managers: SquadManager[], windowMs?: number): { flags: ReturnType<typeof learningFlags>; rollup: MetricRollupRow[] } {
	return { flags: learningFlags(), rollup: mergeMetricRollups(managers.map((m) => m.learningMetricsSnapshot(windowMs).rollup)) };
}

export async function usagePayload(managers: SquadManager[], url: URL): Promise<{
	runs: RunReceipt[];
	receipts: RunReceipt[];
	toolCalls: number;
	costUsd?: number;
	tokens?: number;
	durationMs?: number;
	agents: number;
	since?: number;
	/** Runs in this window whose cost is UNKNOWN (unverified-usage harness — see `RunReceipt.costUnknown`),
	 *  excluded from `costUsd` above rather than folded in as a fabricated $0 (ticket #348, same honesty
	 *  rule as `attribution-scoreboard.ts`/`token-burn.ts`). Absent/0 when every run had a known cost. */
	unattributedRuns?: number;
}> {
	const limit = boundedNumber(url.searchParams.get("limit"), 100, 1, 1000);
	const repo = url.searchParams.get("repo") ?? undefined;
	const agentId = url.searchParams.get("agentId") ?? undefined;
	const since = boundedNumber(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER) || undefined;
	// Source the persisted ledger (like attributionPayload/trace), not the live roster: receipts outlive
	// the agents that produced them — reaped agents, and every agent after a daemon restart — so
	// roster-scoping hid all but the currently-live runs' history.
	const receipts = (await allReceiptsAcross(managers)).filter(
		(r) => (!repo || r.repo === repo) && (!agentId || r.agentId === agentId) && (!since || (r.endedAt ?? r.startedAt) >= since),
	);
	const runs = receipts.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)).slice(0, limit);
	const totals = runs.reduce((acc, r) => {
		acc.toolCalls += r.toolCalls;
		// costUnknown (ticket #348, same rule as attribution-scoreboard.ts/token-burn.ts): excluded from
		// the cost sum, tallied separately — never folded into costUsd as a fabricated $0 (a harness whose
		// usage was never observed must never render as "free").
		if (r.costUnknown) acc.unattributedRuns += 1;
		else acc.costUsd += r.costUsd ?? 0;
		acc.tokens += r.tokens?.total ?? 0;
		acc.durationMs += r.durationMs ?? 0;
		return acc;
	}, { toolCalls: 0, costUsd: 0, tokens: 0, durationMs: 0, unattributedRuns: 0 });
	return {
		runs,
		receipts: runs,
		toolCalls: totals.toolCalls,
		costUsd: totals.costUsd || undefined,
		tokens: totals.tokens || undefined,
		durationMs: totals.durationMs || undefined,
		agents: new Set(receipts.map((r) => r.agentId)).size,
		since,
		unattributedRuns: totals.unattributedRuns || undefined,
	};
}

export async function heatPayload(managers: SquadManager[], url: URL): Promise<{
	days: string[];
	tree: { id: string; name: string; type: "file"; depth: number; heat: number[]; repo: string }[];
	hotAreas: { path: string; heat: number; repo: string }[];
	insights: string[];
	source: string;
	generatedAt: number;
}> {
	const count = boundedNumber(url.searchParams.get("days"), 8, 1, 31);
	const repoParam = url.searchParams.get("repo") ?? undefined;
	// Repo-normalize equality (comprehension concern 04, batch-3 review): the raw `r.repo === repo`
	// compare missed a repo whose STORED receipts and the query's `?repo=` value are the same repo
	// in an equivalent-but-differently-formed path (trailing slash, `~/`-form vs its expanded
	// absolute form) — same bug class as the fabric leak incident, in the exact endpoint the
	// concern-04 fog overlay extends. Same discipline every other repo-scoped GET in this file uses.
	const repoNorm = repoParam ? normalizeRepoPath(repoParam) : undefined;
	const end = new Date();
	const days = Array.from({ length: count }, (_, i) => {
		const d = new Date(end);
		d.setDate(end.getDate() - (count - i - 1));
		return d.toISOString().slice(0, 10);
	});
	const indexByDay = new Map(days.map((d, i) => [d, i]));
	// Persisted ledger, not the live roster (see usagePayload) — otherwise reaped agents and post-restart
	// history vanish and the panel falsely reads "No receipt-backed file writes in this window".
	const receipts = (await allReceiptsAcross(managers)).filter((r) => !repoNorm || normalizeRepoPath(r.repo) === repoNorm);
	// Repo-keyed aggregation (comprehension concern 04, batch-3 review): bare `file` keys collapsed
	// same-named files across different repos into ONE heat array whenever this response spans more
	// than one repo — an unfiltered fleet-wide read (no `?repo=`), or a bootstrap-admin's cross-org
	// break-glass view (see observability-bootstrap-admin.test.ts). Key by
	// `${normalizeRepoPath(repo)}\0${file}`, the SAME join convention `comprehension-fog.ts`'s
	// `fogKey` and `attention.ts`'s `seenKey` already use, so a same-named file in a different repo
	// never shares a heat array with this one. `repo` (the RAW, unnormalized receipt repo — the same
	// representation `computeFog`'s `FileFogEntry.repo` exposes) is carried on every tree/hotArea
	// entry so the concern-04 fog overlay can join heat nodes back to `/api/fog` entries without
	// re-deriving its own repo convention.
	const byFile = new Map<string, { repo: string; file: string; heat: number[] }>();
	for (const r of receipts) {
		const day = new Date(r.endedAt ?? r.startedAt).toISOString().slice(0, 10);
		const idx = indexByDay.get(day);
		if (idx === undefined) continue;
		for (const file of r.filesTouched) {
			const key = `${normalizeRepoPath(r.repo)}\0${file}`;
			const entry = byFile.get(key) ?? { repo: normalizeRepoPath(r.repo), file, heat: Array(count).fill(0) };
			entry.heat[idx] += 1;
			byFile.set(key, entry);
		}
	}
	const tree = [...byFile.values()]
		.sort((a, b) => a.file.localeCompare(b.file) || a.repo.localeCompare(b.repo))
		.map((entry) => ({
			id: entry.file,
			name: path.basename(entry.file),
			type: "file" as const,
			depth: Math.max(0, entry.file.split(/[\\/]/).length - 1),
			heat: entry.heat,
			repo: entry.repo,
		}));
	const hotAreas = tree.map((n) => ({ path: n.id, heat: n.heat.reduce((a, b) => a + b, 0), repo: n.repo })).filter((n) => n.heat > 0).sort((a, b) => b.heat - a.heat).slice(0, 8);
	return {
		days,
		tree,
		hotAreas,
		insights: hotAreas.length ? [`${hotAreas.length} files touched in recent receipts`] : ["No receipt-backed file writes in this window"],
		source: "receipts.filesTouched",
		generatedAt: Date.now(),
	};
}

/**
 * Day×hour activity matrix for the "Activity rhythm" heatmap: for each of the last
 * `days` calendar days, how many file-touches landed in each hour 00–23. Same
 * receipt source as heatPayload (filesTouched), just bucketed by hour-of-day too,
 * so the two views agree on totals.
 *
 * Server-LOCAL time throughout (the daemon runs on the operator's machine, so its
 * wall clock is the rhythm the operator actually lives) — a (day, hour) cell is
 * internally consistent because both come from the same local Date.
 */
export async function activityHeatmapPayload(managers: SquadManager[], url: URL): Promise<{
	days: string[];
	hours: number[];
	matrix: { day: string; hourly: number[] }[];
	max: number;
	total: number;
	source: string;
	generatedAt: number;
}> {
	const count = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const repo = url.searchParams.get("repo") ?? undefined;
	const localDay = (d: Date): string =>
		`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	const end = new Date();
	const days = Array.from({ length: count }, (_, i) => {
		const d = new Date(end);
		d.setDate(end.getDate() - (count - i - 1));
		return localDay(d);
	});
	const rowByDay = new Map(days.map((d) => [d, new Array<number>(24).fill(0)]));
	// Persisted ledger, not the live roster (see usagePayload), so the rhythm survives restarts + reaps.
	const receipts = (await allReceiptsAcross(managers)).filter((r) => !repo || r.repo === repo);
	let max = 0;
	let total = 0;
	for (const r of receipts) {
		const touched = r.filesTouched.length;
		if (touched === 0) continue;
		const when = new Date(r.endedAt ?? r.startedAt);
		const row = rowByDay.get(localDay(when));
		if (!row) continue;
		const hour = when.getHours();
		row[hour] += touched;
		total += touched;
		if (row[hour] > max) max = row[hour];
	}
	return {
		days,
		hours: Array.from({ length: 24 }, (_, i) => i),
		matrix: days.map((day) => ({ day, hourly: rowByDay.get(day) ?? new Array<number>(24).fill(0) })),
		max,
		total,
		source: "receipts.filesTouched (per day×hour, server-local)",
		generatedAt: Date.now(),
	};
}

/** Per-adapter config/secrets from OMP_GRAPH_<ADAPTER>_<KEY> env vars → { adapter: { KEY: value } }. */
function graphConfigFromEnv(): Record<string, Record<string, string>> {
	const cfg: Record<string, Record<string, string>> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!v) continue;
		const m = /^OMP_GRAPH_([A-Z0-9]+)_(.+)$/.exec(k);
		if (!m) continue;
		(cfg[m[1].toLowerCase()] ??= {})[m[2]] = v;
	}
	return cfg;
}

/** Short-TTL cache so polling clients (and future slow external adapters) don't recompute every hit. */
const graphCache = new Map<string, { at: number; doc: GraphDoc }>();

/**
 * The normalized omp-graph document (GET /api/graph) — the source-agnostic wire
 * format the living dashboard consumes. Composes the default adapter set (git +
 * receipts + automation + plane) over `days` of history plus `future` days ahead
 * (for upcoming meetings/renewals once those adapters land). Reconstructs the
 * daemon state dir like index.ts, and passes per-adapter secrets from env.
 */
/**
 * Resolve the `?repo=` param against the allowlist (known project repos + the daemon
 * cwd). Returns null when a caller asks for a repo outside it — so an authenticated
 * viewer can't drive `git show` / adapter reads against arbitrary repos on the host.
 * No param → the daemon cwd (the webapp never sends one).
 */
export function resolveGraphRepo(url: URL, managers: SquadManager[]): string | null {
	const raw = url.searchParams.get("repo");
	if (!raw) return process.cwd();
	const resolved = path.resolve(raw);
	const allowed = new Set([path.resolve(process.cwd()), ...managers.flatMap((m) => m.projects()).map((p) => path.resolve(p.repo))]);
	return allowed.has(resolved) ? resolved : null;
}

export async function graphPayload(url: URL, repo: string): Promise<GraphDoc & { plan: { name: string; monthly: number } | null }> {
	const days = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const future = boundedNumber(url.searchParams.get("future"), 0, 0, 14);
	// explicit window (epoch ms) for history views — the DEPTH massif fetches one
	// window per week row. Bounded to 32 days so a bad param can't walk all of git.
	const range = explicitRange(url);
	const stateDir = resolveStateDir();
	const key = range ? `r${range.start}:${range.end}:${repo}` : `${days}:${future}:${repo}`;
	const ttl = envInt("OMP_GRAPH_CACHE_MS", 10_000);
	const fresh = url.searchParams.get("fresh"); // reload icon bypasses the cache
	const plan = planFromEnv() ?? null;
	const hit = graphCache.get(key);
	if (hit && !fresh && Date.now() - hit.at < ttl) return { ...hit.doc, plan };
	// external-harness ledgers (Claude Code sessions) fold into receipts here,
	// throttled — so the pulse attributes EVERY harness that worked this repo
	await ingestHarnesses(stateDir, repo);
	const doc = await buildGraph({ repo, stateDir, config: graphConfigFromEnv() }, range ? { range } : { days, futureDays: future });
	graphCache.set(key, { at: Date.now(), doc });
	return { ...doc, plan };
}

/** Parse ?start=&end= (epoch ms) into a bounded TimeRange, or null when absent/invalid. */
function explicitRange(url: URL): { start: number; end: number } | null {
	const start = Number(url.searchParams.get("start"));
	const end = Number(url.searchParams.get("end"));
	if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) return null;
	const MAX_SPAN = 32 * 24 * 3_600_000;
	return end - start > MAX_SPAN ? { start: end - MAX_SPAN, end } : { start, end };
}

/** GET /api/graph/attribution — the harness→model spend matrix behind the pulse bands. */
export async function attributionPayload(url: URL, repo: string): Promise<ReturnType<typeof buildAttribution>> {
	const days = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const range = explicitRange(url) ?? { start: Date.now() - days * 24 * 3_600_000, end: Date.now() };
	const stateDir = resolveStateDir();
	await ingestHarnesses(stateDir, repo);
	const receipts = (await readAllReceipts(stateDir)).filter((r) => r.repo === repo);
	return buildAttribution(receipts, range, { plan: planFromEnv() });
}

/**
 * The model scoreboard: land-rate (per complexity tier) + $/landed-change per model, joining the
 * model-outcome ledger with receipt cost. Answers the agent-selection rubric from real outcomes.
 * Outcomes are fleet-global (the ledger is not repo-keyed); cost is this repo's receipts.
 */
export async function scoreboardPayload(repo: string): Promise<Scoreboard> {
	const stateDir = resolveStateDir();
	await ingestHarnesses(stateDir, repo);
	const receipts = (await readAllReceipts(stateDir)).filter((r) => r.repo === repo);
	return buildScoreboard(receipts, readModelOutcomes(stateDir));
}

/**
 * GET /api/graph/task-class — the task-class × model outcome matrix (model-routing-control-loop
 * concern 05). OBSERVATIONAL, NOT A DECISION ORACLE — see task-class-matrix.ts's module doc; the
 * webapp panel MUST surface `doc.note` prominently, not just tuck it into a tooltip.
 */
export async function taskClassPayload(managers: SquadManager[], url: URL): Promise<TaskClassMatrixDoc> {
	const days = boundedNumber(url.searchParams.get("days"), 7, 1, 31);
	const range = explicitRange(url) ?? { start: Date.now() - days * 24 * 3_600_000, end: Date.now() };
	const stateDir = resolveStateDir();
	const rows = await readTaskOutcomes(stateDir);
	const denominatorPopulation = managers.flatMap((m) => m.landingRosterRouting());
	return buildTaskClassMatrix(rows, denominatorPopulation, range);
}

/** GET /api/graph/provenance?id=OMPSQ-336 — the plan→agent→proof→land thread for one ticket. */
export async function provenancePayload(url: URL, repo: string, managers: SquadManager[]): Promise<ProvenanceDoc | { error: string }> {
	const id = (url.searchParams.get("id") ?? "").trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) return { error: "invalid ticket id" };
	const stateDir = resolveStateDir();
	const featureLists = await Promise.all(managers.map((m) => m.features(repo).catch(() => [])));
	const features = featureLists.flat().map((f) => ({
		id: f.id,
		title: f.title,
		planDir: f.planDir,
		issueIdentifiers: f.issueIdentifiers,
	}));
	return buildProvenance({ repo, stateDir, ticket: id, features });
}

// ── commit detail (GET /api/graph/commit?sha=) — the "click a milestone → diff" drilldown ──

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const MAX_DIFF_LINES = 900; // bound the payload; huge refactors get a "truncated" flag

interface CommitLine {
	t: "ctx" | "add" | "del" | "hunk";
	s: string;
}
interface CommitFile {
	path: string;
	status: "added" | "deleted" | "modified" | "renamed";
	additions: number;
	deletions: number;
	lines: CommitLine[];
}
export interface CommitDetail {
	sha: string;
	author: string;
	dateMs: number;
	subject: string;
	files: CommitFile[];
	additions: number;
	deletions: number;
	truncated: boolean;
}

/** Parse a `git show` unified patch into per-file typed lines. Pure. */
function parseUnifiedDiff(patch: string): { files: CommitFile[]; truncated: boolean } {
	const files: CommitFile[] = [];
	let cur: CommitFile | null = null;
	let total = 0;
	let truncated = false;
	const push = (line: CommitLine): void => {
		if (total < MAX_DIFF_LINES) cur?.lines.push(line);
		else truncated = true;
		total++;
	};
	for (const raw of patch.split("\n")) {
		if (raw.startsWith("diff --git")) {
			const m = raw.match(/ b\/(.+)$/);
			cur = { path: m ? m[1] : "?", status: "modified", additions: 0, deletions: 0, lines: [] };
			files.push(cur);
		} else if (!cur) {
			continue;
		} else if (raw.startsWith("new file")) {
			cur.status = "added";
		} else if (raw.startsWith("deleted file")) {
			cur.status = "deleted";
		} else if (raw.startsWith("rename ")) {
			cur.status = "renamed";
		} else if (raw.startsWith("@@")) {
			push({ t: "hunk", s: raw });
		} else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("similarity ") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("Binary files")) {
			// metadata lines — skip
		} else if (raw.startsWith("+")) {
			cur.additions++;
			push({ t: "add", s: raw.slice(1) });
		} else if (raw.startsWith("-")) {
			cur.deletions++;
			push({ t: "del", s: raw.slice(1) });
		} else if (raw.startsWith(" ")) {
			push({ t: "ctx", s: raw.slice(1) });
		}
	}
	return { files, truncated };
}

export async function commitDetailPayload(url: URL, repo: string): Promise<CommitDetail | { error: string }> {
	const sha = (url.searchParams.get("sha") ?? "").trim();
	if (!SHA_RE.test(sha)) return { error: "invalid sha" }; // guard against arg injection
	const US = "\x1f";
	const RS = "\x1e";
	try {
		const proc = Bun.spawn(["git", "-C", repo, "show", "--no-color", "--no-notes", "--patch", `--format=format:%H${US}%an${US}%aI${US}%s${RS}`, sha], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0 || !out) return { error: "commit not found" };
		const rsIdx = out.indexOf(RS);
		const header = rsIdx >= 0 ? out.slice(0, rsIdx) : out;
		const patch = rsIdx >= 0 ? out.slice(rsIdx + 1) : "";
		const [hsha = sha, author = "", iso = "", subject = ""] = header.split(US);
		const { files, truncated } = parseUnifiedDiff(patch);
		const additions = files.reduce((a, f) => a + f.additions, 0);
		const deletions = files.reduce((a, f) => a + f.deletions, 0);
		return { sha: hsha, author, dateMs: Date.parse(iso) || 0, subject, files, additions, deletions, truncated };
	} catch {
		return { error: "git show failed" };
	}
}


/**
 * Fleet-wide health across every manager the caller can see. `rssMb`/`load1`/`ncpu`/`freeRatio`/`hosts`
 * are process/host-wide (sampleHealth reads `process.memoryUsage()`/`os.*`, identical no matter which
 * manager answers, since every manager lives in this one daemon process) — so the first manager's own
 * sample already supplies them correctly. Only `agents` (live roster occupancy) differs per manager, so
 * for a multi-manager (bootstrap-admin) view it's summed and the warnings recomputed against the true
 * fleet-wide count — otherwise a WIP-cap warning would only ever reflect one org's agents.
 */
export async function aggregateHealth(managers: SquadManager[]): Promise<Awaited<ReturnType<SquadManager["sampleHealth"]>>> {
	const [primary, ...rest] = managers;
	const { sample, warnings, at } = await primary.sampleHealth();
	if (rest.length === 0) return { sample, warnings, at };
	const agents = liveAgentCount(managers.flatMap((m) => m.list()));
	const combined: HealthSample = { ...sample, agents };
	return { sample: combined, warnings: assessHealth(combined, defaultHealthLimits(sample.ncpu, hardAgentCeiling())), at };
}

export async function governancePayload(managers: SquadManager[], role: Role, dbMode: boolean, dbRegistry: boolean): Promise<{
	authMode: "db" | "file";
	role: Role;
	wipCap: number;
	maxAgents: number;
	health: Awaited<ReturnType<SquadManager["sampleHealth"]>>;
	federation: { coordinator: boolean; dbRegistry: boolean };
	audit: { available: true };
	compliance: { findings: ComplianceFinding[]; evaluatedAt: number };
}> {
	return {
		authMode: dbMode ? "db" : "file",
		role,
		wipCap: envInt("OMP_SQUAD_WIP_CAP", 3),
		maxAgents: hardAgentCeiling(),
		health: await aggregateHealth(managers),
		federation: { coordinator: !!process.env.OMP_SQUAD_COORDINATOR, dbRegistry },
		audit: { available: true },
		// Epic 3 (leaf 05): real policy findings over the audit + land ledgers, not just RBAC/capacity.
		compliance: { findings: (await Promise.all(managers.map((m) => m.complianceFindings()))).flat(), evaluatedAt: Date.now() },
	};
}
export async function actionItemsPayload(managers: SquadManager[], url: URL, actor: Actor): Promise<{ items: ActionItem[]; generatedAt: number }> {
	const repo = url.searchParams.get("repo") ?? undefined;
	const agents = (await Promise.all(managers.map((m) => m.visibleAgents(actor)))).flat().filter((a) => !repo || a.repo === repo);
	const health = await aggregateHealth(managers);
	const items: ActionItem[] = [];
	for (const a of agents) {
		for (const p of a.pending) {
			items.push({
				id: `pending:${a.id}:${p.id}`,
				severity: p.source === "tool" ? "high" : "medium",
				source: p.source,
				subject: `${a.name}: ${p.title}`,
				rootCause: p.message ?? "Agent is waiting for operator input.",
				nextAction: p.source === "tool" ? "Review and answer the host-tool request" : "Answer the pending prompt",
				targetRoute: `#/console/${encodeURIComponent(a.id)}`,
				agentId: a.id,
				requestId: p.id,
			});
		}
		if (a.status === "error") {
			items.push({
				id: `error:${a.id}`,
				severity: "high",
				source: "agent",
				subject: `${a.name} errored`,
				rootCause: a.error ?? "Agent reported an error.",
				nextAction: "Open transcript, then restart or remove the agent",
				targetRoute: `#/console/${encodeURIComponent(a.id)}`,
				agentId: a.id,
			});
		}
		if (a.landReady) {
			items.push({
				id: `land:${a.id}`,
				severity: "medium",
				source: "land",
				subject: `${a.name} is ready to land`,
				rootCause: "Verification passed and auto-land is holding for confirmation.",
				nextAction: "Review proof and land the branch",
				targetRoute: `#/agent/${encodeURIComponent(a.id)}`,
				agentId: a.id,
			});
		}
	}
	for (const warning of health.warnings) {
		items.push({
			id: `health:${warning}`,
			severity: "medium",
			source: "health",
			subject: "Fleet health warning",
			rootCause: warning,
			nextAction: "Open Fleet Health and reduce load before spawning more agents",
			targetRoute: "#/observability",
		});
	}
	items.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
	return { items, generatedAt: Date.now() };
}

type ActionItem = {
	id: string;
	severity: "low" | "medium" | "high";
	source: "ui" | "tool" | "agent" | "land" | "health";
	subject: string;
	rootCause: string;
	nextAction: string;
	targetRoute: string;
	agentId?: string;
	requestId?: string;
};

function severityRank(s: ActionItem["severity"]): number {
	return s === "high" ? 3 : s === "medium" ? 2 : 1;
}
