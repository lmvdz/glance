import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlLog } from "../src/jsonl-log.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "jsonl-log-"));
}

interface Entry {
	i: number;
}

describe("JsonlLog.append + recent", () => {
	test("rings and caps at max, newest-last; recent(limit) takes the tail", () => {
		const dir = tmp();
		try {
			const log = new JsonlLog<Entry>({ path: path.join(dir, "test.jsonl"), max: 3, log: () => {} });
			for (let i = 0; i < 5; i++) log.append({ i });
			expect(log.recent()).toEqual([{ i: 2 }, { i: 3 }, { i: 4 }]); // capped to the last 3
			expect(log.recent(2)).toEqual([{ i: 3 }, { i: 4 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("spools appended entries to disk (fire-and-forget)", async () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			const log = new JsonlLog<Entry>({ path: file, log: () => {} });
			log.append({ i: 0 });
			log.append({ i: 1 });
			await Bun.sleep(30); // spool is fire-and-forget; give it a tick to land
			expect(existsSync(file)).toBe(true);
			const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(lines).toEqual([{ i: 0 }, { i: 1 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("JsonlLog rotation", () => {
	test("renames the file to <path>.1 once it crosses maxBytes, starting a fresh file", async () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			// Each {"i":N} line is 8 bytes. maxBytes=10 ⇒ rotation triggers once the file already holds 2 lines.
			const log = new JsonlLog<Entry>({ path: file, maxBytes: 10, log: () => {} });
			log.append({ i: 0 });
			await Bun.sleep(20);
			log.append({ i: 1 });
			await Bun.sleep(20);
			log.append({ i: 2 }); // file is now 16 bytes (>10) ⇒ this append rotates first
			await Bun.sleep(20);

			expect(existsSync(`${file}.1`)).toBe(true);
			const rotated = readFileSync(`${file}.1`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(rotated).toEqual([{ i: 0 }, { i: 1 }]);
			const fresh = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(fresh).toEqual([{ i: 2 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("clobbers a previous .1 on a second rotation", async () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			const log = new JsonlLog<Entry>({ path: file, maxBytes: 10, log: () => {} });
			for (let i = 0; i < 5; i++) {
				log.append({ i });
				await Bun.sleep(20);
			}
			expect(existsSync(`${file}.1`)).toBe(true);
			// Whatever the final rotated snapshot is, it must be valid JSONL (not garbled by two overlapping rotations).
			const rotated = readFileSync(`${file}.1`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(rotated.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("JsonlLog.hydrate (constructor) + hydrateAll", () => {
	test("hydrate seeds the ring from disk on construction, skipping torn lines", () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			writeFileSync(file, '{"i":0}\n{"i":1}\nnot json\n{"i":2}\n');
			const log = new JsonlLog<Entry>({ path: file, log: () => {} });
			expect(log.recent()).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hydrate caps the seeded ring at max (keeps the tail)", () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			writeFileSync(file, [0, 1, 2, 3, 4].map((i) => JSON.stringify({ i })).join("\n") + "\n");
			const log = new JsonlLog<Entry>({ path: file, max: 2, log: () => {} });
			expect(log.recent()).toEqual([{ i: 3 }, { i: 4 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing file on construction is the normal first-boot case (empty ring, no warning)", () => {
		const dir = tmp();
		const seen: string[] = [];
		try {
			const log = new JsonlLog<Entry>({ path: path.join(dir, "nope.jsonl"), log: (m) => seen.push(m) });
			expect(log.recent()).toEqual([]);
			expect(seen).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hydrateAll reads the full file (not the capped ring) and skips torn lines", async () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			writeFileSync(file, '{"i":0}\ngarbage{{{\n{"i":1}\n{"i":2}\n');
			const log = new JsonlLog<Entry>({ path: file, max: 1, log: () => {} }); // ring capped to 1
			expect(log.recent()).toEqual([{ i: 2 }]); // ring only kept the tail
			expect(await log.hydrateAll()).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]); // file has the full history
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hydrateAll on a missing file returns [] (never throws)", async () => {
		const dir = tmp();
		try {
			const log = new JsonlLog<Entry>({ path: path.join(dir, "nope.jsonl"), log: () => {} });
			expect(await log.hydrateAll()).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Finding 7 (wave-1 review): hydrateAll must read the rotated `<path>.1` tail — the caller-facing
	// contract is "full persisted history", and once a rotation has happened that history spans two
	// files. Losing `.1` silently drops everything written before the last rotation.
	test("hydrateAll reads the rotated <path>.1 tail BEFORE the live file, oldest-first", async () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			// Same shape as the "renames the file to <path>.1" rotation test above: three 8-byte lines
			// with maxBytes=10 ⇒ exactly one rotation (i:0,i:1 → .1; i:2 stays live).
			const log = new JsonlLog<Entry>({ path: file, maxBytes: 10, log: () => {} });
			log.append({ i: 0 });
			await Bun.sleep(20);
			log.append({ i: 1 });
			await Bun.sleep(20);
			log.append({ i: 2 });
			await Bun.sleep(20);

			expect(existsSync(`${file}.1`)).toBe(true); // rotation happened
			const rotated = readFileSync(`${file}.1`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Entry);
			const live = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Entry);
			expect(rotated).toEqual([{ i: 0 }, { i: 1 }]);
			expect(live).toEqual([{ i: 2 }]);

			const all = await log.hydrateAll();
			expect(all).toEqual([...rotated, ...live]); // .1 first (oldest), then the live file
			expect(all).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]); // nothing from before rotation was dropped
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hydrateAll: a torn line in <path>.1 is skipped, the rest of both files still read", async () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			writeFileSync(`${file}.1`, '{"i":0}\nnot json\n{"i":1}\n');
			writeFileSync(file, '{"i":2}\n');
			const log = new JsonlLog<Entry>({ path: file, log: () => {} }); // no rotation needed for this test
			expect(await log.hydrateAll()).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("hydrateAll: missing .1 (no rotation yet) reads only the live file, same as before", async () => {
		const dir = tmp();
		const file = path.join(dir, "test.jsonl");
		try {
			writeFileSync(file, '{"i":0}\n{"i":1}\n');
			const log = new JsonlLog<Entry>({ path: file, log: () => {} });
			expect(await log.hydrateAll()).toEqual([{ i: 0 }, { i: 1 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
