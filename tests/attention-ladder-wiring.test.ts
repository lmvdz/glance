/**
 * The needs-you ladder wired into the REAL SquadManager (t3-face concern 06, grok-4.5/codex
 * cross-lineage review) — as opposed to attention-ladder.test.ts's pure cascade (fed hand-built
 * `completedAt`/`visitedAt` numbers) and attention.test.ts's `AttentionStore` tested in isolation.
 * Every test here drives an actual create()/prompt()/agent_end lifecycle through a real manager, so
 * the completion signal is observed end-to-end: `SquadManager.recordTransition` →
 * `isGenuineCompletion` → `AttentionStore.recordCompletion` → `SquadManager.lastCompletedAt` →
 * `syncLadder`/`ladderPriorityFor`. The prior scan-based `lastCompletedAt` (`to === "idle"` over
 * the whole transition ring, no `from`/`denied`/`reason` filter) passed EVERY test in
 * attention-ladder.test.ts's pure-cascade suite while still counting a bare spawn/restart connect
 * as a "completion" in the real system, and a same-state bookkeeping re-record as a fresh one —
 * exactly the miss only a real-manager test can catch, since the pure cascade is never handed a
 * `connect-ok`/`adopted` transition to mis-derive `completedAt` from in the first place.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Never auto-resolves a turn on its own — mirrors completion-push-arm.test.ts's `ControlDriver` so
 *  each test drives `agent_end` explicitly and observes the ladder at each intermediate step. */
class ControlDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
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
interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
}
interface InternalHost {
	agents: Map<string, AgentRecordLike>;
	transition(rec: AgentRecordLike, to: string, reason: string): void;
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ControlDriver();
	return { mgr, repo };
}

test("REQUIRED 1: a spawned unit that only ever connected (connect-ok, no real turn) reads idle, not completed-unseen — with no visit", async () => {
	const { mgr, repo } = await makeMgr("ladder-connect-only");
	const dto = await mgr.create({ name: "u1", repo, approvalMode: "yolo" });

	// Spawn → connect-ok only. No prompt was ever sent, so the ONLY "idle" transition this unit has
	// is the bare connect — the exact case the prior scan-based `lastCompletedAt` misclassified as a
	// completion (any `to==="idle"` counted, regardless of `from`/`reason`).
	expect(mgr.getAgent(dto.id)?.status).toBe("idle");
	expect(mgr.getAgent(dto.id)?.ladderPriority).toBe("idle");
	expect(mgr.ladderPriorityFor(mgr.getAgent(dto.id) as AgentDTO, undefined)).toBe("idle");

	await mgr.stop();
});

test("REQUIRED 2: a unit that completed a real turn reads completed-unseen before a visit, idle after — and same-state bookkeeping never flips it back", async () => {
	const { mgr, repo } = await makeMgr("ladder-real-turn");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "u2", repo, approvalMode: "yolo" });

	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "go" }, LOCAL_ACTOR);
	expect(mgr.getAgent(dto.id)?.status).toBe("working");

	// Drive the REAL agent_end frame the harness emits at the end of a turn — working → idle via
	// "turn-progress", a genuine completion (`isGenuineCompletion`'s `from ∈ {working,input}` filter).
	const rec = host.agents.get(dto.id) as AgentRecordLike;
	(rec.agent as ControlDriver).emit("event", { type: "agent_end" });

	expect(mgr.getAgent(dto.id)?.status).toBe("idle");
	expect(mgr.ladderPriorityFor(mgr.getAgent(dto.id) as AgentDTO, undefined)).toBe("completed-unseen");
	// The shared (viewer-agnostic) hint is fail-closed the same way — `syncLadder`'s conservative
	// "nobody has visited" default.
	expect(mgr.getAgent(dto.id)?.ladderPriority).toBe("completed-unseen");

	// A visit clears it.
	const marked = mgr.markUnitVisited(dto.id, undefined);
	expect(marked.ok).toBe(true);
	expect(mgr.ladderPriorityFor(mgr.getAgent(dto.id) as AgentDTO, undefined)).toBe("idle");

	// A real wall-clock gap so the bookkeeping transition below is UNAMBIGUOUSLY timestamped after
	// the visit above — without this, a same-millisecond race could pass even against the pre-fix
	// scan (which also read `visitedAt < completedAt` as false on a tie), masking the bug this test
	// exists to catch.
	await new Promise((resolve) => setTimeout(resolve, 5));

	// Same-state idle→idle bookkeeping (an "adopted"-style no-op re-record, the exact shape
	// `closeOrphanedPending`/cold-adopt produces) must NOT be mistaken for a FRESH completion —
	// the already-visited unit must stay `idle`, never flip back to `completed-unseen`. Pre-fix, the
	// scan's bare `t.to === "idle"` filter counted this same-state entry as a NEW, later completion,
	// pushing `completedAt` past the visit's timestamp and flipping the unit back to unseen.
	host.transition(rec, "idle", "adopted");
	expect(mgr.ladderPriorityFor(mgr.getAgent(dto.id) as AgentDTO, undefined)).toBe("idle");

	await mgr.stop();
});

test("REQUIRED 2b: a restart's connect-ok after a real completion does not refresh/duplicate the completion signal, and a visit still clears it", async () => {
	const { mgr, repo } = await makeMgr("ladder-restart-after-turn");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "u3", repo, approvalMode: "yolo" });

	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "go" }, LOCAL_ACTOR);
	const rec = host.agents.get(dto.id) as AgentRecordLike;
	(rec.agent as ControlDriver).emit("event", { type: "agent_end" });
	expect(mgr.ladderPriorityFor(mgr.getAgent(dto.id) as AgentDTO, undefined)).toBe("completed-unseen");

	mgr.markUnitVisited(dto.id, undefined);
	expect(mgr.ladderPriorityFor(mgr.getAgent(dto.id) as AgentDTO, undefined)).toBe("idle");

	await new Promise((resolve) => setTimeout(resolve, 5)); // see REQUIRED 2's comment on why this matters

	// A later bare connect-ok (e.g. a restart reconnect) is not itself a completion — the visited
	// unit must stay `idle`, not flip back to `completed-unseen` just because another `idle`
	// transition was recorded. Pre-fix, `to === "idle"` alone counted this connect (always FROM
	// "starting", never a completed turn) as a fresh completion.
	host.transition(rec, "starting", "connect-begin");
	host.transition(rec, "idle", "connect-ok");
	expect(mgr.ladderPriorityFor(mgr.getAgent(dto.id) as AgentDTO, undefined)).toBe("idle");

	await mgr.stop();
});
