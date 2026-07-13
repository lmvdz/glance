/**
 * Verified-state oracle (Epic 7, leaf 01) — the disk contract src/convergence-oracle.ts owns.
 * Tests live under tests/ (not src/), matching this repo's bunfig.toml `[test] root = "tests"`
 * (every other suite in the repo follows the same convention — see e.g. tests/state-dir.test.ts,
 * tests/automation-log.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { arm, armPath, convergenceDir, disarm, failuresPath, isArmed, oraclePath, readFailures, readOracle, writeFailures, writeOracle } from "../src/convergence-oracle.ts";
import type { VerifiedState } from "../src/types.ts";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "convergence-oracle-"));
}

function sample(overrides: Partial<VerifiedState> = {}): VerifiedState {
	return {
		goalId: "plans/demo",
		iteration: 3,
		gap: 2,
		epsilon: 0,
		pendingEscalation: false,
		budget: { spent: 3, cap: 50 },
		decision: "continue",
		updatedAt: 1234,
		...overrides,
	};
}

describe("writeOracle / readOracle", () => {
	test("round-trips a VerifiedState unchanged", async () => {
		const dir = tmp();
		try {
			const state = sample();
			await writeOracle(state, dir);
			expect(await readOracle(dir)).toEqual(state);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readOracle returns null for a missing file", async () => {
		const dir = tmp();
		try {
			expect(await readOracle(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readOracle returns null for a corrupt (non-JSON) file", async () => {
		const dir = tmp();
		try {
			await Bun.write(oraclePath(dir), "not json {{{");
			expect(await readOracle(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("oraclePath resolves under the given state dir", () => {
		const dir = tmp();
		try {
			expect(oraclePath(dir)).toBe(path.join(dir, "convergence", "oracle.json"));
			expect(oraclePath(dir).startsWith(dir)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a second write overwrites the first (still atomic, no partial reads)", async () => {
		const dir = tmp();
		try {
			await writeOracle(sample({ iteration: 1 }), dir);
			await writeOracle(sample({ iteration: 2 }), dir);
			expect((await readOracle(dir))?.iteration).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("arm / disarm / isArmed", () => {
	test("arm sets isArmed true; disarm sets it back to false", async () => {
		const dir = tmp();
		try {
			expect(isArmed(dir)).toBe(false);
			await arm(dir);
			expect(isArmed(dir)).toBe(true);
			await disarm(dir);
			expect(isArmed(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("disarm on an absent sentinel does not throw", async () => {
		const dir = tmp();
		try {
			await expect(disarm(dir)).resolves.toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("armPath resolves under the given state dir", () => {
		const dir = tmp();
		try {
			expect(armPath(dir)).toBe(path.join(dir, "convergence", "armed"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("arm() stamps the sentinel with the given session identity (S1), default empty", async () => {
		const dir = tmp();
		try {
			await arm(dir, "session-A");
			expect(readFileSync(armPath(dir), "utf8")).toBe("session-A");
			await arm(dir); // default identity is empty (presence-gated, backward compatible)
			expect(readFileSync(armPath(dir), "utf8")).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("convergenceDir", () => {
	test("defaults to resolveStateDir() when no stateDir is passed", () => {
		// tests/setup.ts pins OMP_SQUAD_STATE_DIR for the whole suite.
		expect(convergenceDir()).toBe(path.join(process.env.OMP_SQUAD_STATE_DIR!, "convergence"));
	});
});

describe("readFailures / writeFailures (eap-borrows finding #16)", () => {
	test("no sidecar yet ⇒ null (the legitimate baseline turn)", async () => {
		const dir = tmp();
		try {
			expect(await readFailures(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("round-trips a written failure set", async () => {
		const dir = tmp();
		try {
			await writeFailures(["a.test.ts > x", "b.test.ts > y"], dir);
			expect(await readFailures(dir)).toEqual(["a.test.ts > x", "b.test.ts > y"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Reproduce-first: the OLD `readFailures` mapped ANY read/parse error to `null` — INDISTINGUISHABLE
	// from "no prior turn". A corrupt sidecar silently became this turn's fresh baseline, discarding
	// whatever real prior failure set the ratchet needed to compare against.
	test("a corrupt sidecar (bad JSON) THROWS — never silently collapses to the baseline null", async () => {
		const dir = tmp();
		try {
			await Bun.write(failuresPath(dir), "{ not json at all");
			await expect(readFailures(dir)).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a sidecar that parses but isn't an array THROWS too", async () => {
		const dir = tmp();
		try {
			await Bun.write(failuresPath(dir), JSON.stringify({ not: "an array" }));
			await expect(readFailures(dir)).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
