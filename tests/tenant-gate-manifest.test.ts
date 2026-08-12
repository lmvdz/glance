import { expect, test, describe } from "bun:test";
import { greenGateUnproven, gateRunUnrunnable } from "../src/gate-runner.ts";
import {
	decodeTenantGateManifest,
	evaluateGateRun,
	manifestCommand,
	manifestHash,
	manifestNeedsDocker,
	manifestStages,
	manifestStrict,
	readGateEvidence,
	refusalIsEnvironmental,
	suggestTenantGateManifest,
	type TenantGate,
	type TenantGateManifest,
} from "../src/tenant-gates.ts";

/**
 * The CONTRACT half of glance#393. Everything here is pure: no docker, no repo, no daemon — which is
 * the point of splitting the schema/evaluation out of the runner. The runner's fail-closed rows live
 * in tests/tenant-gate-fail-closed.test.ts.
 */

function manifest(gates: TenantGate[], extra: Partial<TenantGateManifest> = {}): unknown {
	return { version: 1, repo: "/repo", gates, ...extra };
}

const okGate: TenantGate = { name: "test", command: "bun test", timeoutMs: 1000, expects: { exit: 0, parser: "bun-test", minTests: 5 } };

describe("schema", () => {
	test("decodes a well-formed manifest and strips unknown keys", () => {
		const r = decodeTenantGateManifest(manifest([okGate], { _readme: "not part of the contract" } as Partial<TenantGateManifest>));
		expect("manifest" in r).toBe(true);
		if (!("manifest" in r)) throw new Error("unreachable");
		expect(r.manifest.gates).toHaveLength(1);
		expect(r.manifest).not.toHaveProperty("_readme");
	});

	test("an unknown version fails the decode — a future contract shape must not be half-read", () => {
		const r = decodeTenantGateManifest(manifest([okGate], { version: 2 } as unknown as Partial<TenantGateManifest>));
		expect("error" in r).toBe(true);
	});

	test("a manifest with zero gates is rejected — 'registered but gating nothing' is the fail-open", () => {
		const r = decodeTenantGateManifest(manifest([]));
		expect("error" in r && r.error).toContain("zero gates");
	});

	test("count assertions under parser 'raw' are a DECODE ERROR, never a silently ignored field", () => {
		const r = decodeTenantGateManifest(manifest([{ name: "t", command: "x", timeoutMs: 1, expects: { exit: 0, parser: "raw", minTests: 3 } }]));
		expect("error" in r && r.error).toContain("could never be evaluated");
	});

	test("exactCounts outside a counts-script gate is rejected for the same reason", () => {
		const r = decodeTenantGateManifest(manifest([{ name: "t", command: "x", timeoutMs: 1, expects: { exit: 0, parser: "bun-test", exactCounts: { rows: 3 } } }]));
		expect("error" in r && r.error).toContain("only \"counts-script\"");
	});

	test("duplicate gate names are rejected — per-gate receipts would collide", () => {
		const r = decodeTenantGateManifest(manifest([okGate, { ...okGate }]));
		expect("error" in r && r.error).toContain("duplicate gate name");
	});

	test("H-4: expects.exit other than 0 is a DECODE ERROR — fail-closed has one passing exit code", () => {
		const r = decodeTenantGateManifest(manifest([{ name: "t", command: "x", timeoutMs: 1, expects: { exit: 1, parser: "raw" } }]));
		expect("error" in r && r.error).toContain("only exit 0");
	});
});

describe("identity", () => {
	const base = decodeTenantGateManifest(manifest([okGate]));
	if (!("manifest" in base)) throw new Error("fixture must decode");

	test("the hash is stable across key order and independent of registration provenance", () => {
		const reordered = decodeTenantGateManifest({ gates: [okGate], repo: "/repo", version: 1 });
		if (!("manifest" in reordered)) throw new Error("unreachable");
		expect(manifestHash(reordered.manifest)).toBe(manifestHash(base.manifest));

		const reapproved = decodeTenantGateManifest(manifest([okGate], { registeredBy: "someone-else", registeredAt: 123 }));
		if (!("manifest" in reapproved)) throw new Error("unreachable");
		expect(manifestHash(reapproved.manifest)).toBe(manifestHash(base.manifest));
	});

	test("tightening a count CHANGES the hash — a receipt cannot claim a contract it did not pass", () => {
		const tighter = decodeTenantGateManifest(manifest([{ ...okGate, expects: { ...okGate.expects, minTests: 6 } }]));
		if (!("manifest" in tighter)) throw new Error("unreachable");
		expect(manifestHash(tighter.manifest)).not.toBe(manifestHash(base.manifest));
	});

	test("stages, joined command, docker need, and strict default", () => {
		expect(manifestStages(base.manifest)).toEqual([{ name: "test", command: "bun test" }]);
		expect(manifestCommand(base.manifest)).toBe("bun test");
		expect(manifestNeedsDocker(base.manifest)).toBe(false);
		// A REGISTERED manifest is strict unless it opts out — the inverse of the daemon-global knob
		// nobody ever opted into.
		expect(manifestStrict(base.manifest)).toBe(true);
		const lax = decodeTenantGateManifest(manifest([okGate], { policy: { sandboxStrict: false } }));
		if (!("manifest" in lax)) throw new Error("unreachable");
		expect(manifestStrict(lax.manifest)).toBe(false);
	});
});

describe("parser-aware evidence", () => {
	test("bun-test: sums pass+fail, and reads both nothing-ran phrasings as ZERO (not unknown)", () => {
		expect(readGateEvidence("bun-test", " 12 pass\n 1 fail\n").tests).toBe(13);
		expect(readGateEvidence("bun-test", "Ran 0 tests across 0 files.").tests).toBe(0);
		expect(readGateEvidence("bun-test", "error: the glob did not match any test files").tests).toBe(0);
		// No marker at all is UNKNOWN, which is a different refusal from proven-zero.
		expect(readGateEvidence("bun-test", "some unrelated output").tests).toBeUndefined();
	});

	test("vitest: passed+failed only, and --passWithNoTests as ZERO", () => {
		expect(readGateEvidence("vitest", "\n Tests  1 failed | 11 passed (12)\n").tests).toBe(12);
		expect(readGateEvidence("vitest", "\n Tests  7 passed\n").tests).toBe(7);
		expect(readGateEvidence("vitest", "No test files found, exiting with code 0").tests).toBe(0);
	});

	test("H-3: vitest EXCLUDES skipped/todo — 'Tests 2 skipped' ran nothing, not 2", () => {
		// The `(N)` total folds skipped in; counting it would let a suite that ran nothing pass minTests.
		expect(readGateEvidence("vitest", "\n Tests  2 skipped (2)\n").tests).toBe(0);
		expect(readGateEvidence("vitest", "\n Tests  1 failed | 9 passed | 3 skipped (13)\n").tests).toBe(10);
		expect(readGateEvidence("vitest", "\n Tests  5 passed | 2 todo (7)\n").tests).toBe(5);
	});

	test("H-3: zero-markers are read BEFORE any positive line — a stale 'passed' does not win", () => {
		// A run that ultimately found no test files but whose scrollback carries an earlier summary must
		// read as ZERO, not as the stale number.
		expect(readGateEvidence("vitest", " Tests  3 passed (3)\n...\nNo test files found, exiting with code 0\n").tests).toBe(0);
		expect(readGateEvidence("bun-test", " 3 pass\n...\nRan 0 tests across 0 files.\n").tests).toBe(0);
	});

	test("H-3: bun-test excludes skip — '2 skip' is not counted as ran", () => {
		expect(readGateEvidence("bun-test", " 5 pass\n 2 skip\n 1 fail\n").tests).toBe(6);
	});

	test("counts-script: named counts from `name=n` / `name: n` lines", () => {
		const e = readGateEvidence("counts-script", "migrations=17\nroutes: 42\nnoise\n");
		expect(e.counts).toEqual({ migrations: 17, routes: 42 });
	});

	test("raw reads nothing — the exit code is the whole assertion", () => {
		expect(readGateEvidence("raw", " 12 pass ")).toEqual({});
	});
});

describe("evaluateGateRun — one row per way a contract can be broken", () => {
	const gate = okGate;

	test("green with enough tests passes", () => {
		expect(evaluateGateRun(gate, { code: 0, output: " 9 pass\n" })).toBeUndefined();
	});

	test("non-zero exit → gate-red", () => {
		expect(evaluateGateRun(gate, { code: 1, output: " 9 pass\n" })?.code).toBe("gate-red");
	});

	test("H-4: exit 127 (missing binary) → command-unregistered (environmental), NOT gate-red", () => {
		expect(evaluateGateRun(gate, { code: 127, output: "vitest: not found" })?.code).toBe("command-unregistered");
		// A non-127 exit whose output shows an executable-resolution failure is classed the same way.
		expect(evaluateGateRun(gate, { code: 1, output: "Executable not found in $PATH: vitest" })?.code).toBe("command-unregistered");
	});

	test("H-3: a bun-test/vitest gate with NO explicit minTests still requires positive evidence", () => {
		const noFloor: TenantGate = { name: "unit", command: "vitest", timeoutMs: 1, expects: { exit: 0, parser: "vitest" } };
		expect(evaluateGateRun(noFloor, { code: 0, output: "No test files found" })?.code).toBe("zero-tests");
		expect(evaluateGateRun(noFloor, { code: 0, output: " Tests  1 passed (1)\n" })).toBeUndefined();
		// `raw` opts out — its exit code is the whole assertion.
		const raw: TenantGate = { name: "lint", command: "biome ci", timeoutMs: 1, expects: { exit: 0, parser: "raw" } };
		expect(evaluateGateRun(raw, { code: 0, output: "" })).toBeUndefined();
	});

	test("exit 0 having run ZERO tests → zero-tests (not gate-red, not a pass)", () => {
		expect(evaluateGateRun(gate, { code: 0, output: "Ran 0 tests across 0 files." })?.code).toBe("zero-tests");
	});

	test("exit 0 with too few tests → count-violated", () => {
		const r = evaluateGateRun(gate, { code: 0, output: " 2 pass\n" });
		expect(r?.code).toBe("count-violated");
		expect(r?.reason).toContain("executed 2 tests");
	});

	test("exit 0 with an unreadable count → count-unreadable, never a silent pass", () => {
		expect(evaluateGateRun(gate, { code: 0, output: "done." })?.code).toBe("count-unreadable");
	});

	test("a degraded sandbox refuses BEFORE the exit code is even consulted, in both directions", () => {
		expect(evaluateGateRun(gate, { code: 0, output: " 99 pass\n", degraded: true })?.code).toBe("degraded-sandbox");
		expect(evaluateGateRun(gate, { code: 1, output: "boom", degraded: true })?.code).toBe("degraded-sandbox");
	});

	test("exactCounts: a wrong count and an absent count are DIFFERENT refusals", () => {
		const counts: TenantGate = { name: "ci", command: "node scripts/assert-counts.mjs", timeoutMs: 1, expects: { exit: 0, parser: "counts-script", exactCounts: { migrations: 17 } } };
		expect(evaluateGateRun(counts, { code: 0, output: "migrations=16\n" })?.code).toBe("count-violated");
		expect(evaluateGateRun(counts, { code: 0, output: "routes=3\n" })?.code).toBe("count-unreadable");
		expect(evaluateGateRun(counts, { code: 0, output: "migrations=17\n" })).toBeUndefined();
	});

	test("every refusal code sorts into environment-vs-code, so a phantom regression is never filed", () => {
		expect(refusalIsEnvironmental("service-unavailable")).toBe(true);
		expect(refusalIsEnvironmental("runner-unavailable")).toBe(true);
		expect(refusalIsEnvironmental("command-unregistered")).toBe(true);
		expect(refusalIsEnvironmental("gate-red")).toBe(false);
		expect(refusalIsEnvironmental("count-violated")).toBe(false);
	});
});

describe("the classifiers stop being bun-shaped (R2 #384 fail-open #4)", () => {
	// THE MUTATION: a Vitest suite run with --passWithNoTests. It exits 0, executes nothing, and
	// carries neither of bun's markers. This is the exact shape that used to land unverified.
	const passWithNoTests = { code: 0, output: "\n No test files found, exiting with code 0\n" };

	test("without a declared parser the old bun-only behavior is byte-identical — and blind to Vitest", () => {
		expect(greenGateUnproven(passWithNoTests, "pnpm test")).toBeUndefined();
	});

	test("with the contract's parser it is caught", () => {
		expect(greenGateUnproven(passWithNoTests, "pnpm test", "vitest")).toContain("executed zero tests");
	});

	test("the command-name sniff is dropped under a declared parser — tenant gates are not called 'test'", () => {
		// `\btest\b` never matched `ci:counts`, so the zero-tests check silently exempted it.
		expect(greenGateUnproven(passWithNoTests, "pnpm ci:counts")).toBeUndefined();
		expect(greenGateUnproven(passWithNoTests, "pnpm ci:counts", "vitest")).toContain("executed zero tests");
	});

	test("a real Vitest pass is still trusted (the check is not just 'always refuse')", () => {
		expect(greenGateUnproven({ code: 0, output: " Tests  11 passed (11)\n" }, "pnpm test", "vitest")).toBeUndefined();
	});

	test("the red-side classifier is parser-aware too, and a real red is still judged on its failures", () => {
		expect(gateRunUnrunnable({ code: 1, output: "No test files found" }, "pnpm test", "vitest")).toContain("executed zero tests");
		expect(gateRunUnrunnable({ code: 1, output: " Tests  1 failed | 10 passed (11)\n" }, "pnpm test", "vitest")).toBeUndefined();
	});
});

test("detection becomes a SUGGESTION: draft gates, and deliberately no invented counts", async () => {
	const suggestion = await suggestTenantGateManifest(process.cwd());
	expect(suggestion).toBeDefined();
	expect(suggestion?.gates.length).toBeGreaterThan(0);
	// Detection cannot know how many tests a repo has; inventing a number would be the fabrication the
	// contract exists to prevent. A human adds the counts — that act IS the registration.
	for (const g of suggestion!.gates) {
		expect(g.expects.parser).toBe("raw");
		expect(g.expects.minTests).toBeUndefined();
	}
	// And the draft must itself be a valid contract, or "suggest" would hand a human something unusable.
	expect("manifest" in decodeTenantGateManifest(suggestion)).toBe(true);
});
