/**
 * Comprehension fog (plans/comprehension/03-fog-computation.md, src/comprehension-fog.ts): pure
 * unit tests for the monotone debt formula, tri-state boundaries, log-bucket bounds, repo-filter
 * join safety, and repo-level cold-start honesty. The monotone property is the contract this concern
 * exists to enforce — DESIGN.md's rejected draft formula self-cleared via heat decay, so every test
 * that varies `now` alone must show debt is UNCHANGED, and the only two events that ever move debt
 * are "a new completed receipt" (raises it) and "a fresher view" (resets it).
 */

import { describe, expect, test } from "bun:test";
import { computeFog, DEBT_LOG_DIVISOR, repoHasHistory, SURPRISE_BOOST, topDebt, type FileFogEntry } from "../src/comprehension-fog.ts";
import type { SeenMap } from "../src/attention.ts";
import type { RunReceipt } from "../src/types.ts";

let seq = 0;
function receipt(overrides: Partial<RunReceipt> & Pick<RunReceipt, "repo" | "filesTouched">): RunReceipt {
	seq++;
	return {
		agentId: `agent-${seq}`,
		name: `agent-${seq}`,
		runId: `run-${seq}`,
		startedAt: 0,
		status: "idle",
		toolCalls: 1,
		toolTally: {},
		...overrides,
	};
}

function seenAt(repo: string, file: string, lastSeenAt: number): SeenMap {
	return { [`${repo}\0${file}`]: { lastSeenAt } };
}

describe("computeFog: monotone debt", () => {
	test("a new completed receipt after a view RAISES debt", () => {
		const seen = seenAt("/r", "a.ts", 100);
		const before = computeFog({ receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 50 })], seen, repos: ["/r"], now: 1000 });
		expect(before.find((e) => e.file === "a.ts")?.debt ?? 0).toBe(0); // receipt predates the view

		const after = computeFog({
			receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 50 }), receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 200 })],
			seen,
			repos: ["/r"],
			now: 1000,
		});
		const entry = after.find((e) => e.file === "a.ts");
		expect(entry?.changesSinceSeen).toBe(1);
		expect(entry?.debt).toBeGreaterThan(0);
	});

	test("a fresh view RESETS debt to zero, even after many changes", () => {
		const receipts = Array.from({ length: 10 }, (_, i) => receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 + i }));
		const beforeView = computeFog({ receipts, seen: {}, repos: ["/r"], now: 1000 });
		expect(beforeView.find((e) => e.file === "a.ts")?.debt).toBeGreaterThan(0);

		const afterView = computeFog({ receipts, seen: seenAt("/r", "a.ts", 500), repos: ["/r"], now: 1000 });
		const entry = afterView.find((e) => e.file === "a.ts");
		expect(entry?.changesSinceSeen).toBe(0);
		expect(entry?.debt).toBe(0);
		expect(entry?.state).toBe("seen-current");
	});

	test("passage of time alone (varying `now` only) NEVER changes debt", () => {
		const receipts = [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 }), receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 300 })];
		const seen = seenAt("/r", "a.ts", 50);
		const at1000 = computeFog({ receipts, seen, repos: ["/r"], now: 1000 });
		const at1_000_000 = computeFog({ receipts, seen, repos: ["/r"], now: 1_000_000 });
		const at0 = computeFog({ receipts, seen, repos: ["/r"], now: 0 });
		const debt1000 = at1000.find((e) => e.file === "a.ts")?.debt;
		const debtLater = at1_000_000.find((e) => e.file === "a.ts")?.debt;
		const debtZero = at0.find((e) => e.file === "a.ts")?.debt;
		expect(debt1000).toBeDefined();
		expect(debtLater).toBe(debt1000 as number);
		expect(debtZero).toBe(debt1000 as number);
	});

	test("a receipt that predates lastSeenAt contributes nothing (endedAt > lastSeenAt is strict)", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 })],
			seen: seenAt("/r", "a.ts", 100), // exactly equal — NOT strictly greater
			repos: ["/r"],
			now: 1000,
		});
		const entry = entries.find((e) => e.file === "a.ts");
		expect(entry?.changesSinceSeen).toBe(0);
		expect(entry?.debt).toBe(0);
		expect(entry?.state).toBe("seen-current"); // lastSeenAt (100) >= lastChangedAt (100)
	});

	test("an in-flight receipt (no endedAt) never counts as a completed change", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"] })], // endedAt undefined
			seen: {},
			repos: ["/r"],
			now: 1000,
		});
		expect(entries.find((e) => e.file === "a.ts")).toBeUndefined();
	});

	test("a receipt touching the same file twice counts once", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/r", filesTouched: ["a.ts", "a.ts"], endedAt: 100 })],
			seen: {},
			repos: ["/r"],
			now: 1000,
		});
		expect(entries.find((e) => e.file === "a.ts")?.changesSinceSeen).toBe(1);
	});
});

describe("computeFog: tri-state boundaries", () => {
	test("never-seen: no lastSeenAt at all, file has receipt history", () => {
		const entries = computeFog({ receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 })], seen: {}, repos: ["/r"], now: 1000 });
		expect(entries[0].state).toBe("never-seen");
		expect(entries[0].lastSeenAt).toBeUndefined();
	});

	test("seen-current: lastSeenAt >= lastChangedAt", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 })],
			seen: seenAt("/r", "a.ts", 100),
			repos: ["/r"],
			now: 1000,
		});
		expect(entries[0].state).toBe("seen-current");
	});

	test("stale: lastSeenAt defined but < lastChangedAt", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 }), receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 200 })],
			seen: seenAt("/r", "a.ts", 100),
			repos: ["/r"],
			now: 1000,
		});
		expect(entries[0].state).toBe("stale");
		expect(entries[0].lastChangedAt).toBe(200);
	});
});

describe("computeFog: log-bucket bounds", () => {
	test("zero changes ⇒ debt exactly 0", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 10 })],
			seen: seenAt("/r", "a.ts", 100),
			repos: ["/r"],
			now: 1000,
		});
		expect(entries[0].debt).toBe(0);
	});

	test("n changes ⇒ debt === min(1, log2(1+n)/DEBT_LOG_DIVISOR) exactly", () => {
		for (const n of [1, 3, 7, 15, 31, 63, 64, 100, 1000]) {
			const receipts = Array.from({ length: n }, (_, i) => receipt({ repo: "/r", filesTouched: [`f${n}.ts`], endedAt: 1 + i }));
			const entries = computeFog({ receipts, seen: {}, repos: ["/r"], now: 100000 });
			const entry = entries.find((e) => e.file === `f${n}.ts`);
			expect(entry?.changesSinceSeen).toBe(n);
			const expected = Math.min(1, Math.log2(1 + n) / DEBT_LOG_DIVISOR);
			expect(entry?.debt).toBeCloseTo(expected, 10);
		}
	});

	test("debt never exceeds 1 however many changes accrue (saturation)", () => {
		const receipts = Array.from({ length: 5000 }, (_, i) => receipt({ repo: "/r", filesTouched: ["huge.ts"], endedAt: 1 + i }));
		const entries = computeFog({ receipts, seen: {}, repos: ["/r"], now: 100000 });
		expect(entries[0].debt).toBe(1);
		expect(entries[0].debt).toBeLessThanOrEqual(1);
	});

	test("DEBT_LOG_DIVISOR is the named constant the formula divides by", () => {
		expect(DEBT_LOG_DIVISOR).toBe(6);
	});

	test("debt is monotone non-decreasing in changesSinceSeen (more changes never means less debt)", () => {
		let prev = -1;
		for (let n = 0; n <= 200; n++) {
			const receipts = n === 0 ? [] : Array.from({ length: n }, (_, i) => receipt({ repo: "/r", filesTouched: ["m.ts"], endedAt: 1 + i }));
			const entries = computeFog({ receipts, seen: {}, repos: ["/r"], now: 100000 });
			const debt = entries.find((e) => e.file === "m.ts")?.debt ?? 0;
			expect(debt).toBeGreaterThanOrEqual(prev);
			prev = debt;
		}
	});
});

describe("computeFog: repo-allow-list join safety", () => {
	test("a foreign-repo receipt never joins into the requested repo's entries", () => {
		const entries = computeFog({
			receipts: [
				receipt({ repo: "/mine", filesTouched: ["a.ts"], endedAt: 100 }),
				receipt({ repo: "/other-tenant", filesTouched: ["secret.ts"], endedAt: 100 }),
			],
			seen: {},
			repos: ["/mine"],
			now: 1000,
		});
		expect(entries.map((e) => e.file)).toEqual(["a.ts"]);
		expect(entries.some((e) => e.repo === "/other-tenant")).toBe(false);
	});

	test("a foreign-repo seen entry never resets debt for a same-named file in the requested repo", () => {
		// Same bare filename, different repo — the join key is (repo,file), not (file) alone.
		const seen: SeenMap = { "/other-tenant\0a.ts": { lastSeenAt: 999999 } };
		const entries = computeFog({
			receipts: [receipt({ repo: "/mine", filesTouched: ["a.ts"], endedAt: 100 })],
			seen,
			repos: ["/mine"],
			now: 1_000_000,
		});
		expect(entries[0].state).toBe("never-seen");
		expect(entries[0].lastSeenAt).toBeUndefined();
	});

	test("an empty repos array admits nothing (fail closed, not unrestricted)", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/mine", filesTouched: ["a.ts"], endedAt: 100 })],
			seen: {},
			repos: [],
			now: 1000,
		});
		expect(entries).toEqual([]);
	});

	test("repos are normalized (a trailing slash is the same repo)", () => {
		const entries = computeFog({
			receipts: [receipt({ repo: "/mine/", filesTouched: ["a.ts"], endedAt: 100 })],
			seen: {},
			repos: ["/mine"],
			now: 1000,
		});
		expect(entries).toHaveLength(1);
	});
});

describe("computeFog: concern-08 surprise-boost forward-compat", () => {
	test("default (no surpriseCounts) is a pure no-op", () => {
		const receipts = [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 })];
		const withoutField = computeFog({ receipts, seen: {}, repos: ["/r"], now: 1000 });
		const withEmptyField = computeFog({ receipts, seen: {}, repos: ["/r"], now: 1000, surpriseCounts: {} });
		expect(withoutField).toEqual(withEmptyField);
	});

	test("a surprise tap boosts debt without inflating the raw changesSinceSeen count", () => {
		const receipts = [receipt({ repo: "/r", filesTouched: ["a.ts"], endedAt: 100 })];
		const key = "/r\0a.ts";
		const boosted = computeFog({ receipts, seen: {}, repos: ["/r"], now: 1000, surpriseCounts: { [key]: 1 } });
		const plain = computeFog({ receipts, seen: {}, repos: ["/r"], now: 1000 });
		const boostedEntry = boosted.find((e) => e.file === "a.ts") as FileFogEntry;
		const plainEntry = plain.find((e) => e.file === "a.ts") as FileFogEntry;
		expect(boostedEntry.changesSinceSeen).toBe(plainEntry.changesSinceSeen); // raw count unaffected
		expect(boostedEntry.debt).toBeGreaterThan(plainEntry.debt); // debt reflects the boost
		const expected = Math.min(1, Math.log2(1 + 1 + SURPRISE_BOOST) / DEBT_LOG_DIVISOR);
		expect(boostedEntry.debt).toBeCloseTo(expected, 10);
	});

	test("SURPRISE_BOOST is the named +8 constant", () => {
		expect(SURPRISE_BOOST).toBe(8);
	});
});

describe("repoHasHistory", () => {
	test("no seen entries at all ⇒ false", () => {
		expect(repoHasHistory({}, "/r", 10_000_000)).toBe(false);
	});

	test("a single seen entry (zero span) ⇒ false", () => {
		expect(repoHasHistory(seenAt("/r", "a.ts", 100), "/r", 10_000_000)).toBe(false);
	});

	test("entries clustered within under a day ⇒ false", () => {
		const seen: SeenMap = { "/r\0a.ts": { lastSeenAt: 1000 }, "/r\0b.ts": { lastSeenAt: 1000 + 60 * 60 * 1000 } }; // 1h apart
		expect(repoHasHistory(seen, "/r", 10_000_000)).toBe(false);
	});

	test("entries spanning >= 1 day ⇒ true", () => {
		const DAY_MS = 24 * 60 * 60 * 1000;
		const seen: SeenMap = { "/r\0a.ts": { lastSeenAt: 1000 }, "/r\0b.ts": { lastSeenAt: 1000 + DAY_MS } };
		expect(repoHasHistory(seen, "/r", 1000 + DAY_MS + 1)).toBe(true);
	});

	test("only counts entries belonging to the requested repo", () => {
		const DAY_MS = 24 * 60 * 60 * 1000;
		const seen: SeenMap = { "/mine\0a.ts": { lastSeenAt: 1000 }, "/other\0b.ts": { lastSeenAt: 1000 + DAY_MS } };
		expect(repoHasHistory(seen, "/mine", 1000 + DAY_MS + 1)).toBe(false);
	});
});

describe("topDebt", () => {
	function entry(file: string, debt: number, changesSinceSeen = 0): FileFogEntry {
		return { repo: "/r", file, changesSinceSeen, lastChangedAt: 0, debt, state: "stale" };
	}

	test("returns the top n by debt descending", () => {
		const entries = [entry("a.ts", 0.1), entry("b.ts", 0.9), entry("c.ts", 0.5)];
		expect(topDebt(entries, 2).map((e) => e.file)).toEqual(["b.ts", "c.ts"]);
	});

	test("defaults to n=10", () => {
		const entries = Array.from({ length: 15 }, (_, i) => entry(`f${i}.ts`, i / 15));
		expect(topDebt(entries)).toHaveLength(10);
	});

	test("ties broken by changesSinceSeen desc, then lexical (repo,file)", () => {
		const entries = [entry("z.ts", 0.5, 1), entry("a.ts", 0.5, 5)];
		expect(topDebt(entries).map((e) => e.file)).toEqual(["a.ts", "z.ts"]);
	});

	test("does not mutate the input array", () => {
		const entries = [entry("b.ts", 0.1), entry("a.ts", 0.9)];
		const copy = [...entries];
		topDebt(entries, 1);
		expect(entries).toEqual(copy);
	});
});
