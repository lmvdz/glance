import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AutomationLog, automationPath, isMeaningful } from "../src/automation-log.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "automation-"));
}

// Default-silent log: several tests fire-and-forget a meaningful event then rmSync(dir) in finally, so the
// (now-surfaced) spool failure would race onto the console at teardown. Tests that ASSERT on logging pass
// their own sink; everyone else uses this to keep the shared run quiet. The surfacing itself is covered by
// the dedicated #17 tests below.
function mkLog(dir: string, opts: ConstructorParameters<typeof AutomationLog>[1] = {}): AutomationLog {
	return new AutomationLog(dir, { log: () => {}, ...opts });
}

describe("isMeaningful", () => {
	test("work, skips, or an error are meaningful; a pure heartbeat is not", () => {
		expect(isMeaningful({ llmCalls: 1 })).toBe(true);
		expect(isMeaningful({ filed: 1 })).toBe(true);
		expect(isMeaningful({ found: 2 })).toBe(true);
		expect(isMeaningful({ spawned: 1 })).toBe(true);
		expect(isMeaningful({ skipReason: "budget" })).toBe(true);
		expect(isMeaningful({ level: "warn" })).toBe(true);
		expect(isMeaningful({ level: "error" })).toBe(true);
		expect(isMeaningful({ llmCalls: 0, filed: 0, found: 0, spawned: 0, level: "info" })).toBe(false);
		expect(isMeaningful({})).toBe(false);
	});
});

describe("AutomationLog.record", () => {
	test("stamps a strictly-increasing id + at, and rings the event", () => {
		const dir = tmp();
		try {
			const log = mkLog(dir);
			const a = log.record({ loop: "scout", agent: "x", llmCalls: 1 }, 1000);
			const b = log.record({ loop: "observer" }, 1000); // same ms ⇒ id must still increase
			expect(b.id).toBeGreaterThan(a.id);
			expect(a.at).toBe(1000);
			expect(log.recent().length).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("spools meaningful and skip events to disk but keeps heartbeats ring-only", async () => {
		const dir = tmp();
		try {
			const log = mkLog(dir);
			log.record({ loop: "observer", found: 0, filed: 0 }); // heartbeat
			log.record({ loop: "scout", llmCalls: 1, found: 2, filed: 1 }); // work
			log.record({ loop: "scout", llmCalls: 0, skipReason: "budget", detail: "budget reached" }); // skip
			await Bun.sleep(30); // spool is fire-and-forget; give the append a tick to land
			expect(existsSync(automationPath(dir))).toBe(true);
			const lines = readFileSync(automationPath(dir), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(lines.map((e) => e.loop)).toEqual(["scout", "scout"]);
			expect(lines.map((e) => e.skipReason)).toEqual([undefined, "budget"]);
			// all three events are in the live ring
			expect(log.recent().length).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("never lets a recorder error escape into the observed loop", () => {
		const dir = tmp();
		try {
			const log = new AutomationLog(dir, {
				log: () => {}, // surfaced via the sink (see the #17 test); silenced here so it isn't console noise
				onEvent: () => {
					throw new Error("boom");
				},
			});
			const rec = log.for("scout", "/repo");
			expect(() => rec({ llmCalls: 1 })).not.toThrow(); // for() swallows
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// #17: a swallowed recorder error must still be SURFACED (non-fatally) via the log sink, not lost silently.
	test("(#17) a swallowed recorder error is surfaced via the log sink (still non-fatal)", () => {
		const dir = tmp();
		try {
			const seen: string[] = [];
			const log = new AutomationLog(dir, {
				log: (m) => seen.push(m),
				onEvent: () => {
					throw new Error("boom");
				},
			});
			const rec = log.for("scout", "/repo");
			expect(() => rec({ llmCalls: 1 })).not.toThrow(); // never crashes the loop
			expect(seen.length).toBe(1); // …but the failure is now visible
			expect(seen[0]).toContain("failed to record scout event");
			expect(seen[0]).toContain("boom");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// #17: a failing spool (the meaningful/costly history not persisting) must be surfaced — once per
	// episode — instead of being swallowed silently, while the live ring still has the event.
	test("(#17) a failing spool surfaces a warning (once per episode) and never throws", async () => {
		const dir = tmp();
		try {
			const seen: string[] = [];
			const log = new AutomationLog(dir, { log: (m) => seen.push(m) });
			// Make the spool target unwritable: replace the file with a directory of the same name so appendFile
			// fails (EISDIR). mkdir(recursive) on its parent is a no-op, so the append is what fails.
			const { mkdirSync } = await import("node:fs");
			mkdirSync(automationPath(dir)); // automation.jsonl is now a directory ⇒ appendFile fails
			log.record({ loop: "scout", llmCalls: 1, filed: 1 }); // meaningful ⇒ tries to spool
			log.record({ loop: "scout", llmCalls: 1, filed: 1 }); // second failure — must NOT re-log
			await Bun.sleep(40); // spool is fire-and-forget
			const warnings = seen.filter((m) => m.includes("spool failed"));
			expect(warnings.length).toBe(1); // surfaced exactly once per episode
			expect(log.recent().length).toBe(2); // the ring still carries both for the live feed
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("AutomationLog.for", () => {
	test("binds the loop name + repo so loop code only reports metrics", () => {
		const dir = tmp();
		try {
			const log = mkLog(dir);
			log.for("scout", "/home/me/repo")({ agent: "a1", llmCalls: 1, found: 3, filed: 2 });
			const [e] = log.recent();
			expect(e.loop).toBe("scout");
			expect(e.repo).toBe("/home/me/repo");
			expect(e.agent).toBe("a1");
			expect(e.deduped).toBeUndefined(); // only what the caller passed
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("AutomationLog.recent", () => {
	test("filters by loop, window, meaningful-only; newest first; honors limit", () => {
		const dir = tmp();
		try {
			const log = mkLog(dir);
			log.record({ loop: "scout", llmCalls: 1 }, 1000);
			log.record({ loop: "observer", found: 0 }, 2000); // heartbeat
			log.record({ loop: "scout", llmCalls: 1, filed: 1 }, 3000);
			const now = 3000;
			const newestFirst = log.recent({}, now);
			expect(newestFirst[0].at).toBe(3000);
			expect(log.recent({ loop: "scout" }, now).length).toBe(2);
			expect(log.recent({ meaningfulOnly: true }, now).length).toBe(2); // the heartbeat drops
			expect(log.recent({ sinceMs: 1500 }, now).length).toBe(2); // 1000 falls outside
			expect(log.recent({ limit: 1 }, now).length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("AutomationLog.rollup", () => {
	test("aggregates per loop within the window, tracking llmCalls/filed/errors/lastAt", () => {
		const dir = tmp();
		try {
			const log = mkLog(dir);
			const now = 100_000;
			log.record({ loop: "scout", llmCalls: 1, found: 2, filed: 1 }, now - 1000);
			log.record({ loop: "scout", llmCalls: 1, level: "error" }, now - 500);
			log.record({ loop: "observer", found: 1, filed: 1 }, now - 200);
			log.record({ loop: "dispatch", spawned: 2 }, now - 100);
			log.record({ loop: "scout", llmCalls: 1 }, now - 10_000_000); // outside a 1h window
			const rows = log.rollup(3_600_000, now);
			const scout = rows.find((r) => r.loop === "scout")!;
			expect(scout.events).toBe(2); // the ancient one is excluded
			expect(scout.llmCalls).toBe(2);
			expect(scout.filed).toBe(1);
			expect(scout.errors).toBe(1);
			expect(scout.lastAt).toBe(now - 500);
			expect(rows.find((r) => r.loop === "dispatch")!.spawned).toBe(2);
			// sorted by loop name
			expect(rows.map((r) => r.loop)).toEqual([...rows].map((r) => r.loop).sort());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("AutomationLog.hydrate", () => {
	test("a fresh instance reloads the meaningful spool tail from disk", async () => {
		const dir = tmp();
		try {
			const a = mkLog(dir);
			a.record({ loop: "scout", llmCalls: 1, filed: 1 });
			a.record({ loop: "observer", found: 0 }); // heartbeat — not persisted
			await Bun.sleep(30);
			const b = mkLog(dir); // simulate a daemon restart
			const events = b.recent();
			expect(events.length).toBe(1); // only the persisted (meaningful) one survives
			expect(events[0].loop).toBe("scout");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
