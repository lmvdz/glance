import { afterEach, describe, expect, test } from "bun:test";
import type { Judge, LensJudge, LensVerifyJudge } from "../src/validator.ts";
import { lensConfig, validatorGate } from "../src/validator.ts";

const LENS_ENV = ["OMP_SQUAD_LENS_REVIEW", "OMP_SQUAD_LENS_MAX", "OMP_SQUAD_LENS_SET", "OMP_SQUAD_LENS_VERIFY", "OMP_SQUAD_LENS_TIMEOUT_MS"];
afterEach(() => {
	for (const k of LENS_ENV) delete process.env[k];
});

describe("lens flag surface (concern 06)", () => {
	test("everything defaults OFF/minimal", () => {
		expect(lensConfig()).toEqual({ review: false, max: 1, allow: undefined, verify: false, timeoutMs: 60_000 });
	});

	test("flags reflect the environment when set", () => {
		process.env.OMP_SQUAD_LENS_REVIEW = "1";
		process.env.OMP_SQUAD_LENS_MAX = "2";
		process.env.OMP_SQUAD_LENS_SET = "regression";
		process.env.OMP_SQUAD_LENS_VERIFY = "1";
		process.env.OMP_SQUAD_LENS_TIMEOUT_MS = "30000";
		expect(lensConfig()).toEqual({ review: true, max: 2, allow: ["regression"], verify: true, timeoutMs: 30_000 });
	});

	test("an unknown lens in OMP_SQUAD_LENS_SET is filtered out", () => {
		process.env.OMP_SQUAD_LENS_SET = "regression,bogus";
		expect(lensConfig().allow).toEqual(["regression"]);
	});
});

describe("default-off contract", () => {
	// The load-bearing guarantee: with the feature at defaults, NO lens or verify judge is ever invoked
	// from the land gate — even with the VERIFY sub-flag turned on (it is unreachable without the master).
	const repo = process.cwd();
	const passJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c) => ({ id: c.id, satisfied: true })) });

	test("master flag unset ⇒ zero lens + zero verify spawns, even with VERIFY=1", async () => {
		process.env.OMP_SQUAD_LENS_VERIFY = "1"; // sub-flag on, master OFF
		let lensCalls = 0;
		let verifyCalls = 0;
		const lensJudge = () => (async () => {
			lensCalls++;
			return undefined;
		}) as LensJudge;
		const lensVerifyJudge = () => (async () => {
			verifyCalls++;
			return true;
		}) as LensVerifyJudge;
		await validatorGate({ criteria: [{ id: "c1", text: "x", completed: false }], repo, worktree: repo, judge: passJudge, lensJudge, lensVerifyJudge });
		expect(lensCalls).toBe(0);
		expect(verifyCalls).toBe(0);
	});

	test("OMP_SQUAD_LENS_MAX=0 ⇒ no lens fires even with the master flag on (via lensConfig)", () => {
		process.env.OMP_SQUAD_LENS_REVIEW = "1";
		process.env.OMP_SQUAD_LENS_MAX = "0";
		expect(lensConfig()).toMatchObject({ review: true, max: 0 });
	});
});
