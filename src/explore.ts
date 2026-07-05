/**
 * Worktree exploration: browse an agent's file tree and review what it
 * changed, so the UI can show a directory listing plus per-file diffs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hardenedGit } from "./git-harden.ts";

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runGit(args: string[]): Promise<GitResult> {
	const r = await hardenedGit(args);
	// stdout is returned verbatim: porcelain status is whitespace-significant
	// (leading status column) and unified diffs are newline-significant.
	return { code: r.code, stdout: r.stdout, stderr: r.stderr.trim() };
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
	const status = await runGit(["-C", dir, "status", "--porcelain", "--untracked-files=all"]);
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
			? await runGit(["-C", dir, "diff", "--no-ext-diff", "--no-index", "--", "/dev/null", file])
			: await runGit(["-C", dir, "diff", "--no-ext-diff", "HEAD", "--", file]);
		diffs.push({ file, status: code, diff: r.stdout });
	}
	return diffs;
}

/**
 * Best-effort LOCAL resolution of the branch a worktree forked from, so the
 * review diff can be computed without a network round-trip on every poll. Tries
 * `OMP_SQUAD_PR_BASE` (the same override the land path honours), then the
 * clone-recorded `origin/HEAD`, then the common default names — returning the
 * first ref that actually resolves in `dir`. `undefined` when none do (e.g. a
 * bare scratch repo with no default branch), so callers can degrade gracefully.
 */
async function resolveForkBase(dir: string): Promise<string | undefined> {
	const override = process.env.OMP_SQUAD_PR_BASE;
	const symref = await runGit(["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	const candidates = [
		override ? `origin/${override}` : "",
		override ?? "",
		symref.code === 0 ? symref.stdout.trim() : "",
		"origin/main",
		"origin/master",
		"main",
		"master",
	].filter((ref): ref is string => ref.length > 0);
	for (const ref of candidates) {
		const ok = await runGit(["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		if (ok.code === 0) return ref;
	}
	return undefined;
}

/**
 * Full diff of everything the worktree changed since it forked from its base
 * branch — committed AND uncommitted — so the review panel keeps showing a
 * unit's work after it commits. `worktreeDiff` derives its file set from `git
 * status` (uncommitted only), so it goes blank the moment a unit commits; this
 * diffs the working tree against the fork point (`merge-base(base, HEAD)`)
 * instead, folding committed history and any still-uncommitted edits into one
 * pass. Falls back to `worktreeDiff` when no base branch resolves, so the panel
 * degrades to working-tree-only rather than erroring.
 */
export async function worktreeDiffSinceFork(dir: string): Promise<FileDiff[]> {
	const base = await resolveForkBase(dir);
	if (!base) return worktreeDiff(dir);
	const mb = await runGit(["-C", dir, "merge-base", base, "HEAD"]);
	const forkPoint = mb.code === 0 ? mb.stdout.trim() : "";
	if (!forkPoint) return worktreeDiff(dir);

	const diffs: FileDiff[] = [];
	const seen = new Set<string>();

	// Tracked changes (committed + uncommitted) since the fork point. `--no-renames`
	// keeps the name-status parse unambiguous — a rename lands as a delete + add pair.
	const names = await runGit(["-C", dir, "diff", "--no-ext-diff", "--no-renames", "--name-status", forkPoint]);
	if (names.code === 0) {
		for (const line of names.stdout.split("\n")) {
			if (!line) continue;
			const tab = line.indexOf("\t");
			if (tab < 0) continue;
			const code = line.slice(0, tab).trim();
			const file = line.slice(tab + 1);
			seen.add(file);
			const r = await runGit(["-C", dir, "diff", "--no-ext-diff", forkPoint, "--", file]);
			diffs.push({ file, status: `${code[0] ?? "M"} `, diff: r.stdout });
		}
	}

	// Untracked files were never committed, so the fork-point diff can't see them.
	const status = await runGit(["-C", dir, "status", "--porcelain", "--untracked-files=all"]);
	if (status.code === 0 && status.stdout) {
		for (const line of status.stdout.split("\n")) {
			if (!line || line[0] !== "?") continue;
			let rest = line.slice(3);
			const arrow = rest.indexOf(" -> ");
			if (arrow >= 0) rest = rest.slice(arrow + 4);
			const file = rest.startsWith('"') && rest.endsWith('"') ? (JSON.parse(rest) as string) : rest;
			if (seen.has(file)) continue;
			const r = await runGit(["-C", dir, "diff", "--no-ext-diff", "--no-index", "--", "/dev/null", file]);
			diffs.push({ file, status: "??", diff: r.stdout });
		}
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
