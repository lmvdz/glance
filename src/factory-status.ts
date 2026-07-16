/**
 * Factory status — the authoritative "is the fleet actually alive?" surface.
 *
 * The trust problem this solves: every autonomous loop defaults ON, but a loop only ARMS when its
 * preconditions are met (dispatch/observer/scout/opportunity need a configured Plane backlog —
 * `planeRepos().length > 0`; see squad-manager.ts start()). With no backlog wired, the flags read
 * "on" yet the loops never start and emit no automation rows — so an idle-but-alive fleet, an
 * armed-but-unfueled fleet, and a dead daemon all look IDENTICAL in the UI. Distrust follows.
 *
 * This module derives, per loop, a single status enum the UI can render at a glance:
 *   - moving    — armed, ticking recently, and producing work (or agents in the roster).
 *   - idle      — armed and ticking, but nothing to do right now (carries the WHY).
 *   - not-armed — flag ON but the loop never started (carries the reason + the concrete fix).
 *   - off       — flag disabled.
 *
 * The "why not armed" logic lives HERE (encoding the exact gate condition the manager enforces) and
 * is fed the real runtime facts (actual arming from the manager's live fields, real planeRepoCount,
 * real automation rollup) — so the reason is authoritative, not guessed client-side. The webapp only
 * renders the enum + reason it is handed.
 */

import type { AutomationRollupRow } from "./automation-log.ts";
import type { MetricEvent } from "./metrics.ts";

/** Per-loop first-glance status. Ordered worst→best for the headline roll-up. */
export type FactoryLoopStatus = "off" | "not-armed" | "idle" | "moving";

/** Static description of one autonomous loop — the source of truth for its gate + cadence. */
export interface FactoryLoopSpec {
	/** Stable key (matches AutomationLoop for heartbeat loops). */
	loop: string;
	label: string;
	/** Env var that gates the loop (default-on unless set to "0"). */
	flagEnvKey: string;
	/** Whether the loop is gated on a configured Plane backlog (`planeRepos().length > 0`). */
	needsBacklog: boolean;
	/** Whether the loop emits automation heartbeats (so lastTick/skip come from the rollup). */
	heartbeat: boolean;
	/** Expected tick cadence in ms (0 for mode-style loops with no timer of their own). */
	cadenceMs: number;
	/** One-line plain-English description of what the loop does. */
	blurb: string;
}

/**
 * The autonomous loops surfaced on the factory strip, in display order. The first four are the
 * backlog-fueled heartbeat loops (dark today when no Plane backlog is wired); the last two are the
 * self-drive/land modes that run against the live roster regardless of backlog.
 */
export const FACTORY_LOOPS: FactoryLoopSpec[] = [
	{ loop: "dispatch", label: "Dispatch", flagEnvKey: "OMP_SQUAD_AUTODISPATCH", needsBacklog: true, heartbeat: true, cadenceMs: 60_000, blurb: "Polls the Plane backlog and spawns routed agents for unblocked issues." },
	{ loop: "observer", label: "Observer", flagEnvKey: "OMP_SQUAD_OBSERVE", needsBacklog: true, heartbeat: true, cadenceMs: 60_000, blurb: "Audits fleet & backlog health, filing or clearing findings." },
	{ loop: "scout", label: "Scout", flagEnvKey: "OMP_SQUAD_SCOUT", needsBacklog: true, heartbeat: true, cadenceMs: 60_000, blurb: "Harvests latent backlog items from agent reasoning." },
	{ loop: "opportunity", label: "Opportunity", flagEnvKey: "OMP_SQUAD_OPPORTUNITY", needsBacklog: true, heartbeat: true, cadenceMs: 60_000, blurb: "Clusters scout patterns and receipt hot-areas into opportunities." },
	{ loop: "autodrive", label: "Self-drive", flagEnvKey: "OMP_SQUAD_AUTODRIVE", needsBacklog: false, heartbeat: false, cadenceMs: 0, blurb: "Continuously verifies, lands, self-heals and escalates in-flight work." },
	{ loop: "autoland", label: "Auto-land", flagEnvKey: "OMP_SQUAD_AUTOLAND", needsBacklog: false, heartbeat: false, cadenceMs: 0, blurb: "Lets green workflow branches land themselves." },
];

/** One loop's derived status — what the strip renders. */
export interface FactoryLoopReport {
	loop: string;
	label: string;
	blurb: string;
	/** Effective flag state (env, after runtime-settings were applied into env at boot). */
	flagEnabled: boolean;
	/** Whether the loop actually started this run (from the manager's live fields). */
	armed: boolean;
	/** When flag-ON but not armed: why it never started (authoritative — encodes the manager's gate). */
	notArmedReason?: string;
	/** When not fueled: the concrete operator fix. */
	fix?: string;
	/** Heartbeat loops: epoch-ms of the most-recent tick in the window (0/undefined ⇒ silent). */
	lastTickAt?: number;
	/** Seconds since the last tick (undefined when never ticked). */
	secondsSinceLastTick?: number;
	/** True when armed but the last heartbeat is older than the freshness budget (possible stall). */
	stale: boolean;
	/** Plain-English reason for an idle tick (from the loop's own skipReason detail), if any. */
	lastSkipReason?: string;
	status: FactoryLoopStatus;
}

/** The whole-factory snapshot behind GET /api/factory/status. */
export interface FactoryStatus {
	generatedAt: number;
	/** Roster agents actively occupying a slot (starting/working/input) — the loudest "it's moving" signal. */
	activeAgents: number;
	/** Number of Plane repos wired — 0 is the "not fueled" root cause for the backlog loops. */
	planeRepoCount: number;
	loops: FactoryLoopReport[];
	/** Headline status for the strip's master heartbeat dot. */
	overall: FactoryLoopStatus;
	/** Cumulative FileStore.save() failures this process (0 in DB mode / a healthy run). The topology
	 *  guarantee (inspectable-topology) rests on this write landing, so a nonzero count is actionable. */
	persistFailures: number;
	/** The "fleet cannot land" banner (research-sirvir/01-recording-unlock, part 2) — see below. */
	landBlocked: FactoryLandBlockStatus;
	/** The per-lane shadow-exit scoreboard (adw-factory-borrows concern 09) — see below. */
	shadowExits: ShadowExitScoreboard;
}

/**
 * The shadow-exit scoreboard (adw-factory-borrows concern 09, red-team: "shadow-forever is the
 * observed outcome — the model-outcomes ledger sat empty for a month"). One place the operator reads
 * BEFORE flipping a lane from shadow to apply/enforce: lane classification counts, how often
 * model-route's SHADOW decisions would have escalated to the frontier model, and how often the cost
 * gate's SHADOW verdicts would have asked/denied. This concern's definition of done is this surface
 * EXISTING, not any flip being made (module doc, `LANE_POLICY` all still ship shadow-first).
 */
export interface ShadowExitScoreboard {
	/** Classified-lane counts within the window, keyed by `WorkLane`. */
	laneCounts: Record<string, number>;
	/** Total classified spawns within the window (sum of `laneCounts`). */
	laneTotal: number;
	/** Model-route decisions recorded in SHADOW mode (not applied) that WOULD have escalated to the
	 *  frontier model, within the window. */
	modelRouteShadowWouldEscalate: number;
	/** Total model-route decisions recorded in shadow mode within the window (denominator for the
	 *  ratio above). */
	modelRouteShadowTotal: number;
	/** Cost-gate verdicts (ask/deny) that fired OUTSIDE enforce mode within the window — i.e. would
	 *  have asked/denied had the lane/gate been flipped to enforce. */
	costGateShadowWouldAct: number;
	/** Total cost-gate verdicts (any action) recorded outside enforce mode within the window
	 *  (denominator for the ratio above). */
	costGateShadowTotal: number;
}

/**
 * Derive the shadow-exit scoreboard from the manager's raw learning-metric events (already windowed
 * by the caller — same freshness window `factoryStatus()` feeds everything else here). Pure over its
 * input, like `deriveLandBlockStatus`/`deriveLoopReport`.
 *
 * `routeEvents`/`costEvents` are filtered by tag HERE (not via `MetricRollupRow.byTag`, whose
 * breakdown is per-tag-key independently and can't answer a JOINT "mode=shadow AND action=ask/deny"
 * query) so the counters below are exact, not an approximation from two independent marginals.
 */
export function deriveShadowExitScoreboard(input: { laneEvents: MetricEvent[]; routeEvents: MetricEvent[]; costEvents: MetricEvent[] }): ShadowExitScoreboard {
	const laneCounts: Record<string, number> = {};
	for (const e of input.laneEvents) {
		const lane = e.tags?.lane ?? "unknown";
		laneCounts[lane] = (laneCounts[lane] ?? 0) + 1;
	}

	const shadowRouteEvents = input.routeEvents.filter((e) => e.tags?.mode === "shadow");
	const modelRouteShadowWouldEscalate = shadowRouteEvents.filter((e) => e.value === 1).length;

	const shadowCostEvents = input.costEvents.filter((e) => e.tags?.mode !== "enforce");
	const costGateShadowWouldAct = shadowCostEvents.filter((e) => e.tags?.action === "ask" || e.tags?.action === "deny").length;

	return {
		laneCounts,
		laneTotal: input.laneEvents.length,
		modelRouteShadowWouldEscalate,
		modelRouteShadowTotal: shadowRouteEvents.length,
		costGateShadowWouldAct,
		costGateShadowTotal: shadowCostEvents.length,
	};
}

/**
 * "Fleet cannot land" banner status, derived from the "land" automation channel (event-driven, fired by
 * `SquadManager.fileLandBlockedFinding` on every retryable/environmental land refusal — dominantly a
 * dirty main checkout). Deliberately NOT a `FactoryLoopSpec` row: it has no flag and no cadence of its
 * own, so the armed/not-armed/idle vocabulary doesn't fit — this is a standalone always-on surface, the
 * loud alternative to silent accumulation in land-failures.json.
 */
export interface FactoryLandBlockStatus {
	/** True when a land was refused for an environmental precondition within the freshness window —
	 *  the fleet cannot land until the operator clears it (or it self-clears, e.g. a transient dirty
	 *  window). */
	blocked: boolean;
	/** The most recent refusal's detail (e.g. "‹branch›: main checkout … has uncommitted tracked
	 *  changes …"). Undefined when not currently blocked. */
	reason?: string;
	/** Epoch ms of the most recent refusal. Undefined when not currently blocked. */
	at?: number;
}

/**
 * Derive the "fleet cannot land" banner from the "land" loop's automation rollup row. `rollup` is
 * ALREADY windowed by the caller (`this.automation.rollup(windowMs, now)` in squad-manager's
 * `factoryStatus()` — the same freshness budget every other FACTORY_LOOPS row uses), so a refusal aged
 * out of that window is simply absent here; no second, independently-drifting freshness constant.
 * Only counts a refusal that carried a `skipReason` (today: `dirty-main`, the dominant/named cause) —
 * an untagged retryable cause (e.g. a PR-mode `gh` hiccup) still logs to /api/automation but doesn't
 * raise this specific, named banner. Pure over its input, like `deriveLoopReport`.
 */
export function deriveLandBlockStatus(rollup: AutomationRollupRow[]): FactoryLandBlockStatus {
	const row = rollup.find((r) => r.loop === "land");
	if (!row || !row.lastSkipReason || row.lastAt <= 0) return { blocked: false };
	return { blocked: true, reason: row.lastSkipReason, at: row.lastAt };
}

/** Effective flag read: default-ON unless explicitly "0" (mirrors the manager's `env !== "0"` gates). */
export function loopFlagEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
	return env[key] !== "0";
}

/**
 * Freshness floor (ms) shared by BOTH freshness computations: the per-loop stale budget below and the
 * rollup window squad-manager's `factoryStatus()` feeds `buildFactoryStatus` (it takes the max per-loop
 * budget, which bottoms out here). Anything that must stay visible on the strip while a condition
 * PERSISTS — e.g. the land-blocked warn re-emit cooldown — must re-occur INSIDE this window or the
 * banner silently self-clears. EXPORTED so those producers derive from it instead of duplicating it.
 */
export const FACTORY_FRESHNESS_FLOOR_MS = 300_000;

/** Freshness budget (ms) before an armed heartbeat loop is considered stale: 3 cadences, floor 5m. */
function freshnessMs(spec: FactoryLoopSpec): number {
	return Math.max(spec.cadenceMs * 3, FACTORY_FRESHNESS_FLOOR_MS);
}

export interface BuildFactoryStatusInput {
	now: number;
	env: NodeJS.ProcessEnv;
	planeRepoCount: number;
	/** Per-loop automation rollup over the freshness window (keyed by loop). */
	rollup: AutomationRollupRow[];
	/** Authoritative runtime arming from the manager's live fields (loop → started?). */
	liveArmed: Partial<Record<string, boolean>>;
	/** Roster agents occupying a slot (starting/working/input). */
	activeAgents: number;
	/** Cumulative FileStore.save() failures this process (0 when the store doesn't track them / DB mode). */
	persistFailures: number;
	/** Raw `lane-classification` learning-metric events over the window (adw-factory-borrows concern
	 *  09). Optional (defaults to empty) so callers/tests predating this scoreboard need no changes. */
	laneEvents?: MetricEvent[];
	/** Raw `model-route-decision` learning-metric events over the window. Optional, see above. */
	routeEvents?: MetricEvent[];
	/** Raw `cost-gate-verdict` learning-metric events over the window. Optional, see above. */
	costEvents?: MetricEvent[];
}

/** Derive one loop's report from its spec + the live facts. Pure — the unit under test. */
export function deriveLoopReport(spec: FactoryLoopSpec, input: BuildFactoryStatusInput): FactoryLoopReport {
	const { now, env, planeRepoCount, rollup, liveArmed, activeAgents } = input;
	const flagEnabled = loopFlagEnabled(env, spec.flagEnvKey);
	const armed = liveArmed[spec.loop] ?? false;
	const row = rollup.find((r) => r.loop === spec.loop);
	const lastTickAt = row && row.lastAt > 0 ? row.lastAt : undefined;
	const secondsSinceLastTick = lastTickAt !== undefined ? Math.max(0, Math.round((now - lastTickAt) / 1000)) : undefined;
	const lastSkipReason = row?.lastSkipReason;

	const base: FactoryLoopReport = {
		loop: spec.loop,
		label: spec.label,
		blurb: spec.blurb,
		flagEnabled,
		armed,
		lastTickAt,
		secondsSinceLastTick,
		stale: false,
		lastSkipReason,
		status: "off",
	};

	// 1. Flag off → off.
	if (!flagEnabled) return { ...base, status: "off" };

	// 2. Flag on but never armed → not-armed, with the authoritative reason + fix.
	if (!armed) {
		if (spec.needsBacklog && planeRepoCount === 0) {
			return {
				...base,
				status: "not-armed",
				notArmedReason: "no Plane backlog configured — the loop has nothing to poll, so it never started",
				fix: "Wire a Plane backlog (.plane.json) and restart the daemon.",
			};
		}
		return { ...base, status: "not-armed", notArmedReason: "flag is on but the loop did not start this run", fix: "Restart the daemon; if it persists, check the daemon logs." };
	}

	// 3. Armed. Mode loops (no heartbeat) move with the roster; heartbeat loops move with recent output.
	if (!spec.heartbeat) {
		if (activeAgents > 0) return { ...base, status: "moving" };
		return { ...base, status: "idle", lastSkipReason: lastSkipReason ?? `no work in flight to ${spec.loop === "autoland" ? "land" : "drive"}` };
	}

	const fresh = lastTickAt !== undefined && now - lastTickAt <= freshnessMs(spec);
	const stale = !fresh;
	const producing = row ? row.spawned + row.filed + row.found > 0 : false;
	const rosterMoving = spec.loop === "dispatch" && activeAgents > 0;

	if (fresh && (producing || rosterMoving)) return { ...base, stale, status: "moving" };
	if (fresh) return { ...base, stale, status: "idle", lastSkipReason: lastSkipReason ?? "no qualifying work this tick" };
	// Armed but no fresh heartbeat: still alive (the timer is set) but flag the silence honestly.
	return {
		...base,
		stale,
		status: "idle",
		lastSkipReason: lastTickAt === undefined ? "armed — awaiting first heartbeat" : `last heartbeat ${secondsSinceLastTick}s ago`,
	};
}

/** Roll the per-loop statuses (plus roster motion) up into one headline enum. */
export function deriveOverall(reports: FactoryLoopReport[], activeAgents: number): FactoryLoopStatus {
	if (activeAgents > 0 || reports.some((r) => r.status === "moving")) return "moving";
	// Not-armed (flag on, unfueled) is the loud, actionable state — surface it above plain idle.
	if (reports.some((r) => r.status === "not-armed")) return "not-armed";
	if (reports.some((r) => r.status === "idle")) return "idle";
	return "off";
}

/** Build the whole-factory snapshot. Pure over its inputs — the manager supplies the live facts. */
export function buildFactoryStatus(input: BuildFactoryStatusInput): FactoryStatus {
	const loops = FACTORY_LOOPS.map((spec) => deriveLoopReport(spec, input));
	return {
		generatedAt: input.now,
		activeAgents: input.activeAgents,
		planeRepoCount: input.planeRepoCount,
		loops,
		overall: deriveOverall(loops, input.activeAgents),
		persistFailures: input.persistFailures,
		landBlocked: deriveLandBlockStatus(input.rollup),
		shadowExits: deriveShadowExitScoreboard({ laneEvents: input.laneEvents ?? [], routeEvents: input.routeEvents ?? [], costEvents: input.costEvents ?? [] }),
	};
}
