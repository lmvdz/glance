import { describe, expect, test } from "bun:test";
import type { LensVerdict } from "../src/types.ts";
import type { LensVerifyJudge } from "../src/validator.ts";
import { runLensVerify } from "../src/validator.ts";

const v = (disposition: "accept" | "object", severity: "low" | "high", claim = "x"): LensVerdict => ({ lens: "regression", disposition, severity, claim });
const verifyMake = (result: boolean | undefined): (() => LensVerifyJudge) => () => async () => result;
const throwingVerify: () => LensVerifyJudge = () => async () => {
	throw new Error("verify exploded");
};

describe("runLensVerify (concern 05)", () => {
	test("high-severity objection + confirming re-check ⇒ {confirmed:true}", async () => {
		const out = await runLensVerify([v("object", "high", "secret logged")], "diff", undefined, verifyMake(true));
		expect(out).toEqual({ lens: "regression", claim: "secret logged", confirmed: true });
	});

	test("high-severity objection + refuting re-check ⇒ {confirmed:false}", async () => {
		expect(await runLensVerify([v("object", "high")], "diff", undefined, verifyMake(false))).toMatchObject({ confirmed: false });
	});

	test("re-check couldn't determine (undefined) ⇒ confirmed:false (fail-open, no escalation)", async () => {
		expect(await runLensVerify([v("object", "high")], "diff", undefined, verifyMake(undefined))).toMatchObject({ confirmed: false });
	});

	test("re-check throws ⇒ confirmed:false, never propagates", async () => {
		const call = runLensVerify([v("object", "high")], "diff", undefined, throwingVerify);
		await expect(call).resolves.toMatchObject({ confirmed: false });
	});

	test("a LOW objection triggers no re-check (undefined, judge never called)", async () => {
		let called = 0;
		const spy: () => LensVerifyJudge = () => async () => {
			called++;
			return true;
		};
		expect(await runLensVerify([v("object", "low")], "diff", undefined, spy)).toBeUndefined();
		expect(called).toBe(0);
	});

	test("an all-accept panel triggers no re-check", async () => {
		let called = 0;
		const spy: () => LensVerifyJudge = () => async () => {
			called++;
			return true;
		};
		expect(await runLensVerify([v("accept", "low")], "diff", undefined, spy)).toBeUndefined();
		expect(called).toBe(0);
	});

	test("targets the FIRST high-severity objection when several exist", async () => {
		const out = await runLensVerify([v("accept", "low"), v("object", "high", "first"), v("object", "high", "second")], "diff", undefined, verifyMake(true));
		expect(out?.claim).toBe("first");
	});
});
