import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cwdBelongsToRepo, encodeProjectDir, ingestClaudeCode, normalizeRepo, parseSession, sessionToReceipt } from "../src/ingest/claude-code.ts";
import { estimateCost } from "../src/omp-graph/rates.ts";
import { readAllReceipts } from "../src/receipts.ts";

const SID = "0f1b6cda-d933-4fca-8f12-278b378cea67";
const line = (o: Record<string, unknown>): string => JSON.stringify({ sessionId: SID, ...o });
const assistant = (ts: string, model: string, usage: Record<string, number>, content: unknown[] = []): string =>
	line({ type: "assistant", timestamp: ts, cwd: "/repo", message: { model, usage, content } });

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
