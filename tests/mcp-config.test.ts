/**
 * src/mcp-config.ts — the omp-rpc half of "bind a profile to real skills via MCP servers"
 * (plans/agent-profiles/02-skills-mcp-binding.md): `writeMcpConfig` writes/merges
 * `<worktree>/.omp/mcp.json` and idempotently excludes it from git, and `toAcpMcpServer(s)`
 * translates the canonical `McpServerSpec` into the ACP `session/new` wire shape.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { toAcpMcpServer, toAcpMcpServers, writeMcpConfig } from "../src/mcp-config.ts";
import type { McpServerSpec } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(args: string[], cwd: string): Promise<void> {
	const r = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
	await r.exited;
}

async function makeRepo(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(dir);
	await git(["init", "-q"], dir);
	await git(["config", "user.email", "t@t"], dir);
	await git(["config", "user.name", "t"], dir);
	await git(["config", "commit.gpgsign", "false"], dir);
	await fs.writeFile(path.join(dir, "README.md"), "x\n");
	await git(["add", "."], dir);
	await git(["commit", "-qm", "init"], dir);
	return dir;
}

// ── writeMcpConfig: write + merge ────────────────────────────────────────────

test("writeMcpConfig no-ops on an empty server list (no file created)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-empty-"));
	tmps.push(dir);
	await writeMcpConfig(dir, []);
	await expect(fs.access(path.join(dir, ".omp", "mcp.json"))).rejects.toThrow();
});

test("writeMcpConfig writes <worktree>/.omp/mcp.json with the resolved server(s)", async () => {
	const repo = await makeRepo("mcp-write-");
	const servers: McpServerSpec[] = [{ name: "design", type: "stdio", command: "echo", args: ["hi"], env: { FOO: "bar" } }];
	await writeMcpConfig(repo, servers);
	const raw = await fs.readFile(path.join(repo, ".omp", "mcp.json"), "utf8");
	const parsed = JSON.parse(raw);
	expect(parsed.mcpServers.design).toEqual({ type: "stdio", command: "echo", args: ["hi"], env: { FOO: "bar" } });
});

test("writeMcpConfig MERGES by name into a pre-existing .omp/mcp.json rather than clobbering it", async () => {
	const repo = await makeRepo("mcp-merge-");
	const dir = path.join(repo, ".omp");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { existing: { type: "http", url: "https://pre.example" } } }));
	await writeMcpConfig(repo, [{ name: "design", type: "stdio", command: "echo" }]);
	const parsed = JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8"));
	expect(parsed.mcpServers.existing).toEqual({ type: "http", url: "https://pre.example" }); // untouched
	expect(parsed.mcpServers.design.command).toBe("echo"); // the new one added alongside it
});

test("writeMcpConfig: the profile's server wins on a name collision with a pre-existing entry", async () => {
	const repo = await makeRepo("mcp-collide-");
	const dir = path.join(repo, ".omp");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { design: { type: "http", url: "https://stale.example" } } }));
	await writeMcpConfig(repo, [{ name: "design", type: "stdio", command: "echo" }]);
	const parsed = JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8"));
	expect(parsed.mcpServers.design).toEqual({ type: "stdio", command: "echo" }); // profile wins
});

// ── git exclude: idempotent, shared-common-dir-aware ─────────────────────────

test("writeMcpConfig appends .omp/mcp.json to .git/info/exclude on a plain (non-worktree) repo", async () => {
	const repo = await makeRepo("mcp-exclude-");
	await writeMcpConfig(repo, [{ name: "design", type: "stdio", command: "echo" }]);
	const exclude = await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
	expect(exclude).toContain(".omp/mcp.json");
});

test("writeMcpConfig is idempotent: calling it twice does not duplicate the exclude entry", async () => {
	const repo = await makeRepo("mcp-exclude-idem-");
	await writeMcpConfig(repo, [{ name: "design", type: "stdio", command: "echo" }]);
	await writeMcpConfig(repo, [{ name: "design", type: "stdio", command: "echo" }]);
	const exclude = await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
	const hits = exclude.split("\n").filter((l) => l.trim() === ".omp/mcp.json");
	expect(hits).toHaveLength(1);
});

test("writeMcpConfig on a LINKED worktree excludes into the shared repo's .git/info/exclude (not <worktree>/.git, which is a file there)", async () => {
	const repo = await makeRepo("mcp-linked-");
	const wtDir = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
	tmps.push(wtDir);
	await git(["worktree", "add", "-b", "feature/x", wtDir], repo);
	// Sanity: a linked worktree's .git is a FILE, not a directory — the naive `<worktree>/.git/info/exclude`
	// path would fail to mkdir through it.
	const gitEntry = await fs.stat(path.join(wtDir, ".git"));
	expect(gitEntry.isFile()).toBe(true);

	await writeMcpConfig(wtDir, [{ name: "design", type: "stdio", command: "echo" }]);

	// .omp/mcp.json is per-worktree (a real directory).
	await fs.access(path.join(wtDir, ".omp", "mcp.json")); // throws (failing the test) if absent
	// The exclude entry landed in the SHARED repo's info/exclude, not a nonexistent per-worktree one.
	const exclude = await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
	expect(exclude).toContain(".omp/mcp.json");
});

test("writeMcpConfig on a non-git directory writes the file but silently skips the exclude step", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-nongit-"));
	tmps.push(dir);
	await writeMcpConfig(dir, [{ name: "design", type: "stdio", command: "echo" }]);
	await fs.access(path.join(dir, ".omp", "mcp.json")); // throws (failing the test) if absent
	await expect(fs.access(path.join(dir, ".git"))).rejects.toThrow(); // never created a .git dir
});

// ── ACP wire translation ──────────────────────────────────────────────────────

test("toAcpMcpServer: stdio → {name,command,args,env as [{name,value}]}", () => {
	const spec: McpServerSpec = { name: "design", type: "stdio", command: "figma-mcp", args: ["--stdio"], env: { API_KEY: "secret" } };
	expect(toAcpMcpServer(spec)).toEqual({ name: "design", command: "figma-mcp", args: ["--stdio"], env: [{ name: "API_KEY", value: "secret" }] });
});

test("toAcpMcpServer: http/sse → {type,name,url,headers as [{name,value}]}", () => {
	const http: McpServerSpec = { name: "search", type: "http", url: "https://mcp.example/search", headers: { Authorization: "Bearer x" } };
	expect(toAcpMcpServer(http)).toEqual({ type: "http", name: "search", url: "https://mcp.example/search", headers: [{ name: "Authorization", value: "Bearer x" }] });
	const sse: McpServerSpec = { name: "events", type: "sse", url: "https://mcp.example/events" };
	expect(toAcpMcpServer(sse)).toEqual({ type: "sse", name: "events", url: "https://mcp.example/events", headers: [] });
});

test("toAcpMcpServers filters out disabled servers and translates the rest", () => {
	const specs: McpServerSpec[] = [
		{ name: "design", type: "stdio", command: "echo" },
		{ name: "off", type: "stdio", command: "echo", enabled: false },
	];
	const out = toAcpMcpServers(specs) as { name: string }[];
	expect(out.map((s) => s.name)).toEqual(["design"]);
});

test("toAcpMcpServers on undefined/empty returns []", () => {
	expect(toAcpMcpServers(undefined)).toEqual([]);
	expect(toAcpMcpServers([])).toEqual([]);
});
