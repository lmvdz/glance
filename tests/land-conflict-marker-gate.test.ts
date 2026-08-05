/**
 * Conflict-marker gate wired into the local land path (#330, per #327's resolution; hardened in
 * gauntlet round 1 AND the delta-verify round against PR #351) — drives the REAL `landAgent` end to
 * end (real temp git repos, no mocks), covering all three local-mode call sites:
 *   1. the ORDINARY path: a POST-merge scan inside `verifyMerged` (`head0..HEAD`, gauntlet #9 — not
 *      a merge-base diff) for a branch that carries a live marker line before any conflict happens.
 *   2. the IN-PLACE path (gauntlet #2): `worktree === repo` used to commit and return success with
 *      no gate ever running — now scans the STAGED diff before the commit.
 *   3. the AUTORESOLVE path (`attemptAutoResolve`, gauntlet #8): a FULL-FILE scan of resolver-touched
 *      files, not an added-lines diff — the scenario the ticket actually names, an AUTORESOLVE
 *      resolver that writes a "resolution" which still leaves live conflict-marker debris behind,
 *      surviving typecheck+test for a .md/.json/.txt file.
 * PR-mode coverage (round 1's CRITICAL finding — PR mode never ran this check at all) lives in
 * tests/land-pr.test.ts, alongside its existing gh-mock + scratch-merge infrastructure.
 *
 * Delta-verify round (CRITICAL, both lineages): round 1's path allowlist and in-file exempt token
 * were both agent-settable — DELETED. The ONLY exemption now is `conflictMarkerGate: false`, the
 * SAME force-land authority that already overrides `staleGate`/`riskOverride`, set only by a human's
 * explicit Force action — never by anything the candidate diff can write. "conflictMarkerGate:false
 * (force-land) merges a branch carrying markers" below (and its AUTORESOLVE twin further down) prove
 * that path still works; every allowlist/token case that used to prove "allowed" now lives in
 * tests/conflict-markers.test.ts proving "refused unless force". `attemptAutoResolve`'s unicode-path
 * test (delta-verify finding #2, codex) proves the `-z`/NUL fix to `land.ts`'s conflicted-file
 * gathering — a non-ASCII filename no longer silently escapes the full-file scan.
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
async function out(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
	const [s] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return s.trim();
}

async function baseRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "README.md"), "seed\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

async function branchWorktree(repo: string, branch: string, edit: (wt: string) => Promise<void>): Promise<string> {
	await git(repo, "branch", branch);
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cm-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	await edit(wt);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `branch ${branch}`);
	return wt;
}

// ── 1. Ordinary (non-conflicting) path: a branch that already carries a live marker ─────────────────

test("a branch adding a live conflict marker in a changed .md file is refused, main untouched", async () => {
	const repo = await baseRepo("cm-plain-");
	const head0 = await out(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", async (dir) => {
		await fs.mkdir(path.join(dir, "docs"), { recursive: true });
		await fs.writeFile(path.join(dir, "docs", "plan.md"), ["# Plan", "", "<<<<<<< HEAD", "old approach", "=======", "new approach", ">>>>>>> feat", ""].join("\n"));
	});

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("conflict-markers gate:");
	expect(res.detail).toContain("docs/plan.md");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // nothing merged, main untouched
});

test("a clean branch (no markers) lands normally — the gate never blocks ordinary work", async () => {
	const repo = await baseRepo("cm-clean-");
	const wt = await branchWorktree(repo, "feat", async (dir) => fs.writeFile(path.join(dir, "src.ts"), "export const a = 1;\n"));

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});

test("conflictMarkerGate:false (force-land) merges a branch carrying markers", async () => {
	const repo = await baseRepo("cm-forced-");
	const wt = await branchWorktree(repo, "feat", async (dir) => fs.writeFile(path.join(dir, "notes.md"), ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feat", ""].join("\n")));

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "", conflictMarkerGate: false });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});

// Delta-verify #1: the human-authority-only exemption model, made concrete. A tests/fixtures/ path
// with real markers (round 1's deleted path allowlist) is refused by DEFAULT — legitimate
// marker-carrying content only lands through the SAME force-land a human uses for any other
// deliberately-unusual land, never through anything the candidate diff itself can set.
test("delta-verify #1: a tests/fixtures/*.md with real markers is refused by default, but a human force-land still lands it", async () => {
	const repo = await baseRepo("cm-fixtures-default-");
	const wt = await branchWorktree(repo, "feat", async (dir) => {
		await fs.mkdir(path.join(dir, "tests", "fixtures"), { recursive: true });
		await fs.writeFile(path.join(dir, "tests", "fixtures", "conflict-example.md"), ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n"));
	});

	const refused = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });
	expect(refused.ok).toBe(false);
	expect(refused.detail).toContain("conflict-markers gate:");
	expect(refused.detail).toContain("tests/fixtures/conflict-example.md");

	const forced = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "", conflictMarkerGate: false });
	expect(forced.ok).toBe(true);
	expect(forced.merged).toBe(true);
});

test("OMP_SQUAD_CONFLICT_MARKER_GATE=0 disables the gate globally", async () => {
	const repo = await baseRepo("cm-envoff-");
	const wt = await branchWorktree(repo, "feat", async (dir) => fs.writeFile(path.join(dir, "notes.md"), ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feat", ""].join("\n")));

	process.env.OMP_SQUAD_CONFLICT_MARKER_GATE = "0";
	try {
		const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });
		expect(res.ok).toBe(true);
		expect(res.merged).toBe(true);
	} finally {
		delete process.env.OMP_SQUAD_CONFLICT_MARKER_GATE;
	}
});

// ── 1b. The IN-PLACE path (worktree === repo, gauntlet #2): used to commit before any gate ran ───────

test("in-place land (worktree === repo): a staged file with markers is refused BEFORE the commit", async () => {
	const repo = await baseRepo("cm-inplace-");
	const head0 = await out(repo, "rev-parse", "HEAD");
	await fs.mkdir(path.join(repo, "docs"), { recursive: true });
	await fs.writeFile(path.join(repo, "docs", "plan.md"), ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n"));

	const res = await landAgent({ repo, worktree: repo, message: "wip commit", commitWip: true, verify: "" });

	expect(res.ok).toBe(false);
	expect(res.committed).toBe(false);
	expect(res.detail).toContain("conflict-markers gate:");
	expect(res.detail).toContain("docs/plan.md");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // nothing committed — refused before the commit
});

test("in-place land: a clean staged change commits normally (the gate never blocks ordinary WIP sweeps)", async () => {
	const repo = await baseRepo("cm-inplace-clean-");
	await fs.writeFile(path.join(repo, "src.ts"), "export const a = 1;\n");

	const res = await landAgent({ repo, worktree: repo, message: "wip commit", commitWip: true, verify: "" });

	expect(res.ok).toBe(true);
	expect(res.committed).toBe(true);
	expect(res.merged).toBe(false); // in-place: nothing to merge, unchanged contract
});

test("in-place land: conflictMarkerGate:false (force) commits a staged file carrying markers", async () => {
	const repo = await baseRepo("cm-inplace-forced-");
	await fs.mkdir(path.join(repo, "docs"), { recursive: true });
	await fs.writeFile(path.join(repo, "docs", "plan.md"), ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n"));

	const res = await landAgent({ repo, worktree: repo, message: "wip commit", commitWip: true, verify: "", conflictMarkerGate: false });

	expect(res.ok).toBe(true);
	expect(res.committed).toBe(true);
});

// ── 2. The AUTORESOLVE path: the ticket's actual scenario ────────────────────────────────────────────
// A real divergent conflict, resolved by an injected "resolver" that (like a careless LLM resolver)
// writes a .md file that is perfectly valid content and would sail through typecheck+test, but still
// carries live `<<<<<<<`/`=======`/`>>>>>>>` debris. Only a textual scan catches this.

async function conflictRepo(fileName: string): Promise<{ repo: string; wt: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ar-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, fileName), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");

	await git(repo, "branch", "feat");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cm-ar-wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");
	await fs.writeFile(path.join(wt, fileName), "branch version\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "feat edit");

	await fs.writeFile(path.join(repo, fileName), "main version\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "main edit");
	return { repo, wt };
}

async function mainFile(repo: string, fileName: string): Promise<string> {
	return (await fs.readFile(path.join(repo, fileName), "utf8")).trim();
}

/** The bug this ticket closes: a "resolver" (standing in for an LLM) that reports success while
 *  leaving live conflict-marker debris in a doc file that still parses/compiles fine. */
const resolverLeavesMarkers: ConflictResolver = async ({ worktree, files }) => {
	for (const f of files) await fs.writeFile(path.join(worktree, f), ["<<<<<<< HEAD", "branch version", "=======", "main version", ">>>>>>> feat", ""].join("\n"));
	return true;
};
const resolverIsClean: ConflictResolver = async ({ worktree, files }) => {
	for (const f of files) await fs.writeFile(path.join(worktree, f), "properly resolved\n");
	return true;
};
const approve: ResolutionReviewer = async () => true;

test("AUTORESOLVE: a resolver that leaves live markers in a .md is refused, main rolled back", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo("plan.md");
	const head0 = await out(repo, "rev-parse", "HEAD");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: resolverLeavesMarkers, reviewer: approve });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("auto-resolve:");
	expect(res.detail).toContain("conflict-markers gate:");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // main never advanced past head0
});

test("AUTORESOLVE: a genuinely clean resolution still lands (the gate never blocks a real fix)", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo("plan.md");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: resolverIsClean, reviewer: approve });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(await mainFile(repo, "plan.md")).toBe("properly resolved");
});

test("AUTORESOLVE: conflictMarkerGate:false (force-land) keeps a marker-laden auto-resolved merge", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo("plan.md");

	const res = await landAgent({
		repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true",
		resolver: resolverLeavesMarkers, reviewer: approve, conflictMarkerGate: false,
	});

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});

// ── delta-verify #2 (codex): a unicode conflicted filename must not silently escape the scan ──────
// `attemptAutoResolve`'s file-gathering used to run plain `git diff --name-only --diff-filter=U`.
// With the default `core.quotePath=true`, git quotes/octal-escapes any path it considers "unusual"
// (anything outside 7-bit ASCII, e.g. `é.md`) — the ESCAPED string then entered `touchedFiles`, and
// `git show <ref>:<that escaped string>` can never resolve it, silently skipping the file's scan.
// Fixed with `-z` (NUL-separated raw bytes, no quoting). Reproduced with a REAL non-ASCII filename.

test("delta-verify #2 (codex): AUTORESOLVE catches marker debris in a real unicode-named conflicted file", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo("é.md");
	const head0 = await out(repo, "rev-parse", "HEAD");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: resolverLeavesMarkers, reviewer: approve });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("auto-resolve:");
	expect(res.detail).toContain("conflict-markers gate:");
	expect(res.detail).toContain("é.md");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // main never advanced past head0
});
