/**
 * Land blast-radius gate (plans/policy-and-cost-gates/ concern C-LAND) — drives `landRiskReason`
 * against a REAL throwaway git repo so the diff computation is exercised end-to-end, not faked.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { landRiskGateEnabled, landRiskReason } from "../src/land-risk.ts";

let repo: string;

function sh(args: string[], cwd = repo): void {
	const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "ignore", stderr: "ignore" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function commitFiles(files: Record<string, string>, msg: string): void {
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(repo, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, body);
	}
	sh(["add", "-A"]);
	sh(["commit", "-m", msg]);
}

beforeEach(() => {
	repo = mkdtempSync(path.join(tmpdir(), "landrisk-"));
	sh(["init", "-q", "-b", "main"]);
	commitFiles({ "README.md": "seed\n" }, "seed");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("a small, safe diff is not flagged", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" }, "small change");
	sh(["checkout", "-q", "main"]);
	expect(await landRiskReason(repo, "feat")).toBeUndefined();
});

test("a sensitive path (CI workflow) is flagged regardless of size", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ ".github/workflows/deploy.yml": "on: push\n" }, "touch CI");
	sh(["checkout", "-q", "main"]);
	const r = await landRiskReason(repo, "feat");
	expect(r).toContain("sensitive path");
	expect(r).toContain(".github/workflows/deploy.yml");
});

test("a .env / lockfile change is flagged", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ ".env": "SECRET=x\n", "bun.lock": "{}\n" }, "touch env+lock");
	sh(["checkout", "-q", "main"]);
	expect(await landRiskReason(repo, "feat")).toContain("sensitive path");
});

test("a large diff (>= cap) is flagged", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	const many: Record<string, string> = {};
	for (let i = 0; i < 45; i++) many[`src/gen/f${i}.ts`] = `export const x${i} = ${i};\n`;
	commitFiles(many, "wide change");
	sh(["checkout", "-q", "main"]);
	const r = await landRiskReason(repo, "feat");
	expect(r).toContain("45 files");
});

test("the cap is env-tunable", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	const many: Record<string, string> = {};
	for (let i = 0; i < 10; i++) many[`src/gen/f${i}.ts`] = `${i}\n`;
	commitFiles(many, "10 files");
	sh(["checkout", "-q", "main"]);
	expect(await landRiskReason(repo, "feat")).toBeUndefined(); // under default 40
	process.env.OMP_SQUAD_LAND_MAX_DIFF_FILES = "5";
	try {
		expect(await landRiskReason(repo, "feat")).toContain("10 files");
	} finally {
		delete process.env.OMP_SQUAD_LAND_MAX_DIFF_FILES;
	}
});

// Reproduce-first (eap-borrows finding #7): the OLD behavior mapped ANY probe failure to
// `undefined` (no block) — a corrupted git dir or a bogus branch name silently gave every branch a
// clean bill of health. Never throws, but a probe failure must now be indistinguishable from a real
// risk finding: a defined, blocking reason.
test("a bogus branch never throws — but is now BLOCKED (fail-closed), not silently safe", async () => {
	const r = await landRiskReason(repo, "does-not-exist");
	expect(r).toBeDefined();
	expect(r).toContain("land-risk gate:");
	expect(r).toContain("could not compute a blast radius");
});

test("an unreadable repo never throws — but is now BLOCKED (fail-closed), not silently safe", async () => {
	const r = await landRiskReason("/no/such/repo", "feat");
	expect(r).toBeDefined();
	expect(r).toContain("land-risk gate:");
	expect(r).toContain("could not compute a blast radius");
});

// Cross-lineage review (grok-4.5, eap-borrows) finding #4: `merge-base` exit 1 + empty stdout means
// "no common ancestor" — the carve-out this repo added so an orphan/grafted branch isn't misread as a
// probe failure. But for THIS gate (blast radius), "not a probe failure" must not mean "safe": with no
// merge base the diff is uncomputable, so the honest reading is maximum uncertainty, not a clean bill
// of health. Reproduced with a REAL orphan branch (git checkout --orphan), not a mock.
test("an orphan branch (no common ancestor) is BLOCKED as unknowable blast radius, not silently safe", async () => {
	sh(["checkout", "-q", "--orphan", "orphan-feat"]);
	commitFiles({ "orphan.txt": "unrelated history\n" }, "orphan root");
	sh(["checkout", "-q", "main"]);
	const r = await landRiskReason(repo, "orphan-feat");
	expect(r).toBeDefined();
	expect(r).toContain("land-risk gate:");
	expect(r).toContain("no common ancestor");
	expect(r).toContain("UNKNOWABLE");
	// Distinct from a probe failure — the gate/hatches are still named, but never the "could not compute" wording.
	expect(r).not.toContain("could not compute a blast radius");
});

// Finding #4 continued (shallow-clone twin): `git merge-base` emits the SAME exit-1/empty-stdout
// signal for a shallow clone's truncated history as for a genuinely orphan branch — the carve-out
// above can't tell the difference, so a shallow repo must fail closed as an ordinary probe failure
// instead of guessing "unknowable, maximum blast radius". Reproduced with a REAL shallow clone
// (`git clone --depth 1`), not a mock of `--is-shallow-repository`.
test("a shallow clone gets the merge-base twin signal but fails closed as a probe failure, not the orphan wording", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "src/a.ts": "export const a = 1;\n" }, "feat work");
	sh(["checkout", "-q", "main"]);

	const shallow = mkdtempSync(path.join(tmpdir(), "landrisk-shallow-"));
	try {
		// `--no-single-branch --depth 1` shallow-clones EVERY branch to depth 1 independently — `main`
		// and `feat` each get grafted at their own tip, so locally they share no known common ancestor
		// even though the real (unfetched) history is linear. That reproduces the exact exit-1/empty-
		// stdout signal the orphan-branch test above exercises, but for a reason that must fail closed
		// instead of reading as "genuinely orphan, maximum blast radius".
		const clone = Bun.spawnSync(["git", "clone", "-q", "--depth", "1", "--no-single-branch", `file://${repo}`, shallow], { stdout: "ignore", stderr: "ignore" });
		if (clone.exitCode !== 0) throw new Error("git clone --depth 1 failed");

		const isShallow = Bun.spawnSync(["git", "rev-parse", "--is-shallow-repository"], { cwd: shallow, stdout: "pipe", stderr: "ignore" });
		expect(new TextDecoder().decode(isShallow.stdout).trim()).toBe("true"); // sanity: the fixture really is shallow

		const r = await landRiskReason(shallow, "origin/feat", "main");
		expect(r).toBeDefined();
		expect(r).toContain("land-risk gate:");
		expect(r).toContain("could not compute a blast radius");
		expect(r).toContain("SHALLOW clone");
	} finally {
		rmSync(shallow, { recursive: true, force: true });
	}
});

test("the gate is OFF by default", () => {
	expect(landRiskGateEnabled()).toBe(false);
	process.env.OMP_SQUAD_LAND_RISK_GATE = "1";
	try {
		expect(landRiskGateEnabled()).toBe(true);
	} finally {
		delete process.env.OMP_SQUAD_LAND_RISK_GATE;
	}
});
