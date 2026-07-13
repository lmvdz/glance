/**
 * Shared fail-closed taxonomy (plans/eap-borrows/04-fail-closed-wave-1.md) — pure classification,
 * no I/O. Exercised directly here; each call site (land-risk.ts, observer.ts, convergence-run.ts,
 * convergence-oracle.ts) has its own reproduce-first test for the WIRING, not the classification.
 */

import { expect, test } from "bun:test";
import { classifyProbeFailure } from "../src/classify-probe-failure.ts";

test("structural kinds (corrupt-state, unparseable, missing-command) always escalate and are never retryable", () => {
	for (const kind of ["corrupt-state", "unparseable", "missing-command"] as const) {
		const r = classifyProbeFailure({ kind, detail: "boom" });
		expect(r.retryable).toBe(false);
		expect(r.escalate).toBe(true);
		expect(r.reason).toBe(`${kind}: boom`);
	}
});

test("structural kinds ignore any supplied attempt budget — still non-retryable", () => {
	const r = classifyProbeFailure({ kind: "corrupt-state", detail: "boom", attempt: 1, maxAttempts: 5 });
	expect(r.retryable).toBe(false);
	expect(r.escalate).toBe(true);
});

test("spawn-error with NO budget escalates on the first failure (no free retry)", () => {
	const r = classifyProbeFailure({ kind: "spawn-error", detail: "ECONNRESET" });
	expect(r.retryable).toBe(false);
	expect(r.escalate).toBe(true);
	expect(r.reason).toBe("spawn-error: ECONNRESET");
});

test("spawn-error WITH a bounded budget is retryable until the budget is exhausted", () => {
	const first = classifyProbeFailure({ kind: "spawn-error", detail: "ECONNRESET", attempt: 1, maxAttempts: 3 });
	expect(first.retryable).toBe(true);
	expect(first.escalate).toBe(false);
	expect(first.reason).toContain("attempt 1/3, retrying");

	const last = classifyProbeFailure({ kind: "spawn-error", detail: "ECONNRESET", attempt: 3, maxAttempts: 3 });
	expect(last.retryable).toBe(false);
	expect(last.escalate).toBe(true);
	expect(last.reason).toContain("attempt budget exhausted");
});
