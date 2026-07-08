/**
 * GRAPH-FOLD U4 — removing/reaping an agent must release the file leases (leases.ts) it held.
 *
 * Observed live: the Federation page showed file leases 22h-4d old belonging to agents that had
 * been REMOVED (ompsq-421..428) — `SquadManager.remove()` tombstoned the id and stopped the driver
 * but never released any lease the agent's own omp process was holding, leaving it to expire on its
 * own heartbeat TTL (or not, if nothing ever aged it out) instead of vanishing the instant the agent
 * did. `leasesFor`/`ttl-registry.ts`'s prune-on-read + the periodic sweepLeases() are separately
 * verified in tests/leases.test.ts and tests/ttl-registry.test.ts — TTL enforcement itself is not the
 * gap here, the missing RELEASE-on-removal wiring is.
 */

import { EventEmitter } from "node:events";
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { claimLease, leasesFor } from "../src/leases.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A driver that comes up ready immediately and never replays any frames (no real omp/host process is
 *  spawned) — carries a caller-supplied `pid`, mirroring RpcAgent's `get pid()` (populated from the
 *  agent-host meta frame in production; here just a fixed pid the test controls directly). */
class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	constructor(readonly pid?: number) {
		super();
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

interface AttachHost {
	attachExisting: (p: PersistedAgent, transcript?: unknown[]) => Promise<void>;
}

async function deadPid(): Promise<number> {
	const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

test("remove() releases every lease the removed agent's own omp process held", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-rm-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lease-rm-repo-"));
	tmps.push(stateDir, repo);

	const pid = await deadPid(); // the agent's own driver pid — dead-by-the-time-of-removal is the REALISTIC case (an omp process that has already exited), and proves reapDeadSessions isn't secretly doing the work here: pid liveness is irrelevant to releaseAgentLeases, only the pid NUMBER matching the lease's session is.

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, replaySettleTimeoutMs: 20 });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver(pid);
	await mgr.start();

	const persisted: PersistedAgent = {
		id: "lease-rm-agent-1",
		name: "leasey",
		repo,
		worktree: repo,
		approvalMode: "yolo",
	};
	await (mgr as unknown as AttachHost).attachExisting(persisted, []);
	expect(mgr.getAgent(persisted.id)).toBeDefined();

	// Simulate lease-hook.ts having claimed a lease from INSIDE that agent's own omp process — same
	// session shape it mints (`omp:<pid>` of its own process.pid).
	await claimLease({ repo, file: "src/hot.ts", session: `omp:${pid}` });
	await claimLease({ repo, file: "src/other.ts", session: `omp:${pid}` });
	expect((await leasesFor(repo)).length).toBe(2);

	await mgr.applyCommand({ type: "remove", id: persisted.id, deleteWorktree: false });

	expect((await leasesFor(repo)).length).toBe(0); // released, not left to expire on TTL
	expect(mgr.getAgent(persisted.id)).toBeUndefined();

	await mgr.stop();
});

test("remove() leaves OTHER agents' leases on the same repo untouched", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-rm-state-2-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lease-rm-repo-2-"));
	tmps.push(stateDir, repo);

	const removedPid = await deadPid();
	const survivorPid = await deadPid();

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, replaySettleTimeoutMs: 20 });
	let nextPid = removedPid;
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver(nextPid);
	await mgr.start();

	const removedAgent: PersistedAgent = { id: "lease-rm-victim", name: "victim", repo, worktree: repo, approvalMode: "yolo" };
	await (mgr as unknown as AttachHost).attachExisting(removedAgent, []);

	nextPid = survivorPid;
	const survivorAgent: PersistedAgent = { id: "lease-rm-survivor", name: "survivor", repo, worktree: repo, approvalMode: "yolo" };
	await (mgr as unknown as AttachHost).attachExisting(survivorAgent, []);

	await claimLease({ repo, file: "src/mine.ts", session: `omp:${removedPid}` });
	await claimLease({ repo, file: "src/theirs.ts", session: `omp:${survivorPid}` });
	expect((await leasesFor(repo)).length).toBe(2);

	await mgr.applyCommand({ type: "remove", id: removedAgent.id, deleteWorktree: false });

	const live = await leasesFor(repo);
	expect(live.map((l) => l.file)).toEqual(["src/theirs.ts"]); // only the removed agent's lease is gone

	await mgr.stop();
});
