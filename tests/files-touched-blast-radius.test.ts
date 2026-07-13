/**
 * `filesTouchedSinceBase` (src/explore.ts) — a unit's real blast radius.
 *
 * The receipt's `filesTouched` was a bare `git status --porcelain` probe, so it counted only
 * UNCOMMITTED paths. Any unit that committed its own work reported ZERO files touched. That number is
 * not decorative: `confidence.ts` scores `filesTouched <= 3` as a small-blast-radius BONUS (+0.1) and
 * `> 12` as a penalty (−0.2), and confidence gates auto-land. A twenty-file change scored as if it had
 * touched nothing — and got the bonus.
 *
 * Measured on this host's live ledger before the fix: 16 of 18 landed/rejected `task-outcomes` rows
 * carried `filesTouched: 0`, including one whose change really touched sixteen files. `commitAgentWip`
 * (the daemon's own pre-verify sweep) makes committed work the normal case, so the signal had to become
 * base-relative or it would have gone permanently to zero.
 *
 * Real git in tmp dirs, no mocks.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { changedFiles, filesTouchedSinceBase } from "../src/explore.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`git ${a.join(" ")} failed in ${cwd}`);
	return out.trim();
}

async function write(dir: string, rel: string, body: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
	await fs.writeFile(path.join(dir, rel), body);
}

/** A repo on `main` with one commit, then a unit branch forked from it. */
async function unitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await write(repo, "base.txt", "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "branch", "base-ref"); // stand-in for origin/<default>
	await git(repo, "checkout", "-qb", "squad/unit");
	return repo;
}

// ── the defect ──────────────────────────────────────────────────────────────────────────────────

test("COMMITTED work counts — the case that zeroed 16 of 18 live ledger rows", async () => {
	const wt = await unitRepo("ftb-committed-");
	await write(wt, "a.ts", "export const a = 1;\n");
	await write(wt, "b.ts", "export const b = 2;\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "the agent committed its own work");

	expect(await changedFiles(wt)).toEqual([]); // the old probe saw nothing at all
	const touched = await filesTouchedSinceBase(wt, "base-ref");
	expect(touched.sort()).toEqual(["a.ts", "b.ts"]);
});

test("committed AND uncommitted AND untracked work are unioned, deduped", async () => {
	const wt = await unitRepo("ftb-union-");
	await write(wt, "committed.ts", "1\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "committed");
	await write(wt, "committed.ts", "1\n2\n"); // same file, now also dirty
	await write(wt, "base.txt", "edited\n"); // tracked edit, uncommitted
	await write(wt, "brand-new.ts", "3\n"); // untracked

	const touched = await filesTouchedSinceBase(wt, "base-ref");
	expect(touched.sort()).toEqual(["base.txt", "brand-new.ts", "committed.ts"]);
});

// ── it must measure THIS unit, not the base's own movement ──────────────────────────────────────

/** Diffed from the merge base, not from `baseRef`'s tip: files the base changed after this unit forked
 *  are not this unit's blast radius. Without three-dot semantics, a busy base inflates every unit. */
test("files the BASE changed after the fork are not counted as the unit's", async () => {
	const wt = await unitRepo("ftb-base-moved-");
	await write(wt, "mine.ts", "mine\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "unit work");

	// The base branch advances with a big, unrelated change.
	await git(wt, "checkout", "-q", "base-ref");
	for (const n of [1, 2, 3, 4, 5]) await write(wt, `theirs${n}.ts`, `${n}\n`);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "someone else's five files");
	await git(wt, "checkout", "-q", "squad/unit");

	const touched = await filesTouchedSinceBase(wt, "base-ref");
	expect(touched).toEqual(["mine.ts"]); // not six
});

test("excludes the daemon's own .omp/ evidence dir", async () => {
	const wt = await unitRepo("ftb-omp-");
	await write(wt, "real.ts", "1\n");
	await write(wt, ".omp/proof/screenshot.png", "not a png\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "work plus evidence");

	expect(await filesTouchedSinceBase(wt, "base-ref")).toEqual(["real.ts"]);
});

// ── never throw, never fabricate ────────────────────────────────────────────────────────────────

test("an unresolvable base falls back to the uncommitted probe rather than throwing", async () => {
	const wt = await unitRepo("ftb-nobase-");
	await write(wt, "dirty.ts", "1\n");

	const touched = await filesTouchedSinceBase(wt, "refs/heads/does-not-exist");
	expect(touched).toEqual(["dirty.ts"]); // == changedFiles(); no throw
});

test("unrelated histories (no merge base) fall back rather than inventing a diff", async () => {
	const wt = await unitRepo("ftb-unrelated-");
	await git(wt, "checkout", "-q", "--orphan", "stranger");
	await git(wt, "rm", "-rq", "--cached", ".");
	await write(wt, "only.ts", "1\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "unrelated root");
	await write(wt, "dirty.ts", "2\n");

	const touched = await filesTouchedSinceBase(wt, "base-ref");
	expect(touched).toEqual(["dirty.ts"]); // merge-base fails ⇒ uncommitted only
});

test("a clean unit with no work reports nothing", async () => {
	const wt = await unitRepo("ftb-clean-");
	expect(await filesTouchedSinceBase(wt, "base-ref")).toEqual([]);
});

test("not a git repo ⇒ empty, never a throw", async () => {
	const dir = await tmpDir("ftb-nogit-");
	expect(await filesTouchedSinceBase(dir, "main")).toEqual([]);
});
