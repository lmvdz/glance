/**
 * Cold-adopt context restore (concern 01, research-mastra-code plan). A plain unit whose host died is
 * re-created by adoptOrphanedAgents under a fresh id; it must come back with (a) its prior-session
 * digest surfaced as a fenced system transcript entry — the same "surfacing only, no auto-prompt"
 * treatment restart() gives — and (b) its original appendSystemPrompt (tool grants / profile memory /
 * fabric primer) restored on the spawned driver. A resuming WORKFLOW gets neither (it re-executes its
 * checkpointed node and carries its own rollup).
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DO_NOT_BLOCK, DO_NOT_HEADER } from "../src/agent-profiles.ts";
import { FileStore } from "../src/dal/store.ts";
import { writeDigest } from "../src/digest.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class NoopDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	start(): Promise<void> { return Promise.resolve(); }
	stop(): Promise<void> { return Promise.resolve(); }
	prompt(): Promise<void> { return Promise.resolve(); }
	abort(): Promise<unknown> { return Promise.resolve(); }
	getState(): Promise<RpcSessionState> { return Promise.resolve({ todoPhases: [], isStreaming: false } as RpcSessionState); }
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

/** A dirty git worktree so a PLAIN unit passes persistedHasWork() and gets adopted (not dropped as clean). */
async function makeDirtyWorktree(): Promise<string> {
	const wt = await fs.mkdtemp(path.join(os.tmpdir(), "resume-digest-wt-"));
	tmps.push(wt);
	const git = async (args: string[]) => { await Bun.spawn(["git", ...args], { cwd: wt, stdout: "ignore", stderr: "ignore" }).exited; };
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(wt, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	await fs.writeFile(path.join(wt, "wip.txt"), "half-done work\n"); // uncommitted → dirty → has work
	return wt;
}

test("cold-adopting a plain unit surfaces its prior-session digest as a fenced system entry", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-digest-state-"));
	tmps.push(stateDir);
	const worktree = await makeDirtyWorktree();

	// The digest was written during the original run under the ORIGINAL id.
	await writeDigest(stateDir, "orphan-plain-1", "# Goal\nBuild the thing\n\n## Where we left off\nMidway through auth\n");

	const persisted: PersistedAgent = {
		id: "orphan-plain-1",
		name: "orphan",
		repo: worktree,
		worktree,
		approvalMode: "yolo",
		kind: "omp-operator",
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr.start(); // reconnectLive (no live host) → adoptOrphanedAgents

	const roster = mgr.list();
	expect(roster.length).toBe(1);
	const dto = roster[0]!;
	expect(dto.id).not.toBe("orphan-plain-1"); // fresh id on adoption

	const transcript = mgr.getTranscript(dto.id);
	const surfaced = transcript.find((t) => JSON.stringify(t).includes("Resume digest — prior session memory"));
	expect(surfaced).toBeDefined();
	expect(JSON.stringify(surfaced)).toContain("Where we left off"); // the actual digest body came through

	await mgr.stop();
});

test("a resuming workflow does NOT get a digest surfaced (it re-executes its checkpointed node)", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-digest-wf-state-"));
	tmps.push(stateDir);
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "resume-digest-wf-wt-"));
	tmps.push(worktree);

	await writeDigest(stateDir, "orphan-wf-1", "# Goal\nWorkflow goal\n\n## Where we left off\nnode n1\n");

	const persisted: PersistedAgent = {
		id: "orphan-wf-1",
		name: "wf-orphan",
		repo: "(none)",
		worktree,
		approvalMode: "yolo",
		kind: "workflow",
		workflowState: { goal: "g", currentNode: "n1", visits: {}, vars: {}, index: 0, rollup: [] },
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr.start();

	const dto = mgr.list()[0]!;
	const transcript = mgr.getTranscript(dto.id);
	expect(transcript.some((t) => JSON.stringify(t).includes("Resume digest — prior session memory"))).toBe(false);

	await mgr.stop();
});

test("cold-adopt restores the original appendSystemPrompt onto the spawned driver", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-asp-state-"));
	tmps.push(stateDir);
	const worktree = await makeDirtyWorktree();

	const persisted: PersistedAgent = {
		id: "orphan-asp-1",
		name: "orphan",
		repo: worktree,
		worktree,
		approvalMode: "yolo",
		kind: "omp-operator",
		appendSystemPrompt: "CAPABILITY-GRANT: read,edit",
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const seen: Array<string | undefined> = [];
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = (p: PersistedAgent) => {
		seen.push(p.appendSystemPrompt);
		return new NoopDriver();
	};
	await mgr.start();

	// No profile on this unit, so createWithId does not re-compose profile text — the persisted value
	// survives at the front. The evergreen Do-Not block (skills-hardening 04) IS appended on adopt
	// (a pre-04 persisted unit gets upgraded), but idempotently: exactly one copy, guarded by
	// DO_NOT_HEADER — see the second assertion set below for the already-carrying case.
	const adopted = seen.find((s) => s?.startsWith("CAPABILITY-GRANT: read,edit"));
	expect(adopted).toBeDefined();
	expect(adopted!.split(DO_NOT_HEADER).length - 1).toBe(1);

	await mgr.stop();
});

test("cold-adopt is idempotent for a prompt that already carries the Do-Not block", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-asp-state-"));
	tmps.push(stateDir);
	const worktree = await makeDirtyWorktree();

	const already = `CAPABILITY-GRANT: read,edit\n\n${DO_NOT_BLOCK}`;
	const persisted: PersistedAgent = {
		id: "orphan-asp-2",
		name: "orphan2",
		repo: worktree,
		worktree,
		approvalMode: "yolo",
		kind: "omp-operator",
		appendSystemPrompt: already,
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const seen: Array<string | undefined> = [];
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = (p: PersistedAgent) => {
		seen.push(p.appendSystemPrompt);
		return new NoopDriver();
	};
	await mgr.start();

	// Already carries the block — round-trips VERBATIM, no second copy appended on restart.
	expect(seen).toContain(already);

	await mgr.stop();
});
