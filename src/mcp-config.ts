/**
 * Per-unit MCP server injection — the omp-rpc half of "bind a profile to real skills via MCP servers"
 * (plans/agent-profiles/02-skills-mcp-binding.md), plus the shared ACP wire translation so both harness
 * families' MCP logic lives beside the one canonical `McpServerSpec` type.
 *
 * omp/pi read `<worktree>/.omp/mcp.json` (project-scope MCP config) because the agent-host spawns them
 * with `--cwd <worktree>` (agent-host.ts). Nothing wrote this file before; `writeMcpConfig` does, called
 * from `SquadManager.createWithId` right after the worktree is cut and before `agent.start()`, gated to
 * omp-rpc-protocol harnesses with a non-empty resolved `mcp` list.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hardenedGit } from "./git-harden.ts";
import type { McpServerSpec } from "./types.ts";

interface OmpMcpServerEntry {
	type: McpServerSpec["type"];
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
}

interface OmpMcpConfig {
	mcpServers?: Record<string, OmpMcpServerEntry>;
	[key: string]: unknown;
}

/**
 * Write `<worktree>/.omp/mcp.json`, MERGING by server name into any pre-existing file (a repo-committed
 * `.omp/mcp.json`, or one left by a prior run in a reused worktree) rather than clobbering it — the
 * profile's server wins on a name collision. Also appends `.omp/mcp.json` to the repo's shared
 * `info/exclude` (see {@link excludeFromGit}) so this daemon-injected config never pollutes the unit's
 * commits. No-op for an empty `servers` list. Never throws — a write/exclude failure must not block a
 * spawn; callers should still log the rejection (this function only swallows the exclude step, which is
 * best-effort by design; the mcp.json write itself propagates so a genuinely broken worktree surfaces).
 */
export async function writeMcpConfig(worktree: string, servers: McpServerSpec[]): Promise<void> {
	if (!servers.length) return;
	const dir = path.join(worktree, ".omp");
	const file = path.join(dir, "mcp.json");
	await fs.mkdir(dir, { recursive: true });

	let existing: OmpMcpConfig = {};
	try {
		const raw = await fs.readFile(file, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as OmpMcpConfig;
	} catch {
		existing = {}; // missing/corrupt → start fresh, never throw
	}

	const merged: Record<string, OmpMcpServerEntry> = { ...(existing.mcpServers ?? {}) };
	for (const s of servers) {
		merged[s.name] = { type: s.type, command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers, enabled: s.enabled };
	}
	const out: OmpMcpConfig = { ...existing, mcpServers: merged };
	await fs.writeFile(file, `${JSON.stringify(out, null, 2)}\n`, "utf8");

	await excludeFromGit(worktree, ".omp/mcp.json");
}

/**
 * The `info/exclude` file to use for `worktree` — resolved via `git rev-parse --git-common-dir`, NOT a
 * literal `<worktree>/.git/info/exclude` path: in a squad-managed LINKED worktree `.git` is a plain FILE
 * (a `gitdir:` pointer), not a directory, so joining `.git/info/exclude` onto it would try to `mkdir`
 * through a file. `info/exclude` itself is common/shared git-dir content (unlike HEAD/index), so this
 * also means the exclusion applies across every worktree of the repo — the correct behavior for a
 * fleet where several units' worktrees all share one origin repo. Returns undefined when `worktree` is
 * not a git repo at all (the in-place non-git "spawn anywhere" fallback) — a silent no-op for callers.
 */
async function gitInfoExcludePath(worktree: string): Promise<string | undefined> {
	const r = await hardenedGit(["rev-parse", "--git-common-dir"], { cwd: worktree });
	const commonDir = r.code === 0 ? r.stdout.trim() : "";
	if (!commonDir) return undefined;
	const resolved = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktree, commonDir);
	return path.join(resolved, "info", "exclude");
}

/** Idempotently append `entry` to the worktree's shared `.git/info/exclude` (create the file/dir if
 *  absent). Best-effort: never throws — a spawn must not fail because the exclude file couldn't be
 *  touched (the mcp.json write above is the part that matters; this is defense-in-depth). */
async function excludeFromGit(worktree: string, entry: string): Promise<void> {
	try {
		const excludeFile = await gitInfoExcludePath(worktree);
		if (!excludeFile) return;
		await fs.mkdir(path.dirname(excludeFile), { recursive: true });
		let existing = "";
		try {
			existing = await fs.readFile(excludeFile, "utf8");
		} catch {
			existing = "";
		}
		if (existing.split("\n").map((l) => l.trim()).includes(entry)) return;
		const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
		await fs.writeFile(excludeFile, `${existing}${sep}${entry}\n`, "utf8");
	} catch {
		/* best-effort — see doc comment */
	}
}

/**
 * Translate one canonical `McpServerSpec` into the ACP `session/new` wire shape.
 *
 * ponytail: the public Agent Client Protocol schema represents a server's env/header maps as
 * `{name,value}` ARRAYS (not a JSON object/Record) and tags the `http`/`sse` variants with a `type`
 * field while `stdio` omits it (command presence is itself the discriminant) — inferred from the
 * published ACP schema, NOT verified against a live adapter (no ACP MCP round-trip has been
 * live-smoke-tested yet, unlike the opencode handshake itself — see harness-registry.ts's opencode
 * note). Swap this translation if a live adapter round-trip proves the shape wrong; it is the single
 * place both harness families' MCP logic reads the canonical `McpServerSpec`.
 */
export function toAcpMcpServer(spec: McpServerSpec): unknown {
	const pairs = (rec?: Record<string, string>) => Object.entries(rec ?? {}).map(([name, value]) => ({ name, value }));
	if (spec.type === "stdio") {
		return { name: spec.name, command: spec.command ?? "", args: spec.args ?? [], env: pairs(spec.env) };
	}
	return { type: spec.type, name: spec.name, url: spec.url ?? "", headers: pairs(spec.headers) };
}

/** Translate every ENABLED server (default enabled — `enabled !== false`) to the ACP wire shape. ACP's
 *  schema has no per-server `enabled` flag (that's omp's own `.omp/mcp.json` extension), so a
 *  disabled server is filtered out here rather than passed through inert. */
export function toAcpMcpServers(specs: McpServerSpec[] | undefined): unknown[] {
	return (specs ?? []).filter((s) => s.enabled !== false).map(toAcpMcpServer);
}
