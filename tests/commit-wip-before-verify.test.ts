/**
 * `commitAgentWip` — the missing commit in the unit lifecycle (src/squad-manager.ts).
 *
 * Found by driving the factory to completion on 2026-07-09. No stage of a unit's life ever commits:
 * the bundled verify-loop workflow is `Implement → Verify → exit`, and agents reliably finish a turn
 * with uncommitted edits while reporting "Done". `runProof` refuses a dirty worktree, so the
 * orchestrator's `verifyAgent` can never pass, the unit escalates, and it dies at the escalate visit
 * cap — 65 of 65 recorded `catastrophe` events on this host are that one event, and no autonomously
 * dispatched unit has ever landed.
 *
 * `land()` already swept WIP (`commitWip: !busy`) before ITS proof gate, which is why a human clicking
 * Land could land what the fleet structurally could not. This restores the symmetry on the seam the
 * orchestrator drives.
 *
 * Real git in tmp dirs (the convention of land-mode.test.ts / pr-reconciler.test.ts). No mocks: the
 * whole point is that the sweep really commits.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, AgentStatus, PersistedAgent } from "../src/types.ts";

const { SquadManager } = await import("../src/squad-manager.ts");

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

/** A repo with one commit, on a unit branch — the shape of an agent worktree. */
async function unitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "checkout", "-qb", "squad/unit");
	return repo;
}

function seedAgent(
	mgr: InstanceType<typeof SquadManager>,
	id: string,
	repo: string,
	worktree: string,
	branch: string | undefined,
	status: AgentStatus = "idle",
): void {
	const dto: AgentDTO = {
		id,
		name: id,
		status,
		kind: "omp-operator",
		repo,
		worktree,
		branch,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() } as never);
}

async function head(repo: string): Promise<number> {
	return Number(await git(repo, "rev-list", "--count", "HEAD"));
}

// ── the fix ─────────────────────────────────────────────────────────────────────────────────────

test("commits an idle agent's uncommitted work (tracked edits AND new files) on its own branch", async () => {
	const wt = await unitRepo("cwip-idle-");
	const stateDir = await tmpDir("cwip-idle-state-");
	const before = await head(wt);

	await fs.writeFile(path.join(wt, "base.txt"), "edited by the agent\n"); // tracked edit
	await fs.writeFile(path.join(wt, "new.ts"), "export const x = 1;\n"); // untracked new file

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u1", wt, wt === stateDir ? wt : wt, "squad/unit"); // repo === worktree guard covered separately
	// A real unit's repo and worktree differ; simulate by pointing repo at a sibling clone-less path.
	(mgr.agents.get("u1") as unknown as { dto: AgentDTO }).dto.repo = path.join(wt, "..", "not-the-worktree");

	expect(await mgr.commitAgentWip("u1")).toBe(true);
	expect(await head(wt)).toBe(before + 1);
	expect(await git(wt, "status", "--porcelain")).toBe(""); // clean ⇒ runProof will no longer refuse
	expect(await git(wt, "show", "--name-only", "--format=", "HEAD")).toContain("new.ts");
});

/** The subject is permanent — it is what a reviewer reads on the PR the fleet opens. The daemon's own
 *  reason belongs in the body. (glance's first fleet-opened PR, #149, was titled
 *  "wip(intervene-wiring): sweep uncommitted work before verify".) */
test("titles the commit after the WORK, not the plumbing — issue name when present, land()'s shape otherwise", async () => {
	const wt = await unitRepo("cwip-subject-");
	const stateDir = await tmpDir("cwip-subject-state-");
	await fs.writeFile(path.join(wt, "a.ts"), "export const a = 1;\n");

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u10", path.join(wt, "..", "elsewhere"), wt, "squad/unit");

	// No issue ⇒ mirror land()'s existing `squad(<name>)` subject.
	expect(await mgr.commitAgentWip("u10")).toBe(true);
	expect(await git(wt, "log", "-1", "--format=%s")).toBe("squad(u10): agent changes");
	expect(await git(wt, "log", "-1", "--format=%b")).toContain("swept before the verify gate");
	expect(await git(wt, "log", "-1", "--format=%s")).not.toContain("sweep");

	// With an issue ⇒ the ticket identifier + title.
	await fs.writeFile(path.join(wt, "b.ts"), "export const b = 2;\n");
	(mgr.agents.get("u10") as unknown as { dto: AgentDTO }).dto.issue = { id: "x", identifier: "OMPSQ-451", name: "wire openIntervene into the cockpit" };
	expect(await mgr.commitAgentWip("u10")).toBe(true);
	expect(await git(wt, "log", "-1", "--format=%s")).toBe("OMPSQ-451: wire openIntervene into the cockpit");
});

test("excludes .omp/ — the daemon's own evidence dir, which the proof fingerprint ignores", async () => {
	const wt = await unitRepo("cwip-omp-");
	const stateDir = await tmpDir("cwip-omp-state-");
	await fs.mkdir(path.join(wt, ".omp"), { recursive: true });
	await fs.writeFile(path.join(wt, ".omp", "screenshot.png"), "not real png\n");
	await fs.writeFile(path.join(wt, "real.ts"), "export const y = 2;\n");

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u2", path.join(wt, "..", "elsewhere"), wt, "squad/unit");

	expect(await mgr.commitAgentWip("u2")).toBe(true);
	const files = await git(wt, "show", "--name-only", "--format=", "HEAD");
	expect(files).toContain("real.ts");
	expect(files).not.toContain(".omp");
});

// ── the guards: a sweep that fires when it shouldn't is worse than one that never fires ─────────

test("no-op when the agent is BUSY — a live agent's half-written tree is not a unit of work", async () => {
	for (const status of ["working", "starting", "input"] as AgentStatus[]) {
		const wt = await unitRepo(`cwip-busy-${status}-`);
		const stateDir = await tmpDir(`cwip-busy-${status}-state-`);
		await fs.writeFile(path.join(wt, "base.txt"), "mid-edit\n");
		const before = await head(wt);

		const mgr = new SquadManager({ stateDir } as never);
		seedAgent(mgr, "u", path.join(wt, "..", "elsewhere"), wt, "squad/unit", status);

		expect(await mgr.commitAgentWip("u")).toBe(false);
		expect(await head(wt)).toBe(before);
		expect(await git(wt, "status", "--porcelain")).not.toBe(""); // edits left exactly where they were
	}
});

test("no-op for an IN-PLACE agent (worktree === repo) — never commit on the operator's own checkout", async () => {
	const wt = await unitRepo("cwip-inplace-");
	const stateDir = await tmpDir("cwip-inplace-state-");
	await fs.writeFile(path.join(wt, "base.txt"), "operator's own edit\n");
	const before = await head(wt);

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u3", wt, wt, "squad/unit"); // repo === worktree

	expect(await mgr.commitAgentWip("u3")).toBe(false);
	expect(await head(wt)).toBe(before);
});

test("no-op for an agent with no branch", async () => {
	const wt = await unitRepo("cwip-nobranch-");
	const stateDir = await tmpDir("cwip-nobranch-state-");
	await fs.writeFile(path.join(wt, "base.txt"), "edit\n");
	const before = await head(wt);

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u4", path.join(wt, "..", "elsewhere"), wt, undefined);

	expect(await mgr.commitAgentWip("u4")).toBe(false);
	expect(await head(wt)).toBe(before);
});

test("no-op on a CLEAN worktree — no empty commits", async () => {
	const wt = await unitRepo("cwip-clean-");
	const stateDir = await tmpDir("cwip-clean-state-");
	const before = await head(wt);

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u5", path.join(wt, "..", "elsewhere"), wt, "squad/unit");

	expect(await mgr.commitAgentWip("u5")).toBe(false);
	expect(await head(wt)).toBe(before);
});

test("no-op for an unknown agent id", async () => {
	const stateDir = await tmpDir("cwip-unknown-state-");
	const mgr = new SquadManager({ stateDir } as never);
	expect(await mgr.commitAgentWip("nope")).toBe(false);
});

/** The in-place guard must survive a SYMLINKED worktree. `path.resolve` is textual, so a worktree path
 *  that symlinks to the operator's checkout would slip past a resolve-only compare and we would commit
 *  on the tree the human is standing in. Raised by cross-lineage review (grok-4.5). */
test("no-op when the worktree is a SYMLINK to the repo — the in-place guard resolves through links", async () => {
	const repo = await unitRepo("cwip-symlink-");
	const linkDir = await tmpDir("cwip-symlink-link-");
	const link = path.join(linkDir, "wt");
	await fs.symlink(repo, link, "dir");
	await fs.writeFile(path.join(repo, "base.txt"), "the operator's own uncommitted edit\n");
	const before = await head(repo);

	const stateDir = await tmpDir("cwip-symlink-state-");
	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u7", repo, link, "squad/unit"); // worktree is a symlink pointing AT the repo

	expect(await mgr.commitAgentWip("u7")).toBe(false);
	expect(await head(repo)).toBe(before);
	expect(await git(repo, "status", "--porcelain")).not.toBe(""); // the human's edit is untouched
});

/** `verifyFeature` — NOT `verifyAgentWork` — is what the orchestrator's `verify` hook drives for
 *  multi-agent features (`buildOrchestrator`: `verify: (id) => this.verifyFeature(id)`). It runs
 *  `runProof` per member worktree, so it hits the identical dirty refusal. Missing this left the
 *  interlock fully intact for every feature-mode unit. Found by cross-lineage review (grok-4.5). */
test("verifyFeature sweeps every live member's WIP before running the gate on its worktree", async () => {
	const wt = await unitRepo("cwip-feature-");
	const stateDir = await tmpDir("cwip-feature-state-");
	await fs.writeFile(path.join(wt, "base.txt"), "member's finished, uncommitted work\n");
	const before = await head(wt);

	const seenDirty: (string | undefined)[] = [];
	class FeatureManager extends SquadManager {
		override async verifyFeature(id: string): ReturnType<SquadManager["verifyFeature"]> {
			const out = await super.verifyFeature(id);
			return out;
		}
	}
	const mgr = new FeatureManager({ stateDir } as never);
	// A feature whose single member is our dirty agent. `runProof` would refuse a dirty worktree, so if
	// the sweep did not happen the gate could never even start.
	(mgr as unknown as { featureStore: Map<string, unknown> }).featureStore.set("f1", {
		id: "f1",
		title: "f",
		repo: path.join(wt, "..", "elsewhere"),
		acceptance: "true", // trivial always-green gate; we are testing the sweep, not the gate
		branches: [],
	});
	seedAgent(mgr, "m1", path.join(wt, "..", "elsewhere"), wt, "squad/unit");
	(mgr.agents.get("m1") as unknown as { dto: AgentDTO }).dto.featureId = "f1";

	const res = await mgr.verifyFeature("f1");
	seenDirty.push(await git(wt, "status", "--porcelain"));

	expect(await head(wt)).toBe(before + 1); // swept into a commit
	expect(seenDirty[0]).toBe(""); // clean afterwards
	expect(res?.ok).toBe(true); // the gate actually ran (it could not have, on a dirty tree)
});

/** `[].every(...)` is `true`: a feature with no live agents and no recorded branches used to verify
 *  GREEN without running a single gate, then land nothing. A gate that reports "verified" for work it
 *  never looked at is the fail-open class #123 closed on the other side. Found by cross-lineage review
 *  (gpt-5.6-sol). */
test("verifyFeature fails CLOSED when a feature has no members — never green on work it never ran", async () => {
	const stateDir = await tmpDir("cwip-nomembers-state-");
	const mgr = new SquadManager({ stateDir } as never);
	(mgr as unknown as { featureStore: Map<string, unknown> }).featureStore.set("f0", {
		id: "f0",
		title: "orphaned feature",
		repo: "/nonexistent",
		acceptance: "true", // would trivially pass — if it ever ran
		branches: [],
	});

	const res = await mgr.verifyFeature("f0");
	expect(res?.ok).toBe(false);
	expect(res?.results[0]?.detail).toContain("no member worktrees to verify");
});

// ── the invariant that actually keeps the factory alive ─────────────────────────────────────────

/**
 * THE ORDERING TEST. `runProof` refuses a dirty worktree, so the orchestrator must sweep before it
 * verifies — otherwise every unit's verify fails, it escalates, and it dies at the escalate visit cap.
 * The sweep is wired as the `settleWork` dep, which the orchestrator calls BEFORE `stateKey` reads
 * HEAD (so durable records aren't keyed to a HEAD the sweep replaces). Mutation-proof: delete
 * `await this.commitAgentWip(id)` from `buildOrchestrator`'s `settleWork` and this goes red.
 */
test("the orchestrator's settleWork dep sweeps WIP, leaving the tree clean before the gate runs", async () => {
	const wt = await unitRepo("cwip-order-");
	const stateDir = await tmpDir("cwip-order-state-");

	class TestManager extends SquadManager {
		dirtyAtVerify: string | undefined;
		verifiedIds: string[] = [];
		// Stub the real gate: it would run `bun run check && bun run test` in a docker container.
		override async verifyAgentWork(id: string): Promise<boolean> {
			this.verifiedIds.push(id);
			this.dirtyAtVerify = await git(wt, "status", "--porcelain");
			return true;
		}
		orchestratorDeps(): { settleWork?: (id: string) => Promise<void>; verifyAgent?: (id: string) => Promise<boolean> } {
			return (this.buildOrchestrator() as unknown as { deps: { settleWork?: (id: string) => Promise<void>; verifyAgent?: (id: string) => Promise<boolean> } }).deps;
		}
	}

	await fs.writeFile(path.join(wt, "base.txt"), "the agent's finished, uncommitted work\n");
	const before = await head(wt);

	const mgr = new TestManager({ stateDir } as never);
	seedAgent(mgr, "u6", path.join(wt, "..", "elsewhere"), wt, "squad/unit");

	const deps = mgr.orchestratorDeps();
	expect(deps.settleWork).toBeDefined();

	await deps.settleWork!("u6"); // what the orchestrator does before it reads HEAD
	expect(await head(wt)).toBe(before + 1); // the sweep created exactly one commit
	expect(await git(wt, "status", "--porcelain")).toBe(""); // …and HEAD is stable from here on

	expect(await deps.verifyAgent!("u6")).toBe(true);
	expect(mgr.verifiedIds).toEqual(["u6"]);
	expect(mgr.dirtyAtVerify).toBe(""); // the gate saw a clean tree
});

/** `git add -A` must not force-add ignored paths: an agent's `.env`, build output, or a stray
 *  credentials file that `.gitignore` already excludes must never be swept into a commit that the PR
 *  path then pushes to the remote. Raised by cross-lineage review (both lineages). */
test("respects .gitignore — ignored files are never swept into the commit", async () => {
	const wt = await unitRepo("cwip-ignore-");
	const stateDir = await tmpDir("cwip-ignore-state-");
	await fs.writeFile(path.join(wt, ".gitignore"), "secrets.env\ndist/\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "add gitignore");

	await fs.writeFile(path.join(wt, "secrets.env"), "API_KEY=hunter2\n");
	await fs.mkdir(path.join(wt, "dist"), { recursive: true });
	await fs.writeFile(path.join(wt, "dist", "bundle.js"), "// build output\n");
	await fs.writeFile(path.join(wt, "real.ts"), "export const z = 3;\n");

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u8", path.join(wt, "..", "elsewhere"), wt, "squad/unit");

	expect(await mgr.commitAgentWip("u8")).toBe(true);
	const files = await git(wt, "show", "--name-only", "--format=", "HEAD");
	expect(files).toContain("real.ts");
	expect(files).not.toContain("secrets.env");
	expect(files).not.toContain("bundle.js");
});

/** "idle" is an observation, not quiescence — a background process the agent spawned may still be
 *  writing. A short dwell since `lastActivity` must gate the sweep. Raised by both lineages. */
test("waits for an idle dwell — an agent that just stopped streaming is not swept yet", async () => {
	const wt = await unitRepo("cwip-dwell-");
	const stateDir = await tmpDir("cwip-dwell-state-");
	await fs.writeFile(path.join(wt, "base.txt"), "still being written\n");
	const before = await head(wt);

	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "u9", path.join(wt, "..", "elsewhere"), wt, "squad/unit");
	(mgr.agents.get("u9") as unknown as { dto: AgentDTO }).dto.lastActivity = Date.now(); // just now

	expect(await mgr.commitAgentWip("u9")).toBe(false); // inside the dwell ⇒ skipped, retried next tick
	expect(await head(wt)).toBe(before);

	// …and once the dwell has elapsed, it sweeps.
	(mgr.agents.get("u9") as unknown as { dto: AgentDTO }).dto.lastActivity = Date.now() - 60_000;
	expect(await mgr.commitAgentWip("u9")).toBe(true);
	expect(await head(wt)).toBe(before + 1);
});
