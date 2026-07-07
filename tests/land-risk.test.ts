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

test("an unreadable repo / bogus branch never throws — returns undefined (fail-open)", async () => {
	expect(await landRiskReason(repo, "does-not-exist")).toBeUndefined();
	expect(await landRiskReason("/no/such/repo", "feat")).toBeUndefined();
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
