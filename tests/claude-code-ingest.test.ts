import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cwdBelongsToRepo, encodeProjectDir, ingestClaudeCode, normalizeRepo, parseSession, sessionToReceipt } from "../src/ingest/claude-code.ts";
import { estimateCost } from "../src/omp-graph/rates.ts";
import { appendReceipt, readAllReceipts } from "../src/receipts.ts";

const SID = "0f1b6cda-d933-4fca-8f12-278b378cea67";
const line = (o: Record<string, unknown>): string => JSON.stringify({ sessionId: SID, ...o });
/** `id` mirrors Claude Code's `message.id` — omit it (as the base FIXTURE below does) to model
 *  older transcripts with no id; pass the SAME id across calls to model the real-world shape
 *  where one API response's usage is repeated across several content-block lines. */
const assistant = (ts: string, model: string, usage: Record<string, number>, content: unknown[] = [], id?: string): string =>
	line({ type: "assistant", timestamp: ts, cwd: "/repo", message: { id, model, usage, content } });

const FIXTURE = [
	line({ type: "mode", mode: "normal" }),
	line({ type: "user", timestamp: "2026-07-01T10:00:00Z", cwd: "/repo", gitBranch: "main", message: { content: "do the thing" } }),
	assistant("2026-07-01T10:00:05Z", "claude-sonnet-5", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }, [
		{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
		{ type: "tool_use", name: "Bash", input: { command: "ls" } },
	]),
	assistant("2026-07-01T10:20:00Z", "claude-fable-5", { input_tokens: 10, output_tokens: 900 }),
	"{ torn tail",
];

describe("parseSession", () => {
	test("sums usage, picks the dominant model, tracks span/files/tools", () => {
		const s = parseSession(FIXTURE, SID)!;
		expect(s.tokens).toMatchObject({ input: 1010, output: 1400, cacheRead: 2000, cacheWrite: 100 });
		expect(s.model).toBe("claude-fable-5"); // 900 out > 500
		expect(s.startedAt).toBe(Date.parse("2026-07-01T10:00:00Z"));
		expect(s.endedAt).toBe(Date.parse("2026-07-01T10:20:00Z"));
		expect(s.toolCalls).toBe(2);
		expect(s.filesTouched).toEqual(["/repo/src/a.ts"]);
		expect(s.branch).toBe("main");
		const expected =
			estimateCost("claude-sonnet-5", { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 }) +
			estimateCost("claude-fable-5", { input: 10, output: 900, cacheRead: 0, cacheWrite: 0 });
		expect(s.costUsd).toBeCloseTo(expected, 10);
	});

	test("from-offset summarizes only the continuation", () => {
		const s = parseSession(FIXTURE, SID, 3)!;
		expect(s.tokens.output).toBe(900);
		expect(s.model).toBe("claude-fable-5");
	});

	test("null when no usage at all", () => {
		expect(parseSession([line({ type: "mode" })], SID)).toBeNull();
	});
});

describe("parseSession — usage dedupe by message.id", () => {
	// Claude Code writes ONE line per assistant content block; each line of the same API
	// response repeats the SAME message.id + usage. Real shape, in miniature: one response
	// (msg_A) split over thinking/text/tool_use lines, then a second response (msg_B) over two.
	const USAGE_A = { input_tokens: 15344, output_tokens: 1052, cache_read_input_tokens: 16535, cache_creation_input_tokens: 5674 };
	const USAGE_B = { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 };
	const DUPED = [
		line({ type: "user", timestamp: "2026-07-01T10:00:00Z", cwd: "/repo", message: { content: "go" } }),
		assistant("2026-07-01T10:00:05Z", "claude-opus-4-8", USAGE_A, [{ type: "thinking", thinking: "…" }], "msg_A"),
		assistant("2026-07-01T10:00:06Z", "claude-opus-4-8", USAGE_A, [{ type: "text", text: "hi" }], "msg_A"),
		assistant("2026-07-01T10:00:07Z", "claude-opus-4-8", USAGE_A, [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], "msg_A"),
		assistant("2026-07-01T10:00:20Z", "claude-opus-4-8", USAGE_B, [{ type: "text", text: "a" }], "msg_B"),
		assistant("2026-07-01T10:00:21Z", "claude-opus-4-8", USAGE_B, [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/x.ts" } }], "msg_B"),
	];

	test("each API response (message.id) is billed exactly once", () => {
		const s = parseSession(DUPED, SID)!;
		expect(s.tokens).toMatchObject({
			input: USAGE_A.input_tokens + USAGE_B.input_tokens,
			output: USAGE_A.output_tokens + USAGE_B.output_tokens,
			cacheRead: USAGE_A.cache_read_input_tokens + USAGE_B.cache_read_input_tokens,
			cacheWrite: USAGE_A.cache_creation_input_tokens + USAGE_B.cache_creation_input_tokens,
		});
		const expectedCost =
			estimateCost("claude-opus-4-8", { input: 15344, output: 1052, cacheRead: 16535, cacheWrite: 5674 }) +
			estimateCost("claude-opus-4-8", { input: 200, output: 30, cacheRead: 40000, cacheWrite: 0 });
		expect(s.costUsd).toBeCloseTo(expectedCost, 10);
		// tool calls + files still counted per content block (each line is a distinct block)
		expect(s.toolCalls).toBe(2);
		expect(s.filesTouched).toEqual(["/repo/x.ts"]);
	});

	test("REGRESSION: naive per-line summing would inflate totals by the duplication factor", () => {
		const s = parseSession(DUPED, SID)!;
		const naive = {
			input: 3 * USAGE_A.input_tokens + 2 * USAGE_B.input_tokens,
			cacheRead: 3 * USAGE_A.cache_read_input_tokens + 2 * USAGE_B.cache_read_input_tokens,
		};
		// If someone reverts the message.id dedupe, deduped === naive and these fail.
		expect(s.tokens.input).toBeLessThan(naive.input);
		expect(s.tokens.cacheRead).toBeLessThan(naive.cacheRead);
		expect(s.tokens.input).toBe(USAGE_A.input_tokens + USAGE_B.input_tokens);
		expect(s.tokens.cacheRead).toBe(USAGE_A.cache_read_input_tokens + USAGE_B.cache_read_input_tokens);
	});

	test("dominant-model vote also dedupes (a 3-line response is not 3 votes)", () => {
		const s = parseSession(
			[
				line({ type: "user", timestamp: "2026-07-01T10:00:00Z", cwd: "/repo", message: { content: "go" } }),
				// opus: ONE response (600 out) duplicated over three lines
				assistant("2026-07-01T10:00:05Z", "claude-opus-4-8", { input_tokens: 1, output_tokens: 600 }, [{ type: "thinking" }], "msg_A"),
				assistant("2026-07-01T10:00:06Z", "claude-opus-4-8", { input_tokens: 1, output_tokens: 600 }, [{ type: "text" }], "msg_A"),
				assistant("2026-07-01T10:00:07Z", "claude-opus-4-8", { input_tokens: 1, output_tokens: 600 }, [{ type: "text" }], "msg_A"),
				// fable: one single-line response with more real output
				assistant("2026-07-01T10:00:20Z", "claude-fable-5", { input_tokens: 1, output_tokens: 700 }, [{ type: "text" }], "msg_B"),
			],
			SID,
		)!;
		expect(s.model).toBe("claude-fable-5"); // 700 > 600 deduped (naive: opus's 1800 would win)
	});

	test("lines without a message.id are each billed (nothing to dedupe against)", () => {
		const s = parseSession(
			[
				assistant("2026-07-01T10:00:05Z", "claude-sonnet-5", { input_tokens: 10, output_tokens: 5 }),
				assistant("2026-07-01T10:00:06Z", "claude-sonnet-5", { input_tokens: 10, output_tokens: 5 }),
			],
			SID,
		)!;
		expect(s.tokens).toMatchObject({ input: 20, output: 10 });
	});

	test("from-offset continuation dedupes within its own window", () => {
		// resume adds two lines of ONE new response
		const all = [
			...DUPED,
			assistant("2026-07-01T12:00:00Z", "claude-opus-4-8", { input_tokens: 7, output_tokens: 9 }, [{ type: "text" }], "msg_C"),
			assistant("2026-07-01T12:00:01Z", "claude-opus-4-8", { input_tokens: 7, output_tokens: 9 }, [{ type: "tool_use", name: "Bash", input: {} }], "msg_C"),
		];
		const s = parseSession(all, SID, DUPED.length)!;
		expect(s.tokens).toMatchObject({ input: 7, output: 9 });
	});
});

describe("sessionToReceipt / normalizeRepo", () => {
	test("worktree cwd attributes to the main repo; harness stamped", () => {
		expect(normalizeRepo("/home/x/repo/.claude/worktrees/foo")).toBe("/home/x/repo");
		const s = parseSession(FIXTURE, SID)!;
		const r = sessionToReceipt({ ...s, cwd: "/repo/.claude/worktrees/wip" });
		expect(r.repo).toBe("/repo");
		expect(r.harness).toBe("claude-code");
		expect(r.agentId).toBe(`cc-${SID.slice(0, 8)}`);
		expect(r.status).toBe("stopped");
	});
});

describe("ingestClaudeCode", () => {
	let tmp: string;
	afterEach(async () => {
		if (tmp) await fs.rm(tmp, { recursive: true, force: true });
	});

	test("idle sessions ingest once; growth ingests only the delta; live sessions wait", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-ingest-"));
		const repo = path.join(tmp, "repo");
		const stateDir = path.join(tmp, "state");
		const projects = path.join(tmp, "projects");
		const dir = path.join(projects, encodeProjectDir(repo));
		await fs.mkdir(dir, { recursive: true });
		await fs.mkdir(repo, { recursive: true });
		const file = path.join(dir, `${SID}.jsonl`);
		const fixture = FIXTURE.map((l) => l.replaceAll("/repo", repo));
		await fs.writeFile(file, fixture.join("\n"));
		const old = Date.now() - 60 * 60_000;
		await fs.utimes(file, old / 1000, old / 1000);

		const r1 = await ingestClaudeCode({ stateDir, repo, claudeProjectsDir: projects });
		expect(r1).toMatchObject({ scanned: 1, ingested: 1 });
		let receipts = await readAllReceipts(stateDir);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].harness).toBe("claude-code");
		expect(receipts[0].repo).toBe(repo);

		// unchanged → no-op
		const r2 = await ingestClaudeCode({ stateDir, repo, claudeProjectsDir: projects });
		expect(r2.ingested).toBe(0);

		// session resumed: grows by one assistant line, goes idle again → delta receipt
		await fs.appendFile(file, `\n${assistant("2026-07-01T12:00:00Z", "claude-sonnet-5", { input_tokens: 5, output_tokens: 50 }).replaceAll("/repo", repo)}`);
		await fs.utimes(file, old / 1000 + 1, old / 1000 + 1);
		const r3 = await ingestClaudeCode({ stateDir, repo, claudeProjectsDir: projects });
		expect(r3.ingested).toBe(1);
		receipts = await readAllReceipts(stateDir);
		expect(receipts).toHaveLength(2);
		expect(receipts[1].name).toContain("resumed");
		expect(receipts[1].tokens?.output).toBe(50);

		// a LIVE (recent-mtime) new session is skipped until idle
		const live = path.join(dir, "9999.jsonl");
		await fs.writeFile(live, fixture.join("\n"));
		const r4 = await ingestClaudeCode({ stateDir, repo, claudeProjectsDir: projects });
		expect(r4.ingested).toBe(0);
	});

	test("stale (pre-dedupe) cursor entries force a re-ingest that REPLACES the inflated receipt", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-ingest-"));
		const repo = path.join(tmp, "repo");
		const stateDir = path.join(tmp, "state");
		const projects = path.join(tmp, "projects");
		const dir = path.join(projects, encodeProjectDir(repo));
		await fs.mkdir(dir, { recursive: true });
		await fs.mkdir(repo, { recursive: true });
		const file = path.join(dir, `${SID}.jsonl`);
		// one API response duplicated over three content-block lines — the naive sum trebled it
		const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
		const fixture = [
			line({ type: "user", timestamp: "2026-07-01T10:00:00Z", cwd: repo, message: { content: "go" } }),
			assistant("2026-07-01T10:00:05Z", "claude-sonnet-5", usage, [{ type: "thinking" }], "msg_A").replaceAll("/repo", repo),
			assistant("2026-07-01T10:00:06Z", "claude-sonnet-5", usage, [{ type: "text" }], "msg_A").replaceAll("/repo", repo),
			assistant("2026-07-01T10:00:07Z", "claude-sonnet-5", usage, [{ type: "text" }], "msg_A").replaceAll("/repo", repo),
		];
		await fs.writeFile(file, fixture.join("\n"));
		const old = Date.now() - 60 * 60_000;
		await fs.utimes(file, old / 1000, old / 1000);
		const stat = await fs.stat(file);

		// simulate the PRE-fix world: an unversioned cursor marking the file fully ingested,
		// plus the inflated (3×) receipt the old code appended.
		const cursorFile = path.join(stateDir, "ingest", "claude-code.json");
		await fs.mkdir(path.dirname(cursorFile), { recursive: true });
		await fs.writeFile(cursorFile, JSON.stringify({ [file]: { lines: fixture.length, size: stat.size } }));
		const s = parseSession(fixture, SID)!;
		await appendReceipt(stateDir, sessionToReceipt({ ...s, tokens: { input: 300, output: 150, cacheRead: 3000, cacheWrite: 0, total: 3450 }, costUsd: s.costUsd * 3 }));
		let receipts = await readAllReceipts(stateDir);
		expect(receipts[0].tokens?.input).toBe(300); // stale, inflated

		// the fixed ingester sees the version-less entry, purges the stale receipt, recomputes
		const r = await ingestClaudeCode({ stateDir, repo, claudeProjectsDir: projects });
		expect(r.ingested).toBe(1);
		receipts = await readAllReceipts(stateDir);
		expect(receipts).toHaveLength(1); // replaced, not appended alongside
		expect(receipts[0].tokens).toMatchObject({ input: 100, output: 50, cacheRead: 1000 });
		expect(receipts[0].name).not.toContain("resumed"); // full recompute, not a delta continuation

		// second run: entry now stamped with the current version → clean no-op
		const r2 = await ingestClaudeCode({ stateDir, repo, claudeProjectsDir: projects });
		expect(r2.ingested).toBe(0);
		receipts = await readAllReceipts(stateDir);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].tokens?.input).toBe(100);
	});

	test("sessions from a different repo's stray cwd are skipped", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-ingest-"));
		const repo = path.join(tmp, "repo");
		const stateDir = path.join(tmp, "state");
		const projects = path.join(tmp, "projects");
		const dir = path.join(projects, encodeProjectDir(repo));
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, `${SID}.jsonl`);
		await fs.writeFile(file, FIXTURE.map((l) => l.replaceAll("/repo", "/somewhere/else")).join("\n"));
		const old = Date.now() - 60 * 60_000;
		await fs.utimes(file, old / 1000, old / 1000);
		const r = await ingestClaudeCode({ stateDir, repo, claudeProjectsDir: projects });
		expect(r).toMatchObject({ scanned: 1, ingested: 0 });
	});
});

test("cwdBelongsToRepo: a name-prefixed sibling repo is NOT a member (boundary, not bare startsWith)", () => {
	const repo = path.resolve("/x/myrepo");
	expect(cwdBelongsToRepo(path.resolve("/x/myrepo"), "/x/myrepo")).toBe(true); // the repo itself
	expect(cwdBelongsToRepo(path.resolve("/x/myrepo/pkg/a"), "/x/myrepo")).toBe(true); // a subdir
	expect(cwdBelongsToRepo(path.resolve("/x/myrepo/.claude/worktrees/wt1"), "/x/myrepo")).toBe(true); // worktree normalizes back
	expect(cwdBelongsToRepo(path.resolve("/x/myrepo-backup"), "/x/myrepo")).toBe(false); // sibling — was wrongly true
	expect(cwdBelongsToRepo(path.resolve("/other/dir"), "/x/myrepo")).toBe(false);
	void repo;
});
