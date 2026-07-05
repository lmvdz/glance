/**
 * Compliance evaluator (Epic 3, leaf 05) — pure policy checks over injected fake ledgers, no disk.
 * Covers the three v1 policies (forced-land-without-proof, validator-override, land-repeatedly-
 * failing) plus the empty-ledgers and optional-dep (pre-leaf-03 callers) edges.
 */

import { expect, test } from "bun:test";
import { evaluateCompliance, forcedLandFindings, landRepeatedlyFailingFindings, validatorOverrideFindings } from "../src/compliance.ts";
import type { ForcedLand, LandLedger, ValidatorOverride } from "../src/land-ledger.ts";

test("forcedLandFindings: one ForcedLand ⇒ a high forced-land-without-proof finding naming branch + actor", () => {
	const forced: ForcedLand[] = [{ branch: "squad/a1", actor: "operator@local", detail: "no proof", at: 5 }];
	const findings = forcedLandFindings(forced, 999);
	expect(findings).toHaveLength(1);
	expect(findings[0].code).toBe("forced-land-without-proof");
	expect(findings[0].severity).toBe("high");
	expect(findings[0].subject).toBe("squad/a1");
	expect(findings[0].detail).toContain("operator@local");
	expect(findings[0].at).toBe(5);
});

test("validatorOverrideFindings: one ValidatorOverride ⇒ a structural finding including the reason class", () => {
	const overrides: ValidatorOverride[] = [{ branch: "squad/b1", actor: "op", reasonClass: "judge-hallucination", detail: "misread", at: 7 }];
	const findings = validatorOverrideFindings(overrides, 999);
	expect(findings).toHaveLength(1);
	expect(findings[0].code).toBe("validator-override");
	expect(findings[0].severity).toBe("structural");
	expect(findings[0].detail).toContain("judge-hallucination");
});

test("landRepeatedlyFailingFindings: a LandLedger entry with fails:4 (cap 3) ⇒ a high finding", () => {
	const ledger: LandLedger = {
		"squad/a1": { fails: 4, lastDetail: "gate red", at: 1 },
		"squad/a2": { fails: 1, lastDetail: "x", at: 1 }, // under cap ⇒ no finding
	};
	const findings = landRepeatedlyFailingFindings(ledger, 3, 999);
	expect(findings.map((f) => f.subject)).toEqual(["squad/a1"]);
	expect(findings[0].code).toBe("land-repeatedly-failing");
	expect(findings[0].severity).toBe("high");
});

test("evaluateCompliance: empty ledgers ⇒ []", async () => {
	const findings = await evaluateCompliance({
		readAudit: async () => [],
		forcedLands: () => [],
		validatorOverrides: () => [],
		landLedger: () => ({}),
	});
	expect(findings).toEqual([]);
});

test("evaluateCompliance: composes all three policies over injected deps", async () => {
	const findings = await evaluateCompliance({
		readAudit: async () => [],
		forcedLands: () => [{ branch: "squad/a1", actor: "op", detail: "d", at: 1 }],
		validatorOverrides: () => [{ branch: "squad/b1", actor: "op", reasonClass: "emergency", detail: "d", at: 2 }],
		landLedger: () => ({ "squad/c1": { fails: 5, lastDetail: "d", at: 3 } }),
		now: () => 100,
	});
	expect(findings.map((f) => f.code).sort()).toEqual(["forced-land-without-proof", "land-repeatedly-failing", "validator-override"]);
});

test("evaluateCompliance: the validator-override policy is skipped when the dep is absent (pre-leaf-03 callers)", async () => {
	const findings = await evaluateCompliance({
		readAudit: async () => [],
		forcedLands: () => [],
		landLedger: () => ({}),
		// validatorOverrides intentionally omitted
	});
	expect(findings).toEqual([]);
});
