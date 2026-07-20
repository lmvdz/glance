/**
 * Concern 08 — observe-only land hook. Drives the hook against a real temp git repo and reads the
 * store back, asserting: one event per stage with a single threaded attemptId and monotonic seq; a
 * background analysis attaches a snapshot; a landed terminal carries R and triggers accepted-state
 * extraction; and — the load-bearing invariant — NO method throws even when persistence is impossible.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LandAssessmentHook } from "./hook.ts";
import { computeRepositoryId } from "./id.ts";
import { readManifest } from "./manifest.ts";
import { reconstructRepositoryStore } from "./store-reader.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
	return (await new Response(p.stdout).text()).trim();
}

async function tmp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A repo with a commit on main and a feature branch carrying one more commit (the candidate). */
async function repoWithCandidate(): Promise<{ repo: string; stateDir: string }> {
	const repo = await tmp("hook-repo-");
	const stateDir = await tmp("hook-state-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "checkout", "-q", "-b", "feature");
	await fs.writeFile(path.join(repo, "b.ts"), "export const b = 2;\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "candidate");
	await git(repo, "checkout", "-q", "main"); // daemon's checkout sits on main; feature is the candidate ref
	return { repo, stateDir };
}

async function eventsFor(stateDir: string, repo: string) {
	const store = await reconstructRepositoryStore(stateDir, computeRepositoryId(repo));
	expect(store.malformed).toEqual([]);
	return store.attempts.flatMap((a) => a.events);
}

/** Poll until the background analysis has appended its `assessment-attached` event (fire-and-forget). */
async function waitForStage(stateDir: string, repo: string, stage: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await eventsFor(stateDir, repo)).some((e) => e.stage === stage)) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error(`no ${stage} event within ${timeoutMs}ms`);
}

test("beginAttempt: one attempt-started with a threaded attemptId + a background assessment-attached", async () => {
	const { repo, stateDir } = await repoWithCandidate();
	const hook = new LandAssessmentHook(stateDir);

	const attemptId = await hook.beginAttempt(repo, "feature");
	expect(attemptId).toBeString();

	await waitForStage(stateDir, repo, "assessment-attached");
	const events = await eventsFor(stateDir, repo);

	// Exactly one attempt-started, and every event threads the SAME attemptId with a monotonic seq from 0.
	expect(events.filter((e) => e.stage === "attempt-started")).toHaveLength(1);
	expect(events.every((e) => e.attemptId === attemptId)).toBe(true); // one threaded id across every event
	expect(new Set(events.map((e) => e.seq))).toEqual(new Set(events.map((_e, i) => i))); // seqs are 0..n-1, no gaps/dupes
	const attached = events.find((e) => e.stage === "assessment-attached");
	expect(attached?.assessmentKey).toBeString();
	// The snapshot the event references is actually persisted.
	const store = await reconstructRepositoryStore(stateDir, computeRepositoryId(repo));
	expect(store.snapshotsByAssessmentKey.get(attached!.assessmentKey!)).toBeDefined();
});

test("recordRejection: a single rejected terminal with its reason code, threaded to the same attempt", async () => {
	const { repo, stateDir } = await repoWithCandidate();
	const hook = new LandAssessmentHook(stateDir);
	const attemptId = await hook.beginAttempt(repo, "feature");
	await hook.recordRejection(attemptId, repo, "observer-refusal", "an observer never lands");

	const events = await eventsFor(stateDir, repo);
	const rejected = events.filter((e) => e.stage === "rejected");
	expect(rejected).toHaveLength(1);
	expect(rejected[0]!.attemptId).toBe(attemptId!);
	expect(rejected[0]!.reason).toEqual({ code: "observer-refusal", detail: "an observer never lands" });
});

test("recordLanded: a landed terminal carries R (post-merge HEAD) and triggers accepted-state extraction", async () => {
	const { repo, stateDir } = await repoWithCandidate();
	// Simulate the land having merged the candidate into main: HEAD is now the landed result R.
	await git(repo, "merge", "--no-ff", "-q", "-m", "land feature", "feature");
	const rHead = await git(repo, "rev-parse", "HEAD");

	const hook = new LandAssessmentHook(stateDir);
	const attemptId = await hook.beginAttempt(repo, "feature");
	await hook.recordLanded(attemptId, repo);

	const landed = (await eventsFor(stateDir, repo)).filter((e) => e.stage === "landed");
	expect(landed).toHaveLength(1);
	expect(landed[0]!.resultCommit).toBe(rHead); // C→R: the landed result, not the candidate
	expect(landed[0]!.resultTree).toBeString();

	// Concern-11 accepted-state extraction fired against R (fire-and-forget — poll for the manifest).
	const deadline = Date.now() + 4000;
	let manifest = await readManifest(stateDir, computeRepositoryId(repo), rHead);
	while (!manifest && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 40));
		manifest = await readManifest(stateDir, computeRepositoryId(repo), rHead);
	}
	expect(manifest?.state.commit).toBe(rHead);
});

test("OBSERVE-ONLY: no method throws even when persistence is impossible (a hook failure is never a land failure)", async () => {
	const { repo } = await repoWithCandidate();
	// Point the store at a path that cannot be created (a file where a directory must go) so every append
	// fails internally. Not one call may reject — the land path must be totally unaffected.
	const badParent = await tmp("hook-bad-");
	const blocker = path.join(badParent, "blocker");
	await fs.writeFile(blocker, "x");
	const stateDir = path.join(blocker, "nested"); // under a regular file → mkdir will fail
	const hook = new LandAssessmentHook(stateDir);

	const attemptId = await hook.beginAttempt(repo, "feature"); // may be a string (mint is in-memory) or undefined
	await hook.recordRejection(attemptId, repo, "proof-or-gate", "blocked");
	await hook.recordLanded(attemptId, repo);
	await hook.beginAttempt(repo, undefined); // branchless unit
	await new Promise((r) => setTimeout(r, 200)); // let the background analysis run + fail internally
	// Reaching here without a throw IS the assertion; make it explicit.
	expect(true).toBe(true);
});
