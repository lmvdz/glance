import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Proof } from "../src/proof.ts";
import type { Judge, LensJudge } from "../src/validator.ts";
import { validatorGate } from "../src/validator.ts";

/**
 * Live sanity for concern 06's flag gate: everything above (`validator.flags.test.ts`,
 * `validator.gate-lens.test.ts`) proves default-off / flag-on via a fake diff or by calling
 * `runLensPanel` directly. This file drives the FULL `validatorGate` — real git repo, real
 * `computeLandDiff`, no mocking of the diff machinery — to prove the master flag actually gates
 * the lens INSIDE the real land path, not just in the unit-tested seams around it.
 */

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	delete process.env.OMP_SQUAD_LENS_REVIEW;
});

async function git(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out.trim();
}

/** A real repo with a base commit and one non-docs change on top, so `computeLandDiff` sees a
 *  genuine `src/*.ts`-shaped diff (not docs/lockfile-only, so the affordability gate wouldn't
 *  skip it even with the master flag on). */
async function realDiffRepo(): Promise<{ repo: string; baseCommit: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lens-live-"));
	tmps.push(repo);
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "test@example.com");
	await git(repo, "config", "user.name", "test");
	await fs.writeFile(path.join(repo, "thing.ts"), "export const a = 1;\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const baseCommit = await git(repo, "rev-parse", "HEAD");
	await fs.writeFile(path.join(repo, "thing.ts"), "export const a = 2;\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "change");
	return { repo, baseCommit };
}

const passJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c) => ({ id: c.id, satisfied: true })) });

describe("validatorGate lens gate — live git diff (concern 06 default-off contract)", () => {
	test("master flag unset ⇒ real land path never invokes the lens judge, no lensAdvisory", async () => {
		const { repo, baseCommit } = await realDiffRepo();
		let calls = 0;
		const lensJudge = (() =>
			(async () => {
				calls++;
				return { lens: "regression", disposition: "object", severity: "high", claim: "should never fire" };
			})) as unknown as (l: import("../src/lens-select.ts").LensId) => LensJudge;
		const { record } = await validatorGate({
			criteria: [{ id: "c1", text: "does the thing", completed: false }],
			repo,
			worktree: repo,
			proof: { baseCommit } as Proof,
			judge: passJudge,
			lensJudge,
		});
		expect(record.verdict).toBe("pass");
		expect(calls).toBe(0);
		expect(record.lensAdvisory).toBeUndefined();
	});

	test("master flag ON ⇒ real land path fires the lens and threads its verdict onto the record", async () => {
		process.env.OMP_SQUAD_LENS_REVIEW = "1";
		const { repo, baseCommit } = await realDiffRepo();
		let calls = 0;
		const lensJudge = (() =>
			(async () => {
				calls++;
				return { lens: "regression" as const, disposition: "object" as const, severity: "high" as const, claim: "flagged on the real diff" };
			})) as unknown as (l: import("../src/lens-select.ts").LensId) => LensJudge;
		const { record } = await validatorGate({
			criteria: [{ id: "c1", text: "does the thing", completed: false }],
			repo,
			worktree: repo,
			proof: { baseCommit } as Proof,
			judge: passJudge,
			lensJudge,
		});
		expect(record.verdict).toBe("pass");
		expect(calls).toBe(1);
		expect(record.lensAdvisory).toEqual([{ lens: "regression", disposition: "object", severity: "high", claim: "flagged on the real diff" }]);
		// Advisory only — the objection never turns a pass into a veto.
		expect(record.verdict).not.toBe("veto");
	});
});
