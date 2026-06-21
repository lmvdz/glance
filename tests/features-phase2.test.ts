/**
 * Phase 2 — persisted features: land ordering, branch-cache survival, state.json round-trip.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFeatures, landOrder } from "../src/features.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { FeatureWorktreeStatus, LandReadiness, PersistedFeature } from "../src/types.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];
afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

async function git(repo: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", repo, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

test("landOrder: ahead first, then uncommitted; clean/diverged/no-branch excluded", () => {
	const w = (readiness: LandReadiness, branch: string): FeatureWorktreeStatus => ({ branch, worktree: `/x/${branch}`, changedFiles: 0, ahead: 1, behind: 0, readiness });
	const order = landOrder([w("uncommitted", "a"), w("diverged", "b"), w("ahead", "c"), w("clean", "d"), w("no-branch", "e")]);
	expect(order.map((x) => x.branch)).toEqual(["c", "a"]);
});

test("buildFeatures: a persisted feature reports cached-branch land status after the agent is gone", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "checkout", "-q", "-b", "gone");
	await fs.writeFile(path.join(repo, "x.txt"), "x\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "gone-1");
	await git(repo, "checkout", "-q", "main");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "p2-wt-")), "gone");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "gone");

	// Persisted feature whose member agent ("dead") is NOT in the roster — only the cached branch remains.
	const pf: PersistedFeature = { id: "f1", title: "F1", repo, branches: [{ branch: "gone", worktree: wt, agentId: "dead" }], createdAt: 0, updatedAt: 0 };
	const feats = await buildFeatures(repo, [], [pf]);
	const f = feats.find((x) => x.id === "f1");
	expect(f).toBeDefined();
	expect(f?.agentIds).toEqual([]);
	expect(f?.worktrees[0]?.readiness).toBe("ahead"); // land status survives the agent being gone
	expect(f?.stage).toBe("review");
});

test("createFeature round-trips through state.json", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-state-"));
	tmps.push(stateDir);
	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const pf = mgr.createFeature({ title: "Auth", repo: "/x/repo" });
	await mgr.stop(); // flushes persist()
	managers.length = 0; // already stopped

	const restored = new SquadManager({ stateDir });
	managers.push(restored);
	await restored.loadPersisted();
	const feats = await restored.features("/x/repo");
	const got = feats.find((f) => f.id === pf.id);
	expect(got).toBeDefined();
	expect(got?.persisted).toBe(true);
	expect(got?.title).toBe("Auth");
});
