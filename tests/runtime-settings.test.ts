import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeSettingsStore, applyFeatureFlags, boolFromEnv, featureFlagStates } from "../src/runtime-settings.ts";

const ENV_KEYS = ["OMP_SQUAD_OBSERVE_AUTOFIX", "OMP_SQUAD_AUTODISPATCH", "OMP_SQUAD_LOOP_ARMED"] as const;
const savedEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("boolFromEnv accepts common off/on spellings", () => {
	expect(boolFromEnv(undefined, true)).toBe(true);
	expect(boolFromEnv("0", true)).toBe(false);
	expect(boolFromEnv("false", true)).toBe(false);
	expect(boolFromEnv("1", false)).toBe(true);
	expect(boolFromEnv("yes", false)).toBe(true);
});

test("featureFlagStates prefers persisted settings over env", () => {
	process.env.OMP_SQUAD_AUTODISPATCH = "0";
	const states = featureFlagStates({ featureFlags: { OMP_SQUAD_AUTODISPATCH: true } });
	const dispatch = states.find((flag) => flag.key === "OMP_SQUAD_AUTODISPATCH");
	expect(dispatch?.enabled).toBe(true);
	expect(dispatch?.source).toBe("settings");
});

test("RuntimeSettingsStore persists a flag and applies it to process.env", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-"));
	const store = new RuntimeSettingsStore(dir);
	const states = await store.setFeatureFlag("OMP_SQUAD_OBSERVE_AUTOFIX", true);
	const autofix = states.find((flag) => flag.key === "OMP_SQUAD_OBSERVE_AUTOFIX");
	const raw = JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));

	expect(autofix?.enabled).toBe(true);
	expect(autofix?.source).toBe("settings");
	expect(process.env.OMP_SQUAD_OBSERVE_AUTOFIX).toBe("1");
	expect(raw).toMatchObject({ version: 1, featureFlags: { OMP_SQUAD_OBSERVE_AUTOFIX: true } });
});

test("applyFeatureFlags ignores unknown persisted keys", () => {
	applyFeatureFlags({ featureFlags: { OMP_SQUAD_OBSERVE_AUTOFIX: false } });
	expect(process.env.OMP_SQUAD_OBSERVE_AUTOFIX).toBe("0");
});

test("applyFeatureFlags NEVER writes the ephemeral OMP_SQUAD_LOOP_ARMED into env (S1 — no daemon leak)", () => {
	delete process.env.OMP_SQUAD_LOOP_ARMED;
	// Even a persisted true must not arm the daemon (and thus every spawned agent) — the convergence
	// loop's dual gate would collapse to a single env gate. The flag is armed strictly per-process by
	// src/convergence-run.ts, never applied from persisted settings here.
	applyFeatureFlags({ featureFlags: { OMP_SQUAD_LOOP_ARMED: true } });
	expect(process.env.OMP_SQUAD_LOOP_ARMED).toBeUndefined();
});

test("OMP_SQUAD_LOOP_ARMED is still SURFACED in the settings states (visible, just not env-applied)", () => {
	const states = featureFlagStates();
	const loop = states.find((flag) => flag.key === "OMP_SQUAD_LOOP_ARMED");
	expect(loop).toBeDefined();
	expect(loop?.ephemeral).toBe(true);
	expect(loop?.defaultEnabled).toBe(false);
});

test("RuntimeSettingsStore.setFeatureFlag persists the ephemeral flag but does NOT apply it to env", async () => {
	delete process.env.OMP_SQUAD_LOOP_ARMED;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-ephemeral-"));
	const store = new RuntimeSettingsStore(dir);
	const states = await store.setFeatureFlag("OMP_SQUAD_LOOP_ARMED", true);
	const loop = states.find((flag) => flag.key === "OMP_SQUAD_LOOP_ARMED");
	const raw = JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));

	expect(loop?.enabled).toBe(true); // reflected in the surface
	expect(raw).toMatchObject({ featureFlags: { OMP_SQUAD_LOOP_ARMED: true } }); // persisted
	expect(process.env.OMP_SQUAD_LOOP_ARMED).toBeUndefined(); // but never applied to daemon env
});
