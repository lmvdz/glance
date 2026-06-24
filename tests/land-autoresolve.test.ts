/**
 * Automated conflict-resolver (#12). A real temp-git divergent conflict (both sides edit the same
 * file) drives landAgent down its conflict path. The resolver + reviewer are injected, so no real
 * omp runs. We prove the contract: gated OFF by default; ON, it only completes a resolution that is
 * PROVEN (verify gate green AND reviewer approves); any failing step rolls main back, leaving it as
 * if the land never happened.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ConflictResolver, landAgent, type ResolutionReviewer } from "../src/land.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const savedAuto = process.env.OMP_SQUAD_AUTORESOLVE;
afterEach(() => {
	if (savedAuto === undefined) delete process.env.OMP_SQUAD_AUTORESOLVE;
	else process.env.OMP_SQUAD_AUTORESOLVE = savedAuto;
});

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

/** Build a repo whose `main` and a `feat` worktree both edit `f.txt` → a guaranteed merge conflict. */
async function conflictRepo(): Promise<{ repo: string; wt: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "land-ar-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "f.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");

	// feat branch in its own worktree changes f.txt one way…
	await git(repo, "branch", "feat");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "land-ar-wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");
	await fs.writeFile(path.join(wt, "f.txt"), "branch\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "feat edit");

	// …and main changes the SAME line another way → divergent conflict on land.
	await fs.writeFile(path.join(repo, "f.txt"), "main\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "main edit");
	return { repo, wt };
}

async function mainFile(repo: string): Promise<string> {
	return (await fs.readFile(path.join(repo, "f.txt"), "utf8")).trim();
}

/** Writes a clean resolution into every conflicted file, then reports success. */
const writeResolution: ConflictResolver = async ({ worktree, files }) => {
	for (const f of files) await fs.writeFile(path.join(worktree, f), "resolved\n");
	return true;
};
const approve: ResolutionReviewer = async () => true;
const reject: ResolutionReviewer = async () => false;

test("autoresolve OFF: conflicting land fails and leaves main untouched", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "0"; // now opt-OUT: autoresolve is on by default, so disable it explicitly
	const { repo, wt } = await conflictRepo();
	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, resolver: writeResolution, reviewer: approve });
	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(await mainFile(repo)).toBe("main"); // never touched
});

test("autoresolve ON: proven resolution (verify green + reviewer approves) lands", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo();
	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: writeResolution, reviewer: approve });
	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(await mainFile(repo)).toBe("resolved"); // resolved content is on main HEAD
});

test("autoresolve ON: reviewer rejection rolls main back (unproven ⇒ never kept)", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo();
	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: writeResolution, reviewer: reject });
	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(await mainFile(repo)).toBe("main"); // rolled back to keep main green
});

test("autoresolve ON: a failed verify gate rolls main back", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo();
	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "false", resolver: writeResolution, reviewer: approve });
	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(await mainFile(repo)).toBe("main"); // gate failed ⇒ rolled back
});

test("autoresolve ON: a resolver that gives up aborts cleanly", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo();
	const giveUp: ConflictResolver = async () => false;
	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: giveUp, reviewer: approve });
	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(await mainFile(repo)).toBe("main"); // rebase aborted, main intact
});

test("confirmResolved: a resolved conflict is STAGED, not merged — main untouched, then operator land fast-forwards (OMPSQ-138)", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo();
	let reviewed = false;
	const watchReviewer: ResolutionReviewer = async () => {
		reviewed = true;
		return true;
	};
	// Auto land with the confirm hold: resolve on the branch, but hold the merge for a one-tap Land.
	const staged = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", confirmResolved: true, resolver: writeResolution, reviewer: watchReviewer });
	expect(staged.ok).toBe(false);
	expect(staged.staged).toBe(true);
	expect(staged.merged).toBe(false);
	expect(reviewed).toBe(false); // the human is the gate in confirm mode — no LLM reviewer call
	expect(await mainFile(repo)).toBe("main"); // NOT merged — main is exactly where it was

	// The operator's one-tap Land (confirmResolved:false) keeps the resolved merge: the branch is
	// already rebased onto main, so this fast-forwards cleanly without a second resolve.
	const landed = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: writeResolution, reviewer: approve });
	expect(landed.ok).toBe(true);
	expect(landed.merged).toBe(true);
	expect(await mainFile(repo)).toBe("resolved");
});
