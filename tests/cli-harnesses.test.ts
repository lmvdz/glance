/**
 * `glance harnesses` CLI table (plans/eap-borrows concern 06): renders the tier fields the
 * GET /api/harnesses endpoint now carries, marks the operator's default harness, and degrades
 * cleanly when a row's tier fields are absent (old-shaped server, or a not-yet-computed tier).
 */

import { describe, expect, test } from "bun:test";
import { renderHarnessTable } from "../src/index.ts";

describe("renderHarnessTable", () => {
	test("renders tier, protocol, usage-verified bit, and marks the default harness", () => {
		const out = renderHarnessTable(
			[
				{ name: "omp", protocol: "omp-rpc", verified: true, tier: "verified", binDetected: true, usageVerified: true },
				{ name: "gemini", protocol: "acp", verified: false, tier: "registered-unverified", binDetected: false, usageVerified: false },
			],
			"omp",
		);
		expect(out).toContain("omp*"); // default harness marked
		expect(out).toContain("verified");
		expect(out).toContain("usage-verified");
		expect(out).toContain("gemini");
		expect(out).toContain("registered");
		expect(out).toContain("usage-unconfirmed");
	});

	test("surfaces the verified-binary-missing alert inline", () => {
		const out = renderHarnessTable([{ name: "claude-code", protocol: "acp", verified: true, tier: "verified", binDetected: false, usageVerified: false, alert: "claude-code: verified but \"npx\" was not found on the daemon PATH" }], "omp");
		expect(out).toContain("⚠");
		expect(out).toContain("not found on the daemon PATH");
	});

	test("empty roster and --json passthrough", () => {
		expect(renderHarnessTable([], "omp")).toBe("no harnesses registered\n");
		const rows = [{ name: "omp", protocol: "omp-rpc", verified: true, tier: "verified" as const }];
		expect(JSON.parse(renderHarnessTable(rows, "omp", { json: true }))).toEqual(rows);
	});
});
