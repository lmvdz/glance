/**
 * Worktree exploration: tree listing + per-file diffs over a real temp git
 * repo (no model tokens spent).
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FileNode, worktreeDiff, worktreeDiffSinceFork, worktreeTree } from "../src/explore.ts";

const tmps: string[] = [];

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "exp-repo-"));
	tmps.push(repo);
	const git = async (args: string[]) => {
		const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
		await p.exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "original\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

function findNode(nodes: FileNode[], rel: string): FileNode | undefined {
	for (const n of nodes) {
		if (n.path === rel) return n;
		if (n.children) {
			const hit = findNode(n.children, rel);
			if (hit) return hit;
		}
	}
	return undefined;
}

afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

test("worktreeDiff surfaces tracked modifications and untracked additions", async () => {
	const repo = await makeRepo();
	await fs.writeFile(path.join(repo, "tracked.txt"), "modified\n");
	await fs.writeFile(path.join(repo, "new.txt"), "brand new\n");
	await fs.mkdir(path.join(repo, "nested"));
	await fs.writeFile(path.join(repo, "nested", "added.txt"), "nested brand new\n");

	const diffs = await worktreeDiff(repo);
	const byFile = new Map(diffs.map((d) => [d.file, d]));

	expect(byFile.has("tracked.txt")).toBe(true);
	expect(byFile.has("new.txt")).toBe(true);
	expect(byFile.has("nested/added.txt")).toBe(true);

	const tracked = byFile.get("tracked.txt")!;
	expect(tracked.diff).toContain("modified");
	expect(tracked.diff).toContain("original");

	const untracked = byFile.get("new.txt")!;
	expect(untracked.status[0]).toBe("?");
	expect(untracked.diff).toContain("brand new");

	const nested = byFile.get("nested/added.txt")!;
	expect(nested.status[0]).toBe("?");
	expect(nested.diff).toContain("nested brand new");
});

test("worktreeDiffSinceFork surfaces COMMITTED work that worktreeDiff blanks on", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "exp-fork-"));
	tmps.push(repo);
	const git = async (args: string[], cwd = repo) => {
		const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
		await p.exited;
	};
	await git(["init", "-q", "-b", "main"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "app.ts"), "line1\nline2\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);

	// Fork a unit worktree from main and COMMIT work into it — the state that
	// leaves `git diff HEAD` (hence worktreeDiff) empty and blanks the panel.
	const wt = path.join(repo, "..", `wt-${path.basename(repo)}`);
	tmps.push(wt);
	await git(["worktree", "add", "-q", wt, "-b", "squad/unit", "main"]);
	await fs.writeFile(path.join(wt, "app.ts"), "line1\nline2 changed\nline3\n");
	await fs.writeFile(path.join(wt, "feature.ts"), "new file\n");
	await git(["add", "."], wt);
	await git(["commit", "-qm", "unit work"], wt);

	// The bug: a committed worktree looks clean to worktreeDiff → blank review.
	expect(await worktreeDiff(wt)).toEqual([]);

	// The fix: the fork-point diff still shows the unit's committed changes.
	const committed = new Map((await worktreeDiffSinceFork(wt)).map((d) => [d.file, d]));
	expect(committed.get("app.ts")?.diff).toContain("line3");
	expect(committed.get("feature.ts")?.diff).toContain("new file");
	expect(committed.get("feature.ts")?.status[0]).toBe("A");

	// A further uncommitted edit folds into the same file entry (committed +
	// working-tree changes in one pass, no double-counting).
	await fs.writeFile(path.join(wt, "app.ts"), "line1\nline2 changed\nline3\nline4 uncommitted\n");
	const mixed = await worktreeDiffSinceFork(wt);
	expect(mixed.filter((d) => d.file === "app.ts")).toHaveLength(1);
	const app = mixed.find((d) => d.file === "app.ts")!;
	expect(app.diff).toContain("line3"); // committed
	expect(app.diff).toContain("line4 uncommitted"); // uncommitted
});

test("worktreeTree lists files dirs-first and skips .git / node_modules", async () => {
	const repo = await makeRepo();
	await fs.writeFile(path.join(repo, "new.txt"), "brand new\n");
	await fs.mkdir(path.join(repo, "src"));
	await fs.writeFile(path.join(repo, "src", "app.ts"), "export const x = 1;\n");
	await fs.mkdir(path.join(repo, "node_modules"));
	await fs.writeFile(path.join(repo, "node_modules", "ignored.js"), "//\n");

	const tree = await worktreeTree(repo);
	const topNames = tree.map((n) => n.name);

	expect(topNames).toContain("tracked.txt");
	expect(topNames).toContain("new.txt");
	expect(topNames).not.toContain(".git");
	expect(topNames).not.toContain("node_modules");

	// dirs sort before files at the same level.
	const firstFile = tree.findIndex((n) => n.type === "file");
	const lastDir = tree.map((n) => n.type).lastIndexOf("dir");
	if (firstFile >= 0 && lastDir >= 0) expect(lastDir).toBeLessThan(firstFile);

	const nested = findNode(tree, "src/app.ts");
	expect(nested?.type).toBe("file");
});

test("worktreeTree respects maxDepth and maxEntries caps", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exp-caps-"));
	tmps.push(dir);
	await fs.mkdir(path.join(dir, "a", "b", "c"), { recursive: true });
	await fs.writeFile(path.join(dir, "a", "b", "c", "deep.txt"), "x\n");

	const shallow = await worktreeTree(dir, { maxDepth: 2 });
	expect(findNode(shallow, "a")?.type).toBe("dir");
	expect(findNode(shallow, "a/b")?.type).toBe("dir");
	expect(findNode(shallow, "a/b/c")).toBeUndefined();

	await fs.writeFile(path.join(dir, "f1.txt"), "1\n");
	await fs.writeFile(path.join(dir, "f2.txt"), "2\n");
	const capped = await worktreeTree(dir, { maxEntries: 1 });
	let total = 0;
	const count = (nodes: FileNode[]) => {
		for (const n of nodes) {
			total++;
			if (n.children) count(n.children);
		}
	};
	count(capped);
	expect(total).toBe(1);
});

test("non-git dir: worktreeDiff is empty but worktreeTree still lists files", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "exp-nonrepo-"));
	tmps.push(dir);
	await fs.writeFile(path.join(dir, "loose.txt"), "hi\n");

	expect(await worktreeDiff(dir)).toEqual([]);

	const tree = await worktreeTree(dir);
	expect(tree.map((n) => n.name)).toContain("loose.txt");
});
