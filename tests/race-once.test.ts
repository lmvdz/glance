/**
 * Concern 07 (race-once at gate exhaustion): a workflow catastrophe (visit-cap exhaustion) on an
 * issue-carrying, race-eligible-lane unit parks the original and spawns exactly one fresh-context,
 * alternate-strategy sibling before ever summoning a human — once per issue, ever, ledger-enforced
 * across a restart. A non-race lane (or the flag off) is untouched: existing escalate-immediately
 * behavior.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, IssueRef, PersistedAgent, RpcSessionState } from "../src/types.ts";
import type { EngineCheckpoint } from "../src/workflow/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	stopped = 0;
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped++;
	}
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
	checkpointAppending?: Promise<void>;
}

interface InternalHost {
	agents: Map<string, AgentRecordLike>;
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

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string; stateDir: string; worktreeBase: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	return { mgr, repo, stateDir, worktreeBase };
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
}

const checkpoint = (over: Partial<EngineCheckpoint> = {}): EngineCheckpoint => ({ goal: "g", currentNode: "n1", visits: { n1: 1 }, vars: {}, index: 0, ...over });

const issue = (id: string, name = "fix the outage"): IssueRef => ({ id, identifier: id.toUpperCase(), name });

test("catastrophe on an issue-carrying hotfix-lane unit races exactly one sibling and suppresses the human escalation", async () => {
	process.env.OMP_SQUAD_RACE_ONCE = "1";
	const { mgr, repo, stateDir } = await makeMgr("race-once-basic");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true", issue: issue("iss-race-1"), lane: "hotfix" });
	const rec = host.agents.get(dto.id)!;

	rec.agent.emit("event", { type: "workflow_terminal", reason: 'node "n1" exceeded its visit cap (3)', checkpoint: checkpoint() });
	await waitFor(() => mgr.list().some((a) => a.name === "wf-race"));

	// The original is parked (stopped), NOT escalated to a visible catastrophe — the human summon is
	// suppressed while the sibling races.
	expect(rec.dto.status).toBe("stopped");
	expect(rec.dto.error).toBeUndefined();

	const sibling = mgr.list().find((a) => a.name === "wf-race")!;
	expect(sibling.issue?.id).toBe("iss-race-1");
	expect(sibling.lane).toBe("hotfix");
	expect(sibling.branch).not.toBe(rec.dto.branch); // deterministic planeIssueBranch would collide otherwise

	// Ledger persisted — restart-safe, once per issue ever. `record()` lands a moment after the sibling
	// becomes list()-visible (both happen inside the same `create()` call, but list-visibility fires
	// earlier in `createWithId` than this method's own `await` on it resolves) — poll rather than race it.
	const ledgerPath = path.join(stateDir, "race-ledger.json");
	await waitFor(() => existsSync(ledgerPath));
	const ledgerRaw = await fs.readFile(ledgerPath, "utf8");
	const ledger = JSON.parse(ledgerRaw) as Record<string, { originalAgentId: string; siblingAgentId: string }>;
	expect(ledger["iss-race-1"].originalAgentId).toBe(dto.id);
	expect(ledger["iss-race-1"].siblingAgentId).toBe(sibling.id);

	await mgr.stop();
	delete process.env.OMP_SQUAD_RACE_ONCE;
}, 20_000); // two real worktrees (original + sibling) cut in this test — the 5s default is tight under load

test("a second catastrophe (the sibling's own) escalates for real, naming both attempts", async () => {
	process.env.OMP_SQUAD_RACE_ONCE = "1";
	const { mgr, repo, stateDir } = await makeMgr("race-once-second");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true", issue: issue("iss-race-2"), lane: "hotfix" });
	const rec = host.agents.get(dto.id)!;
	rec.agent.emit("event", { type: "workflow_terminal", reason: 'node "n1" exceeded its visit cap (3)', checkpoint: checkpoint() });
	await waitFor(() => mgr.list().some((a) => a.name === "wf-race"));
	// Let the race fully commit (ledger written) before simulating the sibling's OWN later catastrophe —
	// a real sibling can't fail before it's even finished spawning, so this mirrors the only order that
	// can actually occur.
	await waitFor(() => existsSync(path.join(stateDir, "race-ledger.json")));

	const siblingDto = mgr.list().find((a) => a.name === "wf-race")!;
	const siblingRec = host.agents.get(siblingDto.id)!;

	// The sibling ALSO hits catastrophe — the ledger is already spent for this issue, so this escalates
	// for real (no third race), naming both attempts.
	siblingRec.agent.emit("event", { type: "workflow_terminal", reason: 'node "n1" exceeded its visit cap (3)', checkpoint: checkpoint() });
	await waitFor(() => siblingRec.dto.status === "error");

	expect(siblingRec.dto.error).toContain("CATASTROPHE");
	expect(siblingRec.dto.error).toContain(dto.id); // names the original
	expect(siblingRec.dto.error).toContain(siblingDto.id); // names the sibling
	expect(mgr.list().filter((a) => a.issue?.id === "iss-race-2")).toHaveLength(2); // never a third attempt

	await mgr.stop();
	delete process.env.OMP_SQUAD_RACE_ONCE;
}, 20_000);

test("a restart between the original's catastrophe and the sibling's completion does not spawn a second sibling", async () => {
	process.env.OMP_SQUAD_RACE_ONCE = "1";
	const { mgr: mgr1, repo, stateDir, worktreeBase } = await makeMgr("race-once-restart");
	const host1 = mgr1 as unknown as InternalHost;

	const dto = await mgr1.create({ name: "wf", repo, approvalMode: "yolo", verify: "true", issue: issue("iss-race-3"), lane: "hotfix" });
	const rec1 = host1.agents.get(dto.id)!;
	rec1.agent.emit("event", { type: "workflow_terminal", reason: 'node "n1" exceeded its visit cap (3)', checkpoint: checkpoint() });
	await waitFor(() => mgr1.list().some((a) => a.name === "wf-race"));
	expect(rec1.dto.status).toBe("stopped");

	await mgr1.stop();

	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr2.start();

	// The parked original reattaches (its workflowState.terminal marker survives) but stays parked — the
	// suppressed escalation must not resurrect on restart (reattachTerminal's race-ledger check).
	const originalAfterRestart = mgr2.list().find((a) => a.name === "wf");
	expect(originalAfterRestart?.status).toBe("stopped");
	expect(originalAfterRestart?.error).toBeUndefined();

	// The persisted ledger — the actual restart-safety invariant — still names exactly the one sibling
	// already raced; nothing re-derives or re-races it from the reattach path (reattachTerminal never
	// calls tryRaceOnce at all, so a second sibling is structurally impossible here, restart or not).
	const ledger = JSON.parse(await fs.readFile(path.join(stateDir, "race-ledger.json"), "utf8")) as Record<string, { originalAgentId: string; siblingAgentId: string }>;
	expect(ledger["iss-race-3"].originalAgentId).toBe(dto.id);
	const firstSiblingId = ledger["iss-race-3"].siblingAgentId;

	// Simulate the reattached original catastrophizing AGAIN post-restart (e.g. an operator manually
	// forked/restarted it) — even then, tryRaceOnce sees the ledger already spent and refuses a second
	// sibling instead of minting one.
	const host2 = mgr2 as unknown as InternalHost & { tryRaceOnce(rec: AgentRecordLike, reason: string): Promise<boolean> };
	const secondTryRaced = await host2.tryRaceOnce(host2.agents.get(dto.id)!, 'node "n1" exceeded its visit cap (3) — again');
	expect(secondTryRaced).toBe(false);
	const ledgerAfter = JSON.parse(await fs.readFile(path.join(stateDir, "race-ledger.json"), "utf8")) as Record<string, { siblingAgentId: string }>;
	expect(ledgerAfter["iss-race-3"].siblingAgentId).toBe(firstSiblingId); // unchanged — no second sibling minted

	await mgr2.stop();
	delete process.env.OMP_SQUAD_RACE_ONCE;
}, 20_000);

test("a non-race lane (feature) escalates immediately — existing behavior, unchanged", async () => {
	process.env.OMP_SQUAD_RACE_ONCE = "1";
	const { mgr, repo } = await makeMgr("race-once-nonrace-lane");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true", issue: issue("iss-race-4"), lane: "feature" });
	const rec = host.agents.get(dto.id)!;
	rec.agent.emit("event", { type: "workflow_terminal", reason: 'node "n1" exceeded its visit cap (3)', checkpoint: checkpoint() });
	await waitFor(() => rec.dto.status === "error");

	expect(rec.dto.error).toContain("CATASTROPHE");
	expect(mgr.list().some((a) => a.name === "wf-race")).toBe(false); // never raced

	await mgr.stop();
	delete process.env.OMP_SQUAD_RACE_ONCE;
});

test("the flag off escalates immediately even on a race-eligible lane — existing behavior, unchanged", async () => {
	delete process.env.OMP_SQUAD_RACE_ONCE;
	const { mgr, repo } = await makeMgr("race-once-flag-off");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true", issue: issue("iss-race-5"), lane: "hotfix" });
	const rec = host.agents.get(dto.id)!;
	rec.agent.emit("event", { type: "workflow_terminal", reason: 'node "n1" exceeded its visit cap (3)', checkpoint: checkpoint() });
	await waitFor(() => rec.dto.status === "error");

	expect(rec.dto.error).toContain("CATASTROPHE");
	expect(mgr.list().some((a) => a.name === "wf-race")).toBe(false);

	await mgr.stop();
});

test("a non-issue-carrying catastrophe (no Plane issue) never races, even with the flag on and a race-eligible lane", async () => {
	process.env.OMP_SQUAD_RACE_ONCE = "1";
	const { mgr, repo } = await makeMgr("race-once-no-issue");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true", lane: "hotfix" });
	const rec = host.agents.get(dto.id)!;
	rec.agent.emit("event", { type: "workflow_terminal", reason: 'node "n1" exceeded its visit cap (3)', checkpoint: checkpoint() });
	await waitFor(() => rec.dto.status === "error");

	expect(rec.dto.error).toContain("CATASTROPHE");
	expect(mgr.list().some((a) => a.name === "wf-race")).toBe(false);

	await mgr.stop();
	delete process.env.OMP_SQUAD_RACE_ONCE;
});
