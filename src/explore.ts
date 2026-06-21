/**
 * Worktree exploration: browse an agent's file tree and review what it
 * changed, so the UI can show a directory listing plus per-file diffs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runGit(args: string[]): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	// stdout is returned verbatim: porcelain status is whitespace-significant
	// (leading status column) and unified diffs are newline-significant.
	return { code, stdout, stderr: stderr.trim() };
}

const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

export interface FileNode {
	path: string;
	name: string;
	type: "file" | "dir";
	children?: FileNode[];
}

/**
 * Recursive listing of `dir`, dirs-first then alphabetical, with `path`
 * relative to `dir`. Skips `node_modules` and `.git`. `maxDepth` (default 4)
 * caps recursion; `maxEntries` (default 2000) caps the total nodes returned.
 */
export async function worktreeTree(
	dir: string,
	opts?: { maxDepth?: number; maxEntries?: number },
): Promise<FileNode[]> {
	const maxDepth = opts?.maxDepth ?? 4;
	const maxEntries = opts?.maxEntries ?? 2000;
	let count = 0;

	const walk = async (absDir: string, relPrefix: string, depth: number): Promise<FileNode[]> => {
		if (depth > maxDepth || count >= maxEntries) return [];
		const entries = await fs.readdir(absDir, { withFileTypes: true });
		entries.sort((a, b) => {
			const aDir = a.isDirectory();
			const bDir = b.isDirectory();
			if (aDir !== bDir) return aDir ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		const nodes: FileNode[] = [];
		for (const ent of entries) {
			if (count >= maxEntries) break;
			const isDir = ent.isDirectory();
			if (isDir && SKIP_DIRS.has(ent.name)) continue;
			count++;
			const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
			const node: FileNode = { path: relPath, name: ent.name, type: isDir ? "dir" : "file" };
			if (isDir) node.children = await walk(path.join(absDir, ent.name), relPath, depth + 1);
			nodes.push(node);
		}
		return nodes;
	};

	return walk(dir, "", 1);
}

export interface FileDiff {
	file: string;
	status: string;
	diff: string;
}

/**
 * Unified diff per changed path in `dir`'s git status. Tracked changes use
 * `git diff HEAD`; untracked files use `git diff --no-index` against
 * `/dev/null` (whose nonzero "files differ" exit is expected). Returns `[]`
 * when `dir` is not a git repository.
 */
export async function worktreeDiff(dir: string): Promise<FileDiff[]> {
	const status = await runGit(["-C", dir, "status", "--porcelain"]);
	if (status.code !== 0) return [];
	if (!status.stdout) return [];

	const diffs: FileDiff[] = [];
	for (const line of status.stdout.split("\n")) {
		if (!line) continue;
		const code = line.slice(0, 2);
		let rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		if (arrow >= 0) rest = rest.slice(arrow + 4);
		const file = rest.startsWith('"') && rest.endsWith('"') ? (JSON.parse(rest) as string) : rest;
		const untracked = code[0] === "?";
		const r = untracked
			? await runGit(["-C", dir, "diff", "--no-index", "--", "/dev/null", file])
			: await runGit(["-C", dir, "diff", "HEAD", "--", file]);
		diffs.push({ file, status: code, diff: r.stdout });
	}
	return diffs;
}

/**
 * Changed file paths in `dir` via `git status --porcelain` — cheap, no per-file
 * diff (unlike `worktreeDiff`). Reuses the rename `->` / quoted-path handling.
 * Returns `[]` when `dir` is not a git repository.
 */
export async function changedFiles(dir: string): Promise<string[]> {
	const status = await runGit(["-C", dir, "status", "--porcelain"]);
	if (status.code !== 0 || !status.stdout) return [];
	const files: string[] = [];
	for (const line of status.stdout.split("\n")) {
		if (!line) continue;
		let rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		if (arrow >= 0) rest = rest.slice(arrow + 4);
		files.push(rest.startsWith('"') && rest.endsWith('"') ? (JSON.parse(rest) as string) : rest);
	}
	return files;
}
