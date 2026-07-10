/**
 * Transplant gate — `transplantedCommitsReason` (src/land-pr.ts).
 *
 * Found by cross-lineage review (gpt-5.6-sol + grok-4.5) of the probe-4 removal in land-mode.ts.
 * With pr mode now reachable from a non-default operator checkout, an EXISTING `squad/*` branch that
 * was forked from an operator branch (worktree.ts reuses an existing branch ref and ignores the
 * caller's start point) would have its whole history pushed and merged into origin/<default> —
 * publishing the operator's private, unpushed commits as a side effect of landing an unrelated unit.
 * Local mode never did this: it merged such a branch back into the checkout it came from.
 *
 * Real git in tmp dirs + a real bare "origin" (the convention of land-mode.test.ts / land-pr.test.ts).
 * No `gh`, no network — the gate is pure git reachability.
 *
 * A false POSITIVE here is as bad as a false negative: it would refuse every land, which is exactly
 * the class of silent, total blockage this whole change exists to remove. Hence the negative cases.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { transplantedCommitsReason } from "../src/land-pr.ts";

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

async function commit(repo: string, file: string, body: string, msg: string): Promise<void> {
	await fs.writeFile(path.join(repo, file), body);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", msg);
}

/** repo on `main`, one commit, pushed to a fresh bare origin. */
async function converged(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await commit(repo, "base.txt", "base\n", "base");
	const origin = await tmpDir(`${prefix}origin-`);
	await git(origin, "init", "-q", "--bare");
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "main");
	await git(repo, "fetch", "-q", "origin", "main");
	return repo;
}

// ── the hazard ──────────────────────────────────────────────────────────────────────────────────

test("BLOCKS a squad branch forked from an operator branch that carries unpushed operator commits", async () => {
	const repo = await converged("tp-hazard-");
	await git(repo, "checkout", "-qb", "feat/mine");
	await commit(repo, "secret.txt", "operator's private work\n", "operator: unpushed WIP");
	// The pre-PR-mode daemon forked the unit from the operator's HEAD, not from origin/main.
	await git(repo, "checkout", "-qb", "squad/unit-1");
	await commit(repo, "agent.txt", "agent work\n", "agent: the actual unit");

	const reason = await transplantedCommitsReason(repo, "squad/unit-1", "main");
	expect(reason).toBeDefined();
	expect(reason).toContain("transplant gate blocked squad/unit-1");
	expect(reason).toContain("operator: unpushed WIP");
	expect(reason).toContain("1 commit(s)");
	// The agent's own commit must NOT be named as stolen.
	expect(reason).not.toContain("agent: the actual unit");
});

test("BLOCKS while naming only the operator commits, and caps the list", async () => {
	const repo = await converged("tp-many-");
	await git(repo, "checkout", "-qb", "feat/mine");
	for (const n of [1, 2, 3, 4]) await commit(repo, `o${n}.txt`, `${n}\n`, `operator commit ${n}`);
	await git(repo, "checkout", "-qb", "squad/unit-2");
	await commit(repo, "agent.txt", "a\n", "agent work");

	const reason = await transplantedCommitsReason(repo, "squad/unit-2", "main");
	expect(reason).toContain("4 commit(s)");
	expect(reason).toContain("(+1 more)"); // 4 stolen, 3 shown
});

// ── the negative cases: a false positive here re-breaks landing entirely ────────────────────────

test("ALLOWS the normal case: a unit forked from origin/main with only its own commits", async () => {
	const repo = await converged("tp-clean-");
	await git(repo, "checkout", "-qb", "squad/unit-3", "origin/main");
	await commit(repo, "agent.txt", "a\n", "agent work");

	expect(await transplantedCommitsReason(repo, "squad/unit-3", "main")).toBeUndefined();
});

test("ALLOWS a STACKED unit: squad/b forked from squad/a is still fleet work, not a transplant", async () => {
	const repo = await converged("tp-stacked-");
	await git(repo, "checkout", "-qb", "squad/unit-a", "origin/main");
	await commit(repo, "a.txt", "a\n", "unit a work");
	await git(repo, "checkout", "-qb", "squad/unit-b");
	await commit(repo, "b.txt", "b\n", "unit b work");

	expect(await transplantedCommitsReason(repo, "squad/unit-b", "main")).toBeUndefined();
});

test("ALLOWS when the operator branch's commits are already on origin/<default> (nothing private to leak)", async () => {
	const repo = await converged("tp-pushed-");
	await git(repo, "checkout", "-qb", "feat/mine");
	await commit(repo, "shared.txt", "s\n", "operator work, already pushed");
	await git(repo, "push", "-q", "origin", "feat/mine:main"); // it IS on the remote default now
	await git(repo, "fetch", "-q", "origin", "main");
	await git(repo, "checkout", "-qb", "squad/unit-4");
	await commit(repo, "agent.txt", "a\n", "agent work");

	expect(await transplantedCommitsReason(repo, "squad/unit-4", "main")).toBeUndefined();
});

test("ALLOWS a branch with nothing ahead of origin/<default> (no commits to publish at all)", async () => {
	const repo = await converged("tp-empty-");
	await git(repo, "checkout", "-qb", "squad/unit-5", "origin/main");

	expect(await transplantedCommitsReason(repo, "squad/unit-5", "main")).toBeUndefined();
});

test("does not blow up on a nonexistent branch — returns undefined rather than throwing", async () => {
	const repo = await converged("tp-missing-");
	expect(await transplantedCommitsReason(repo, "squad/does-not-exist", "main")).toBeUndefined();
});

// finding #4 (eap-borrows wave 2): the ORIGINAL checks collapsed "rev-list failed for a REAL reason
// (corrupted objects, permissions, transient git error)" into the SAME `undefined` as "nothing ahead"
// — a probe failure silently ALLOWED publishing whatever the probe couldn't actually check. Making
// `.git/objects` unreadable breaks `git rev-list` with a genuine "not a git repository" class error
// (distinct from "unknown revision", which this fix deliberately still allows — see the negative
// case above) — the exact probe-failure shape this finding hardens.
test("finding #4: a rev-list PROBE FAILURE (unreadable .git/objects) BLOCKS — never silently allows publishing", async () => {
	const repo = await converged("tp-probefail-");
	await git(repo, "checkout", "-qb", "squad/unit-probe", "origin/main");
	await commit(repo, "agent.txt", "a\n", "agent work");

	const objectsDir = path.join(repo, ".git", "objects");
	await fs.chmod(objectsDir, 0o000);
	try {
		const reason = await transplantedCommitsReason(repo, "squad/unit-probe", "main");
		// OLD behavior (fail-open): this returned undefined (allow). NEW behavior: blocks with a distinct
		// probe-failure reason, never silently allowing a land whose lineage it couldn't actually check.
		expect(reason).toBeDefined();
		expect(reason).toContain("transplant gate");
		expect(reason).toContain("could not prove");
	} finally {
		await fs.chmod(objectsDir, 0o755);
	}
});
