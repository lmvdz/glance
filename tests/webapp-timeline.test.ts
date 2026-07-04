/**
 * Webapp lifecycle timeline (#lifecycle-truth concern 03): drives concern 01's guarded
 * transition() through a seeded fake agent and asserts the two DTO surfaces this concern adds
 * on top of concern 02's persisted ring:
 *   (a) dto.transitions caps at 5 SIGNIFICANT entries and excludes turn-progress noise
 *   (b) dto.errorTransitions1h is computed over the FULL ring, not the capped tail — it must
 *       never undercount a busy/flapping agent the way the capped `transitions` tail would
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { DerivedReason, TransitionReason } from "../src/agent-lifecycle.ts";
import type { AgentDTO, AgentStatus, PendingRequest, PersistedAgent, RpcSessionState, TransitionEntry } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class NoopDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in these tests"));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: unknown[];
	assistantBuf: string;
	thinkingBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
	toolEntries: Map<string, unknown>;
}

/** The private lifecycle surface this test drives directly. */
interface LifecycleHost {
	agents: Map<string, AgentRecordLike>;
	transition: (rec: AgentRecordLike, to: AgentStatus, reason: TransitionReason, cause?: Record<string, unknown>) => void;
	setPending: (rec: AgentRecordLike, next: PendingRequest[], reason: DerivedReason, cause?: Record<string, unknown>, opts?: { callerOwnsStatus?: boolean }) => void;
	transitionLog: { recent: (limit?: number) => TransitionEntry[]; hydrateAll: () => Promise<TransitionEntry[]> };
}

function seed(mgr: SquadManager, id: string, status: AgentStatus = "idle"): AgentRecordLike {
	const dto: AgentDTO = {
		id,
		name: id,
		status,
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo" };
	const rec: AgentRecordLike = { dto, agent: new NoopDriver(), options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
	(mgr as unknown as LifecycleHost).agents.set(id, rec);
	return rec;
}

async function freshStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webapp-timeline-"));
	tmps.push(dir);
	return dir;
}

test("dto.transitions caps at 5 significant entries and excludes turn-progress noise", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "a1", "idle");

	// 7 significant (event-class) transitions — more than the cap.
	for (let i = 0; i < 7; i++) {
		host.transition(rec, i % 2 === 0 ? "working" : "idle", "task-start");
	}
	await Bun.sleep(20);

	expect(rec.dto.transitions).toHaveLength(5);
	// The tail is the LAST 5, not the first 5.
	const ring = host.transitionLog.recent().filter((e) => e.agentId === "a1");
	expect(ring).toHaveLength(7);
	expect(rec.dto.transitions).toEqual(ring.slice(-5));

	// A turn-progress transition (idle -> working, legal for a derived reason from a non-terminal
	// state) records to the ring but must NOT join the capped DTO tail — hot-path noise.
	const beforeTail = rec.dto.transitions;
	host.transition(rec, rec.dto.status === "idle" ? "working" : "idle", "turn-progress");
	await Bun.sleep(20);

	expect(rec.dto.transitions).toEqual(beforeTail); // unchanged — turn-progress never joins the tail
	const ringAfter = host.transitionLog.recent().filter((e) => e.agentId === "a1");
	expect(ringAfter).toHaveLength(8); // ...but it DID record to the full ring
});

test("dto.errorTransitions1h reflects the FULL ring, never undercounting like the capped tail would", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "a1", "idle");

	// 7 error-class recordings within the trailing hour — same-state "fail" calls record every time
	// (event-class reasons are never same-state no-ops), so all 7 land in the full ring.
	for (let i = 0; i < 7; i++) {
		host.transition(rec, "error", "fail", { error: `boom-${i}` });
	}
	await Bun.sleep(20);

	// The DTO tail is capped at 5 — if insights.ts read the count off this tail it would undercount.
	expect(rec.dto.transitions).toHaveLength(5);
	// The rollup is NOT derived from the capped tail: it reflects all 7 qualifying ring entries.
	expect(rec.dto.errorTransitions1h).toBe(7);
});

test("dto.errorTransitions1h only counts to:error transitions with fail/catastrophe/exit-error reasons", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "a1", "idle");

	host.transition(rec, "error", "fail");
	host.transition(rec, "error", "catastrophe");
	host.transition(rec, "starting", "restart"); // error -> starting, not an error-class transition
	host.transition(rec, "error", "exit-error");
	host.transition(rec, "idle", "task-start"); // idle, not error
	await Bun.sleep(20);

	expect(rec.dto.errorTransitions1h).toBe(3);
});
