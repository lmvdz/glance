/**
 * Post-ship fix — goal-overlap card spam (EXECUTION-LOG.md "Post-ship fix: goal-overlap spam").
 *
 * Production: the goal-overlap disclosure (`squad-manager.ts#createWithId`'s `goalConflict`
 * check, the "Possibly duplicated work" card) re-emitted the ENTIRE backlog of (owner, candidate)
 * pairs on every daemon restart — a resumed workflow branch keeps a DETERMINISTIC id across
 * restarts (`spawnFleetBranch`), so the check re-ran against the same still-live owner every
 * boot and re-disclosed the same pair as if it were news. Three restarts in 30 hours meant three
 * identical cards for the same pair in one room.
 *
 * Two causes, both covered here:
 *  1. The "already warned" memory was in-process only. `goal-overlap-ledger.ts` persists every
 *     emitted (ownerUnitId, candidateUnitId) pair; a restart consults it before emitting again.
 *  2. The card claimed "Both are running" unconditionally. `createWithId` now checks both units'
 *     actual post-spawn status and never emits when either is dead (`stopped`/`error`/gone).
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { openGoalOverlapLedger } from "../src/goal-overlap-ledger.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class ReadyDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<unknown> {
		return {};
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

class FailStartDriver extends EventEmitter implements AgentDriver {
	readonly isReady = false;
	readonly isAlive = false;
	async start(): Promise<void> {
		throw new Error("handshake timeout");
	}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): never {
		throw new Error("unused in failed-start path");
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

interface InternalCreator {
	createInternal(opts: Record<string, unknown>): Promise<{ id: string; status: string }>;
}

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "goal-overlap-repo-"));
	tmps.push(repo);
	const git = async (args: string[]) => {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

async function newDirs(prefix: string): Promise<{ stateDir: string; worktreeBase: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	return { stateDir, worktreeBase };
}

test("restart-idempotency: a resumed deterministic-id pair discloses once, never again across a fresh manager instance over the same state dir", async () => {
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	const repo = await makeRepo();
	const { stateDir, worktreeBase } = await newDirs("goal-overlap-restart");

	const ownerId = "goal-overlap-owner-branch-1a2b3c";
	const candidateId = "goal-overlap-candidate-branch-4d5e6f";

	const mgr1 = new SquadManager({ stateDir, worktreeBase });
	const host1 = mgr1 as unknown as DriverFactoryHost;
	host1.makeDriver = () => new ReadyDriver();
	await mgr1.start();

	await (mgr1 as unknown as InternalCreator).createInternal({
		explicitId: ownerId,
		name: "owner-unit",
		repo,
		approvalMode: "yolo",
		task: "Build request throttling controls",
		bypassCap: true,
	});
	const candidate1 = await (mgr1 as unknown as InternalCreator).createInternal({
		explicitId: candidateId,
		name: "candidate-unit",
		repo,
		approvalMode: "yolo",
		task: "Implement rate limiting",
		bypassCap: true,
	});
	expect(candidate1.status).not.toBe("error");

	const cardsFirstBoot = (await mgr1.channelEntries("fleet")).filter((e) => e.event?.kind === "goal-overlap");
	expect(cardsFirstBoot).toHaveLength(1);
	expect(cardsFirstBoot[0]!.text).toContain("owner-unit");
	// The ledger durably records the pair by the units' REAL ids, not their display names.
	expect(openGoalOverlapLedger(stateDir).has(ownerId, candidateId)).toBe(true);
	await mgr1.stop();

	// Restart: a FRESH manager instance over the SAME state dir. `spawnFleetBranch`'s resume
	// mechanism re-runs createInternal for every not-yet-finished branch with the SAME deterministic
	// id every single boot — this is that exact call sequence, the one that flooded the room live.
	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	const host2 = mgr2 as unknown as DriverFactoryHost;
	host2.makeDriver = () => new ReadyDriver();
	await mgr2.start();

	await (mgr2 as unknown as InternalCreator).createInternal({
		explicitId: ownerId,
		name: "owner-unit",
		repo,
		approvalMode: "yolo",
		task: "Build request throttling controls",
		bypassCap: true,
	});
	await (mgr2 as unknown as InternalCreator).createInternal({
		explicitId: candidateId,
		name: "candidate-unit",
		repo,
		approvalMode: "yolo",
		task: "Implement rate limiting",
		bypassCap: true,
	});

	const cardsSecondBoot = (await mgr2.channelEntries("fleet")).filter((e) => e.event?.kind === "goal-overlap");
	// STILL exactly one — the restart discloses nothing new for a pair it already announced.
	expect(cardsSecondBoot).toHaveLength(1);
	await mgr2.stop();
});

test("dead-unit suppression: a candidate whose start() fails never gets a goal-overlap card", async () => {
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	const repo = await makeRepo();
	const { stateDir, worktreeBase } = await newDirs("goal-overlap-dead-candidate");

	const mgr = new SquadManager({ stateDir, worktreeBase });
	const host = mgr as unknown as DriverFactoryHost;
	host.makeDriver = () => new ReadyDriver();
	await mgr.start();

	await mgr.create({ name: "rate-owner", repo, approvalMode: "yolo", task: "Build request throttling controls" });

	// The SECOND unit's driver fails to start — it lands in "error", a unit that never ran.
	host.makeDriver = () => new FailStartDriver();
	const failed = await mgr.create({ name: "new-team", repo, approvalMode: "yolo", task: "Implement rate limiting" });
	expect(failed.status).toBe("error");

	const cards = (await mgr.channelEntries("fleet")).filter((e) => e.event?.kind === "goal-overlap");
	// A conflict with a unit that never actually started is noise, not news.
	expect(cards).toHaveLength(0);
	await mgr.stop();
});

/**
 * The owner is alive when `goalConflict` runs (early in `createWithId`, gating the structural
 * throw) but settles (is removed) WHILE the candidate's own spawn is still in flight — a real
 * possibility now that the disclosure is deferred to the end of `createWithId`, across every
 * `await` routing/provisioning/`agent.start()` does. Simulated by having the CANDIDATE's own
 * driver remove the owner mid-`start()`, so by the time the disclosure's fresh status check
 * runs, the owner it computed a conflict against no longer exists.
 */
class OwnerRemovingDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	constructor(
		private readonly mgr: SquadManager,
		private readonly ownerId: string,
	) {
		super();
	}
	async start(): Promise<void> {
		await this.mgr.applyCommand({ type: "remove", id: this.ownerId, deleteWorktree: false });
	}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<unknown> {
		return {};
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

test("dead-unit suppression: an owner that settles WHILE the candidate is still spawning is never disclosed against", async () => {
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	const repo = await makeRepo();
	const { stateDir, worktreeBase } = await newDirs("goal-overlap-dead-owner");

	const mgr = new SquadManager({ stateDir, worktreeBase });
	const host = mgr as unknown as DriverFactoryHost;
	host.makeDriver = () => new ReadyDriver();
	await mgr.start();

	const owner = await mgr.create({ name: "rate-owner", repo, approvalMode: "yolo", task: "Build request throttling controls" });
	expect(mgr.getAgent(owner.id)).toBeDefined();

	// The candidate's own start() removes the owner before createWithId reaches the disclosure —
	// `goalConflict` (early) still sees the owner as live; the fresh check at emission time must not.
	host.makeDriver = () => new OwnerRemovingDriver(mgr, owner.id);
	const second = await mgr.create({ name: "new-team", repo, approvalMode: "yolo", task: "Implement rate limiting" });
	expect(second.status).not.toBe("error");
	expect(mgr.getAgent(owner.id)).toBeUndefined(); // sanity: the removal actually happened

	const cards = (await mgr.channelEntries("fleet")).filter((e) => e.event?.kind === "goal-overlap");
	// The owner settled before the card would have posted — nothing left to warn anyone about.
	expect(cards).toHaveLength(0);
	await mgr.stop();
});
