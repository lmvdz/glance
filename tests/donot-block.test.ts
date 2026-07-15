/**
 * plans/skills-hardening concern 04 (evergreen Do-Not block): DO_NOT_BLOCK's unconditional join into
 * every unit's appendSystemPrompt — profiled or not, dispatched or ad-hoc — and NOT via `profile.memory`
 * (which only runs `if (profile)` and therefore never reaches a profile-less dispatched unit, the exact
 * delivery-gap class R3 fixed for the primer). Also covers the Effect-skill pointer line's gating.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DO_NOT_BLOCK, effectSkillPointerLine } from "../src/agent-profiles.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

const tmps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function stashEnv(...keys: string[]): void {
	for (const k of keys) savedEnv[k] = process.env[k];
}
afterEach(async () => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(savedEnv)) delete savedEnv[k];
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

// ── DO_NOT_BLOCK content: evergreen, "Do not X" shaped, capped well under 600 tokens ─────────────────

test("DO_NOT_BLOCK: ~10 evergreen Do-Not lines, each names a concrete failure mode", () => {
	const lines = DO_NOT_BLOCK.split("\n").filter((l) => l.startsWith("Do not"));
	expect(lines.length).toBeGreaterThanOrEqual(9);
	expect(lines.length).toBeLessThanOrEqual(12);
	for (const l of lines) expect(l.startsWith("Do not")).toBe(true);
	expect(DO_NOT_BLOCK).toMatch(/chunk-size warning/i);
	expect(DO_NOT_BLOCK).toMatch(/verify loop a third time/i);
	expect(DO_NOT_BLOCK).toMatch(/gate that never executed/i);
	expect(DO_NOT_BLOCK).toMatch(/-E — bare alternation/);
	expect(DO_NOT_BLOCK).toMatch(/git stash/);
});

test("DO_NOT_BLOCK: well under a 600-token cap (roughly 4 chars/token)", () => {
	expect(DO_NOT_BLOCK.length / 4).toBeLessThan(600);
});

// ── Effect-skill pointer line: pure-function gating (task shape AND skill-dir existence) ─────────────

test("effectSkillPointerLine: undefined for non-Effect-shaped text, even with an existing skill dir", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "effect-skill-dir-"));
	tmps.push(dir);
	expect(effectSkillPointerLine("refactor the login flow", dir)).toBeUndefined();
	expect(effectSkillPointerLine(undefined, dir)).toBeUndefined();
});

test("effectSkillPointerLine: undefined for Effect-shaped text when the skill dir does NOT exist", async () => {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "effect-skill-missing-"));
	tmps.push(parent);
	const missing = path.join(parent, "does-not-exist");
	expect(effectSkillPointerLine("write an Effect service layer", missing)).toBeUndefined();
});

test("effectSkillPointerLine: fires for Effect-shaped text once the skill dir exists, naming the resolved pin", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "effect-skill-present-"));
	tmps.push(dir);
	const line = effectSkillPointerLine("write an Effect service layer", dir);
	expect(line).toBeDefined();
	expect(line).toContain(".claude/skills/effect");
	expect(line).toMatch(/effect@\^?4\.0\.0-beta\.\d+/);
});

test("effectSkillPointerLine: import-specifier and version-pin shapes also match, bare 'effect' as English prose does not", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "effect-skill-shapes-"));
	tmps.push(dir);
	expect(effectSkillPointerLine('import { pipe } from "effect"', dir)).toBeDefined();
	expect(effectSkillPointerLine("bump effect@4.0.0-beta.97", dir)).toBeDefined();
	expect(effectSkillPointerLine("this change takes effect immediately", dir)).toBeUndefined();
});

test("effectSkillPointerLine: with the real (default) skill dir, undefined today — concern 02 hasn't vendored it yet", () => {
	// No skillDir override: exercises the actual `.claude/skills/effect` path in THIS repo, proving the
	// gate holds in production wiring right now (the directory genuinely doesn't exist yet).
	expect(effectSkillPointerLine("write an Effect service layer")).toBeUndefined();
});

// ── End-to-end delivery: SquadManager wiring (dispatchSpawn shape: no profileId) ──────────────────────

class FakeDriver extends EventEmitter implements AgentDriver {
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
	options: { appendSystemPrompt?: string };
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

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	return { mgr, repo };
}

test("create() with NO profileId (the dispatchSpawn shape: repo/name/branch/task/issue) composes DO_NOT_BLOCK into appendSystemPrompt", async () => {
	const { mgr, repo } = await makeMgr("donot-no-profile");
	const dto = await mgr.create({
		repo,
		name: "u1",
		branch: "squad/u1",
		task: "PROJ-1: fix the thing",
		issue: { id: "iss-1", identifier: "PROJ-1", name: "fix the thing" },
		approvalMode: "yolo",
		autoRoute: false,
	});
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.options.appendSystemPrompt).toContain(DO_NOT_BLOCK);
	await mgr.stop();
});

test("create() ad-hoc (no repo issue, no profileId — mirrors `glance add`) still composes DO_NOT_BLOCK", async () => {
	const { mgr, repo } = await makeMgr("donot-adhoc");
	const dto = await mgr.create({ repo, name: "adhoc1", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.options.appendSystemPrompt).toContain(DO_NOT_BLOCK);
	await mgr.stop();
});

test("create() WITH a profile: DO_NOT_BLOCK appears exactly once (not duplicated by profile.memory)", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "donot-profile", name: "Do-Not profile", memory: "You are a helpful specialized agent." }]);
	const { mgr, repo } = await makeMgr("donot-with-profile");
	const dto = await mgr.create({ repo, name: "u2", profileId: "donot-profile", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	const prompt = rec.options.appendSystemPrompt ?? "";
	expect(prompt).toContain(DO_NOT_BLOCK);
	expect(prompt).toContain("You are a helpful specialized agent."); // profile.memory still rides its own join
	expect(prompt.split(DO_NOT_BLOCK).length).toBe(2); // exactly one occurrence
	await mgr.stop();
});

test("create() with an Effect-shaped task: no pointer line reaches the prompt today (skill dir not vendored yet), DO_NOT_BLOCK still lands", async () => {
	const { mgr, repo } = await makeMgr("donot-effect-shaped");
	const dto = await mgr.create({ repo, name: "u3", task: "write an Effect service layer for the ingest pipeline", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	const prompt = rec.options.appendSystemPrompt ?? "";
	expect(prompt).toContain(DO_NOT_BLOCK);
	expect(prompt).not.toContain(".claude/skills/effect");
	await mgr.stop();
});
