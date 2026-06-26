import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeSettingsStore, applyFeatureFlags, boolFromEnv, featureFlagStates } from "../src/runtime-settings.ts";

const ENV_KEYS = ["OMP_SQUAD_OBSERVE_AUTOFIX", "OMP_SQUAD_AUTODISPATCH"] as const;
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
