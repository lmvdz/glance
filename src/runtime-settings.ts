import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileDurable } from "./dal/store.ts";

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
	| "OMP_SQUAD_LOOP_ARMED";

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
	{ key: "OMP_SQUAD_LOOP_ARMED", label: "Convergence loop", description: "Arm the Stop-hook auto-continuation for a convergence run (armed per-process by the run entrypoint; never persisted to daemon env).", defaultEnabled: false, ephemeral: true },
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
			return parseSnapshot(JSON.parse(await fs.readFile(this.file, "utf8")));
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
		return existsSync(this.file);
	}
}
