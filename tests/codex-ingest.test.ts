import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { costOfDelta, ingestCodex, parseCodexRollout, summaryToReceipt } from "../src/ingest/codex.ts";
import { readAllReceipts } from "../src/receipts.ts";

const SID = "019f049c-14d2-7541-80a6-1d29278b9816";
const l = (o: Record<string, unknown>): string => JSON.stringify(o);
const meta = (cwd: string): string => l({ timestamp: "2026-06-26T15:46:34Z", type: "session_meta", payload: { session_id: SID, cwd, timestamp: "2026-06-26T15:46:05Z", git: { branch: "main" } } });
const ctx = (model: string): string => l({ timestamp: "2026-06-26T15:46:35Z", type: "turn_context", payload: { model } });
const patch = (files: string): string => l({ timestamp: "2026-06-26T15:47:00Z", type: "event_msg", payload: { type: "patch_apply_end", stdout: `Success. Updated the following files:\n${files}` } });
/** a cumulative token_count snapshot (input is inclusive of cached, as Codex reports). */
const tc = (ts: string, input: number, cached: number, output: number): string =>
	l({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } } });

const rollout = (cwd: string): string[] => [
	meta(cwd),
	ctx("gpt-5"),
	tc("2026-06-26T15:47:00Z", 500, 300, 100), // earlier cumulative snapshot
	patch("A src/x.ts\nM src/y.ts"),
	ctx("gpt-5.5"), // model changes mid-session → last wins
	tc("2026-06-26T15:50:00Z", 1000, 600, 200), // FINAL cumulative — this is the session total
	"{ torn tail",
];

describe("parseCodexRollout", () => {
	test("takes the LAST cumulative token_count (never sums), last model, files + tools", () => {
		const s = parseCodexRollout(rollout("/repo"), SID)!;
		expect(s.usage).toEqual({ input: 1000, cachedInput: 600, output: 200, total: 1200 }); // final snapshot, not 500+1000
		expect(s.model).toBe("gpt-5.5"); // last turn_context wins
		expect(s.filesTouched.sort()).toEqual(["src/x.ts", "src/y.ts"]);
		expect(s.toolCalls).toBe(1);
		expect(s.branch).toBe("main");
		expect(s.startedAt).toBe(Date.parse("2026-06-26T15:46:05Z"));
	});
	test("returns null when there is no token usage", () => {
		expect(parseCodexRollout([meta("/repo"), ctx("gpt-5.5")], SID)).toBeNull();
	});
});

describe("costOfDelta — cached input must not be double-billed", () => {
	test("fresh input = input − cached, cached billed at 10% of the input rate (gpt → openai)", () => {
		// input 1000 (600 cached) → 400 fresh; output 200. openai {in:5,out:20}/MTok.
		const c = costOfDelta("gpt-5.5", { input: 1000, cachedInput: 600, output: 200, total: 1200 });
		expect(c).toBeCloseTo((400 / 1e6) * 5 + (200 / 1e6) * 20 + (600 / 1e6) * 5 * 0.1, 9); // 0.0063
	});
});

describe("summaryToReceipt", () => {
	test("stamps harness codex and splits tokens (cacheRead = cached, input = fresh)", () => {
		const s = parseCodexRollout(rollout("/repo"), SID)!;
		const r = summaryToReceipt(s, s.usage);
		expect(r.harness).toBe("codex");
		expect(r.agentId).toBe(`codex-${SID.slice(0, 8)}`);
		expect(r.model).toBe("gpt-5.5");
		expect(r.tokens).toMatchObject({ input: 400, output: 200, cacheRead: 600, cacheWrite: 0, total: 1200 });
		expect(r.costUsd).toBeCloseTo(0.0063, 6);
	});
});

describe("ingestCodex — end to end + idempotency + resumed-file delta", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	});

	test("ingests one codex receipt, is idempotent, and bills only the delta on a resumed file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ing-"));
		dirs.push(root);
		const stateDir = path.join(root, "state");
		const repo = path.join(root, "repo");
		const sessions = path.join(root, "codex", "sessions", "2026", "06", "26");
		await fs.mkdir(sessions, { recursive: true });
		await fs.mkdir(repo, { recursive: true });
		const file = path.join(sessions, `rollout-2026-06-26T10-46-05-${SID}.jsonl`);
		await fs.writeFile(file, rollout(repo).join("\n"));

		const base = { stateDir, repo, codexSessionsDir: path.join(root, "codex", "sessions"), idleMs: 0 };
		const r1 = await ingestCodex(base);
		expect(r1.ingested).toBe(1);
		let receipts = await readAllReceipts(stateDir);
		const codex = receipts.filter((x) => x.harness === "codex");
		expect(codex).toHaveLength(1);
		expect(codex[0].costUsd).toBeCloseTo(0.0063, 6);

		// unchanged file → no re-ingest (idempotent)
		expect((await ingestCodex(base)).ingested).toBe(0);

		// resumed: cumulative grows to 1500/700/300 → bill ONLY the delta (500 in, 100 cached, 100 out)
		await fs.writeFile(file, [...rollout(repo), tc("2026-06-26T16:00:00Z", 1500, 700, 300)].join("\n"));
		const r3 = await ingestCodex(base);
		expect(r3.ingested).toBe(1);
		receipts = await readAllReceipts(stateDir);
		const latest = receipts.filter((x) => x.harness === "codex").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
		// delta fresh input = (1500-1000) - (700-600) = 400; output = 100; cacheRead = 100
		expect(latest.tokens).toMatchObject({ input: 400, output: 100, cacheRead: 100 });
		expect(latest.costUsd).toBeCloseTo((400 / 1e6) * 5 + (100 / 1e6) * 20 + (100 / 1e6) * 5 * 0.1, 9);
	});

	test("a rollout whose cwd is a foreign repo is not ingested", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ing2-"));
		dirs.push(root);
		const sessions = path.join(root, "codex", "sessions", "2026", "06", "26");
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(path.join(sessions, `rollout-x-${SID}.jsonl`), rollout("/some/other/repo").join("\n"));
		const r = await ingestCodex({ stateDir: path.join(root, "state"), repo: path.join(root, "repo"), codexSessionsDir: path.join(root, "codex", "sessions"), idleMs: 0 });
		expect(r.ingested).toBe(0);
	});
});

test("a file whose mtime lands in the same millisecond as the call is ready, not 'still live'", async () => {
	// Regression pin for a ~22%-per-run flake: fs mtimeMs is a sub-millisecond float, Date.now() is
	// truncated, so a just-written file can report an mtime AHEAD of `now`. The idle check then went
	// negative and skipped a ready file.
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-mtime-"));
	const repo = path.join(root, "repo");
	const sessions = path.join(root, "codex", "sessions", "2026", "06", "26");
	await fs.mkdir(sessions, { recursive: true });
	await fs.mkdir(repo, { recursive: true });
	const file = path.join(sessions, `rollout-2026-06-26T10-46-05-${SID}.jsonl`);
	await fs.writeFile(file, rollout(repo).join("\n"));
	const mtimeMs = (await fs.stat(file)).mtimeMs;

	// `now` one whole millisecond BEHIND the float mtime — exactly what Date.now() truncation produces.
	const result = await ingestCodex({
		stateDir: path.join(root, "state"),
		repo,
		codexSessionsDir: path.join(root, "codex", "sessions"),
		idleMs: 0,
		now: Math.floor(mtimeMs),
	});
	expect(result.ingested).toBe(1);
	await fs.rm(root, { recursive: true, force: true });
});
