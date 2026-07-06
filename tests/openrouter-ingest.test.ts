import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ingestOpenRouter, rowToReceipt, todayUTC, type OpenRouterActivityRow } from "../src/ingest/openrouter.ts";
import { readAllReceipts } from "../src/receipts.ts";

const NOW = Date.parse("2026-07-06T12:00:00Z"); // today (UTC) = 2026-07-06
const ROWS: OpenRouterActivityRow[] = [
	{ date: "2026-07-04", model: "openai/gpt-4o", usage: 1.5, prompt_tokens: 1000, completion_tokens: 200 },
	{ date: "2026-07-05", model: "anthropic/claude-3.5-sonnet", usage: 0.8 },
	{ date: "2026-07-06", model: "openai/gpt-4o", usage: 5.0 }, // TODAY — still accumulating, skip
	{ date: "2026-07-05", model: "meta/llama", usage: 0 }, // nothing billed, skip
];

describe("todayUTC / rowToReceipt", () => {
	test("todayUTC is the UTC day", () => {
		expect(todayUTC(NOW)).toBe("2026-07-06");
	});
	test("a row becomes an openrouter receipt with REAL (billed) cost, dated to the day", () => {
		const r = rowToReceipt(ROWS[0], "/repo");
		expect(r.harness).toBe("openrouter");
		expect(r.costUsd).toBe(1.5); // billed usage, not estimated
		expect(r.model).toBe("openai/gpt-4o");
		expect(r.repo).toBe("/repo");
		expect(r.tokens).toMatchObject({ input: 1000, output: 200, total: 1200 });
		expect(r.startedAt).toBe(Date.parse("2026-07-04T00:00:00Z"));
	});
});

describe("ingestOpenRouter — opt-in gating", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	});
	const tmp = async (): Promise<string> => {
		const d = await fs.mkdtemp(path.join(os.tmpdir(), "or-"));
		dirs.push(d);
		return d;
	};

	test("no api key → no-op (never touches the API)", async () => {
		let called = false;
		const r = await ingestOpenRouter({ stateDir: await tmp(), repo: "/repo", now: NOW, attributionRepo: "/repo", fetchActivity: async () => ((called = true), ROWS) });
		expect(r).toEqual({ scanned: 0, ingested: 0 });
		expect(called).toBe(false);
	});

	test("repo is not the configured attribution repo → no-op (won't over-attribute)", async () => {
		const r = await ingestOpenRouter({ stateDir: await tmp(), repo: "/other", now: NOW, apiKey: "k", attributionRepo: "/repo", fetchActivity: async () => ROWS });
		expect(r).toEqual({ scanned: 0, ingested: 0 });
	});
});

describe("ingestOpenRouter — complete days, real cost, idempotent", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	});

	test("ingests only complete billed days; is idempotent; a newly-complete day is picked up next run", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "or-e2e-"));
		dirs.push(root);
		const stateDir = path.join(root, "state");
		const base = { stateDir, repo: "/repo", apiKey: "k", attributionRepo: "/repo", fetchActivity: async () => ROWS };

		const r1 = await ingestOpenRouter({ ...base, now: NOW });
		expect(r1.ingested).toBe(2); // 07-04 (1.5) + 07-05 claude (0.8); today skipped, $0 skipped
		const or = (await readAllReceipts(stateDir)).filter((x) => x.harness === "openrouter");
		expect(or.map((x) => x.costUsd).sort()).toEqual([0.8, 1.5]);

		// same rows again → nothing new (cursor)
		expect((await ingestOpenRouter({ ...base, now: NOW })).ingested).toBe(0);

		// a day later, 2026-07-06 is now complete → it's ingested (and only it)
		const later = Date.parse("2026-07-07T12:00:00Z");
		const r3 = await ingestOpenRouter({ ...base, now: later });
		expect(r3.ingested).toBe(1);
		const total = (await readAllReceipts(stateDir)).filter((x) => x.harness === "openrouter").reduce((s, x) => s + (x.costUsd ?? 0), 0);
		expect(total).toBeCloseTo(1.5 + 0.8 + 5.0, 6);
	});
});
