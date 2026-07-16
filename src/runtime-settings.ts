import * as path from "node:path";
import { writeFileDurable } from "./dal/store.ts";
import { getStorageBackend } from "./dal/storage.ts";
import { hasVarianceBetween, isSampleSufficient, MIN_SAMPLES, type CellMetrics } from "./omp-graph/task-class-matrix.ts";
import type { AttentionEvent } from "./types.ts";

export type FeatureFlagKey =
	| "OMP_SQUAD_WEBAPP"
	| "OMP_SQUAD_FEEDBACK"
	| "OMP_SQUAD_AUTODISPATCH"
	| "OMP_SQUAD_AUTOCLOSE"
	| "OMP_SQUAD_AUTOLAND"
	| "OMP_SQUAD_AUTODRIVE"
	| "OMP_SQUAD_AUTO_SUPERVISE"
	| "OMP_SQUAD_AUTOSUPERVISE"
	| "OMP_SQUAD_OBSERVE"
	| "OMP_SQUAD_OBSERVE_AUTODISPATCH"
	| "OMP_SQUAD_OBSERVE_AUTOFIX"
	| "OMP_SQUAD_SCOUT"
	| "OMP_SQUAD_REGRESSION_GATE"
	| "OMP_SQUAD_LAND_RISK_GATE"
	| "OMP_SQUAD_POLICY_RULES"
	| "OMP_SQUAD_LOOP_ARMED"
	| "OMP_SQUAD_MEMBRANE_PROFILES"
	| "OMP_SQUAD_PUSH_CASUAL_DONE"
	| "OMP_SQUAD_PUSH_FLEET_DONE";

export interface FeatureFlagDefinition {
	key: FeatureFlagKey;
	label: string;
	description: string;
	defaultEnabled: boolean;
	restartRequired?: boolean;
	/**
	 * Surfaced in the settings UI but NEVER written into `process.env` by `applyFeatureFlags` at
	 * daemon boot (S1). A persisted-and-applied arm flag would leak into every daemon-spawned agent
	 * session and erode the convergence loop's dual gate to a single (env-only) gate. An ephemeral
	 * flag is armed strictly per-process by its owner (`src/convergence-run.ts`), never globally.
	 */
	ephemeral?: boolean;
}

export interface FeatureFlagState extends FeatureFlagDefinition {
	enabled: boolean;
	source: "settings" | "env" | "default";
}

export interface RuntimeSettingsSnapshot {
	featureFlags: Partial<Record<FeatureFlagKey, boolean>>;
	updatedAt?: number;
}

export const FEATURE_FLAGS: FeatureFlagDefinition[] = [
	{ key: "OMP_SQUAD_WEBAPP", label: "Vite web UI", description: "Serve the React command center when the built assets exist.", defaultEnabled: false, restartRequired: true },
	{ key: "OMP_SQUAD_FEEDBACK", label: "Feedback intake", description: "Expose the public feedback widget/intake endpoints.", defaultEnabled: false },
	{ key: "OMP_SQUAD_AUTODISPATCH", label: "Auto-dispatch", description: "Poll Plane and spawn routed agents for new unblocked issues.", defaultEnabled: true, restartRequired: true },
	{ key: "OMP_SQUAD_AUTOCLOSE", label: "Auto-close issues", description: "Close tracking issues after their branches land.", defaultEnabled: true, restartRequired: true },
	{ key: "OMP_SQUAD_AUTOLAND", label: "Workflow auto-land", description: "Let successful workflow agents land their own branches.", defaultEnabled: true, restartRequired: true },
	{ key: "OMP_SQUAD_AUTODRIVE", label: "Self-drive loop", description: "Continuously verify, land, self-heal, and escalate idle work.", defaultEnabled: true, restartRequired: true },
	{ key: "OMP_SQUAD_AUTO_SUPERVISE", label: "External auto-supervisor", description: "Start the file-mode supervisor client that answers routine prompts.", defaultEnabled: true, restartRequired: true },
	{ key: "OMP_SQUAD_AUTOSUPERVISE", label: "In-process auto-supervise", description: "Auto-answer low-risk pending requests inside each manager.", defaultEnabled: true },
	{ key: "OMP_SQUAD_OBSERVE", label: "Observer", description: "Run the self-audit loop that files or clears operational findings.", defaultEnabled: true, restartRequired: true },
	{ key: "OMP_SQUAD_OBSERVE_AUTODISPATCH", label: "Observer auto-dispatch", description: "File plain observer findings without the do-not-auto-land marker.", defaultEnabled: false },
	{ key: "OMP_SQUAD_OBSERVE_AUTOFIX", label: "Observer autofix", description: "Let observer run safe housekeeping fixes such as reaping landed survivors.", defaultEnabled: false },
	{ key: "OMP_SQUAD_SCOUT", label: "Reasoning scout", description: "Harvest unresolved work items surfaced in agent reasoning.", defaultEnabled: true, restartRequired: true },
	{ key: "OMP_SQUAD_REGRESSION_GATE", label: "Regression gate", description: "Run the full suite on merged main after a land and block on any newly introduced failure.", defaultEnabled: true, restartRequired: false },
	{ key: "OMP_SQUAD_LAND_RISK_GATE", label: "Land blast-radius gate", description: "Block a large or sensitive-path diff from auto-landing unattended (leaves it for a human Land review).", defaultEnabled: false },
	{ key: "OMP_SQUAD_POLICY_RULES", label: "Runtime policy rules", description: "Enforce operator-defined deny/ask rules on agent tool calls (in addition to the built-in guardrails).", defaultEnabled: false },
	{ key: "OMP_SQUAD_LOOP_ARMED", label: "Convergence loop", description: "Arm the Stop-hook auto-continuation for a convergence run (armed per-process by the run entrypoint; never persisted to daemon env).", defaultEnabled: false, ephemeral: true },
	{ key: "OMP_SQUAD_MEMBRANE_PROFILES", label: "Membrane profile disciplines", description: "Let implementer-unit profiles opt into prompt-only output disciplines (membrane:verdict-first / membrane:minimal-code) via capability tokens. Double gate #2 — a profile still has to name the token itself; the auto-disable breaker (runMembraneBreaker) can flip this off on a measured success drop.", defaultEnabled: false },
	{ key: "OMP_SQUAD_PUSH_CASUAL_DONE", label: "Chat completion push", description: "Buzz your phone when a chat session (the console lane / glance here) finishes a turn — the reason to come back after stepping away. Approval/input alerts always fire regardless.", defaultEnabled: true },
	{ key: "OMP_SQUAD_PUSH_FLEET_DONE", label: "Fleet completion push", description: "Buzz your phone every time a dispatched fleet unit finishes. Off by default — a tracked unit completing is routine, and a busy fleet would page you constantly. Approval/input alerts always fire regardless.", defaultEnabled: false },
];

const FLAG_KEYS = new Set<string>(FEATURE_FLAGS.map((flag) => flag.key));
const SETTINGS_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
	return FLAG_KEYS.has(value);
}

export function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["0", "false", "off", "no"].includes(normalized)) return false;
	if (["1", "true", "on", "yes"].includes(normalized)) return true;
	return fallback;
}

function parseSnapshot(raw: unknown): RuntimeSettingsSnapshot {
	if (!isRecord(raw)) return { featureFlags: {} };
	const rawFlags = raw.featureFlags;
	const featureFlags: Partial<Record<FeatureFlagKey, boolean>> = {};
	if (isRecord(rawFlags)) {
		for (const [key, value] of Object.entries(rawFlags)) {
			if (isFeatureFlagKey(key) && typeof value === "boolean") featureFlags[key] = value;
		}
	}
	const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : undefined;
	return { featureFlags, updatedAt };
}

export function featureFlagStates(snapshot: RuntimeSettingsSnapshot = { featureFlags: {} }, env: NodeJS.ProcessEnv = process.env): FeatureFlagState[] {
	return FEATURE_FLAGS.map((flag) => {
		const persisted = snapshot.featureFlags[flag.key];
		const hasEnv = env[flag.key] !== undefined;
		return {
			...flag,
			enabled: persisted ?? boolFromEnv(env[flag.key], flag.defaultEnabled),
			source: persisted !== undefined ? "settings" : hasEnv ? "env" : "default",
		};
	});
}

/** Feature-flag keys that must NEVER be written into `process.env` from persisted settings (S1) —
 *  see `FeatureFlagDefinition.ephemeral`. Armed per-process by their owner, never globally. */
const EPHEMERAL_KEYS = new Set<string>(FEATURE_FLAGS.filter((f) => f.ephemeral).map((f) => f.key));

export function applyFeatureFlags(snapshot: RuntimeSettingsSnapshot, env: NodeJS.ProcessEnv = process.env): void {
	for (const [key, enabled] of Object.entries(snapshot.featureFlags)) {
		// Ephemeral flags (e.g. OMP_SQUAD_LOOP_ARMED) are surfaced/persisted for visibility but never
		// applied to the daemon's env — persisting an arm flag into every spawned agent would collapse
		// the convergence loop's dual gate to a single env gate (DESIGN.md §5).
		if (EPHEMERAL_KEYS.has(key)) continue;
		if (isFeatureFlagKey(key) && typeof enabled === "boolean") env[key] = enabled ? "1" : "0";
	}
}

export class RuntimeSettingsStore {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "settings.json");
	}

	async load(): Promise<RuntimeSettingsSnapshot> {
		try {
			const raw = await getStorageBackend().readText(this.file);
			return raw === undefined ? { featureFlags: {} } : parseSnapshot(JSON.parse(raw));
		} catch {
			return { featureFlags: {} };
		}
	}

	async save(snapshot: RuntimeSettingsSnapshot): Promise<void> {
		await writeFileDurable(this.file, JSON.stringify({ version: SETTINGS_VERSION, ...snapshot }, null, 2));
	}

	async states(): Promise<FeatureFlagState[]> {
		return featureFlagStates(await this.load());
	}

	async setFeatureFlag(key: FeatureFlagKey, enabled: boolean): Promise<FeatureFlagState[]> {
		const snapshot = await this.load();
		snapshot.featureFlags[key] = enabled;
		snapshot.updatedAt = Date.now();
		await this.save(snapshot);
		applyFeatureFlags(snapshot);
		return featureFlagStates(snapshot);
	}

	async apply(): Promise<RuntimeSettingsSnapshot> {
		const snapshot = await this.load();
		applyFeatureFlags(snapshot);
		return snapshot;
	}

	exists(): boolean {
		return getStorageBackend().exists(this.file);
	}
}

// ── Membrane profile-disciplines breaker (eap-borrows concern 05, DESIGN.md "Membrane measurement") ──
// A real (not ceremonial) auto-disable: compares a membrane-flagged cohort's `CellMetrics` against its
// taskClass's auto-champion baseline (both `task-class-matrix.ts` shapes — a caller builds `flagged` by
// restricting the matrix builder's inputs to flagged-cohort agentIds, e.g. via `unitEfficiencyFlags`),
// and — past a measured composite-success degradation — HARD-disables `OMP_SQUAD_MEMBRANE_PROFILES`
// through the same store every other runtime setting goes through. No consumer wires a live cadence
// call yet (mirrors DESIGN.md's "Scoreboard UI CUT for now — build the panel when there's a reader"):
// this is the pure check plus the one-shot disable action, ready for that caller.

/** Composite-success degradation floor (mergeRate percentage points) past which the breaker trips — a
 *  couple points of jitter is noise, mirroring `REWORK_EPS`'s role in task-class-matrix.ts. */
export const MEMBRANE_BREAKER_MIN_EDGE = 0.1;

/** Sample floor before the breaker is allowed to act at all — too few flagged units and a mergeRate
 *  delta is noise, not a signal (mirrors `MIN_SAMPLES`'s role in the `reproducible` gate). */
export const MEMBRANE_BREAKER_MIN_UNITS = 5;

export interface MembraneBreakerCheck {
	tripped: boolean;
	reason?: string;
}

/**
 * Pure check: does the flagged cohort's cell show a measured composite-success degradation against its
 * baseline? Batch-2 round-2 review fix: the ORIGINAL gate read `flagged.reproducible`/`baseline.reproducible`
 * — each cell's OWN bit, computed inside whatever doc it was built in. That's structurally inert for this
 * caller's shape: `membraneBreakerCadence` collapses the flagged cohort into a single-cell matrix doc, so
 * that cell's "champion" (the doc's only sample-sufficient cell) IS itself, and self-compared variance is
 * always false whenever the cohort's own mergeRate is saturated (0 or 1) — a catastrophic all-rejected
 * flagged cohort could never trip. Same failure the other direction: the live fleet's documented
 * saturated regime is `mergeRate` pinned at 1.0 (all collapsed outcomes are `landed`), which made the
 * baseline non-`reproducible` against itself too, silently defeating the vetoRate/inRunReworkRate arms in
 * production (red-team B C1).
 *
 * The fix drops the self-doc `reproducible` bits entirely and gates on the PAIR being compared: both
 * cells must be `isSampleSufficient` (the `n`-only floor — code-review finding #7 dropped the
 * cost-coverage requirement from this check entirely, since mergeRate/vetoRate/inRunReworkRate never
 * read cost; that requirement now lives in the separate `isCostReproducible`, which this caller has no
 * reason to call).
 *
 * `hasVarianceBetween(flagged, baseline)` — the CROSS-cell comparison — gates ONLY the mergeRate arm,
 * mirroring `flagEfficiencyRegression`'s exact precedent (task-class-matrix.ts): a "mergeRate dropped"
 * read off two cells both stuck at 0 or both stuck at 1 is a saturated tie, not a signal, but the
 * vetoRate/inRunReworkRate arms carry real information independent of where mergeRate sits (including
 * at a saturated 1.0-vs-1.0 tie) and must NOT be gated by it — that was exactly the "vetoRate/
 * inRunReworkRate arms can never fire in production" defect this fix closes. `minEdge` applies uniformly
 * across all three dimensions — a single extra veto in a small cohort is jitter, not a signal, but the
 * discipline's entire promise is a cost/token win, so ANY composite-success degradation past the noise
 * floor burns the bet, not just the dimension a caller happened to check first.
 */
export function checkMembraneBreaker(
	flagged: CellMetrics,
	baseline: CellMetrics,
	opts: { minEdge?: number; minUnits?: number; minSamples?: number } = {},
): MembraneBreakerCheck {
	const minEdge = opts.minEdge ?? MEMBRANE_BREAKER_MIN_EDGE;
	const minUnits = opts.minUnits ?? MEMBRANE_BREAKER_MIN_UNITS;
	const minSamples = opts.minSamples ?? MIN_SAMPLES;
	if (flagged.n < minUnits) return { tripped: false };
	if (!isSampleSufficient(flagged, minSamples) || !isSampleSufficient(baseline, minSamples)) return { tripped: false };

	const mergeDrop = baseline.mergeRate - flagged.mergeRate;
	if (hasVarianceBetween(flagged, baseline) && mergeDrop >= minEdge) {
		return { tripped: true, reason: `mergeRate dropped ${(mergeDrop * 100).toFixed(1)}pt vs baseline (n=${flagged.n})` };
	}
	if (flagged.vetoRate !== undefined && baseline.vetoRate !== undefined && flagged.vetoRate - baseline.vetoRate >= minEdge) {
		return { tripped: true, reason: `vetoRate rose from ${(baseline.vetoRate * 100).toFixed(1)}% to ${(flagged.vetoRate * 100).toFixed(1)}% (n=${flagged.n})` };
	}
	if (flagged.inRunReworkRate !== undefined && baseline.inRunReworkRate !== undefined && flagged.inRunReworkRate - baseline.inRunReworkRate >= minEdge) {
		return { tripped: true, reason: `inRunReworkRate rose from ${(baseline.inRunReworkRate * 100).toFixed(1)}% to ${(flagged.inRunReworkRate * 100).toFixed(1)}% (n=${flagged.n})` };
	}
	return { tripped: false };
}

/**
 * Runs the check and, on a trip, HARD-disables `OMP_SQUAD_MEMBRANE_PROFILES` via `store.setFeatureFlag`
 * (persists + applies to `process.env` immediately — the next profile resolution's
 * `agent-profiles.ts#membraneProfilesEnabled()` read sees it) and returns an `AttentionEvent` naming
 * what tripped. `undefined` on a healthy comparison — no state change, no event.
 */
export async function runMembraneBreaker(
	store: RuntimeSettingsStore,
	taskClass: string,
	flagged: CellMetrics,
	baseline: CellMetrics,
	opts: { minEdge?: number; minUnits?: number; minSamples?: number; now?: number } = {},
): Promise<AttentionEvent | undefined> {
	const result = checkMembraneBreaker(flagged, baseline, opts);
	if (!result.tripped) return undefined;
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", false);
	const now = opts.now ?? Date.now();
	return {
		id: `membrane-breaker:${taskClass}:${now}`,
		summary: `Membrane profile disciplines auto-disabled — measured success degradation on taskClass "${taskClass}"`,
		detail: result.reason,
		source: "notify",
		createdAt: now,
	};
}
