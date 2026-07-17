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
import { DO_NOT_BLOCK, DO_NOT_HEADER, effectSkillPointerLine, upsertDoNotBlock } from "../src/agent-profiles.ts";
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

// ── upsertDoNotBlock: append when absent, REFRESH when present, never duplicate ───────────────────────

test("upsertDoNotBlock: appends to a block-less prompt and to undefined", () => {
	expect(upsertDoNotBlock(undefined)).toBe(DO_NOT_BLOCK);
	const out = upsertDoNotBlock("CAPABILITY-GRANT: read");
	expect(out.startsWith("CAPABILITY-GRANT: read\n\n")).toBe(true);
	expect(out.split(DO_NOT_HEADER).length - 1).toBe(1);
});

test("upsertDoNotBlock: replaces a STALE block with the current one (rule edits reach adopted units)", () => {
	const stale = `${DO_NOT_HEADER}\nDo not use the old rule that was later removed.`;
	const prompt = `persisted prefix\n\n${stale}\n\ntrailing spec block`;
	const out = upsertDoNotBlock(prompt);
	expect(out).toContain(DO_NOT_BLOCK);
	expect(out).not.toContain("old rule that was later removed");
	expect(out.startsWith("persisted prefix\n\n")).toBe(true);
	expect(out.endsWith("\n\ntrailing spec block")).toBe(true);
	expect(out.split(DO_NOT_HEADER).length - 1).toBe(1);
});

test("upsertDoNotBlock: identity when the prompt already carries the CURRENT block", () => {
	const prompt = `prefix\n\n${DO_NOT_BLOCK}\n\nsuffix`;
	expect(upsertDoNotBlock(prompt)).toBe(prompt);
});

// ── Effect-skill pointer: keyed to the UNIT'S TARGET REPO's vendored skill, never the daemon's ───────

/** A fake target repo carrying (or not) a vendored effect skill with an optional stamp. */
async function makeSkillRepo(prefix: string, opts: { skill: boolean; stamp?: string }): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	if (opts.skill) {
		const dir = path.join(repo, ".claude", "skills", "effect");
		await fs.mkdir(dir, { recursive: true });
		const fm = ["---", "name: effect", "description: test", ...(opts.stamp ? [`verified-against: ${opts.stamp}`] : []), "---", "body"];
		await fs.writeFile(path.join(dir, "SKILL.md"), fm.join("\n"));
	}
	return repo;
}

test("effectSkillPointerLine: undefined for non-Effect-shaped text, even when the repo has the skill", async () => {
	const repo = await makeSkillRepo("eff-ptr-noshape-", { skill: true, stamp: "effect@4.0.0-beta.98" });
	expect(effectSkillPointerLine("refactor the login flow", repo)).toBeUndefined();
	expect(effectSkillPointerLine(undefined, repo)).toBeUndefined();
});

test("effectSkillPointerLine: undefined when the TARGET repo lacks the vendored skill (cross-repo dispatch)", async () => {
	const repo = await makeSkillRepo("eff-ptr-noskill-", { skill: false });
	expect(effectSkillPointerLine("write an Effect service layer", repo)).toBeUndefined();
	expect(effectSkillPointerLine("write an Effect service layer", undefined)).toBeUndefined();
});

test("effectSkillPointerLine: quotes the skill's own verified-against stamp — the gate-maintained truth, not a package.json range", async () => {
	const repo = await makeSkillRepo("eff-ptr-stamp-", { skill: true, stamp: "effect@4.0.0-beta.98" });
	const line = effectSkillPointerLine("write an Effect service layer", repo);
	expect(line).toBeDefined();
	expect(line).toContain(".claude/skills/effect");
	expect(line).toContain("compile-proven against the installed effect@4.0.0-beta.98");
	expect(line).not.toContain("^"); // never a caret range presented as a pin
});

test("effectSkillPointerLine: no stamp ⇒ pointer still fires, minus the version claim", async () => {
	const repo = await makeSkillRepo("eff-ptr-nostamp-", { skill: true });
	const line = effectSkillPointerLine("write an Effect service layer", repo);
	expect(line).toBeDefined();
	expect(line).toContain(".claude/skills/effect");
	expect(line).not.toContain("compile-proven");
});

test("effectSkillPointerLine: import-specifier and version-pin shapes also match, bare 'effect' as English prose does not", async () => {
	const repo = await makeSkillRepo("eff-ptr-shapes-", { skill: true, stamp: "effect@4.0.0-beta.98" });
	expect(effectSkillPointerLine('import { pipe } from "effect"', repo)).toBeDefined();
	expect(effectSkillPointerLine("bump effect@4.0.0-beta.97", repo)).toBeDefined();
	expect(effectSkillPointerLine("this change takes effect immediately", repo)).toBeUndefined();
});

test("effectSkillPointerLine: THIS repo (the daemon's own checkout as target) fires with the real vendored skill", () => {
	const line = effectSkillPointerLine("write an Effect service layer", path.join(import.meta.dir, ".."));
	expect(line).toBeDefined();
	expect(line).toContain(".claude/skills/effect");
	expect(line).toMatch(/effect@4\.0\.0-beta\.\d+/);
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

test("create() with an Effect-shaped task: pointer fires iff the UNIT'S repo carries the vendored skill", async () => {
	const { mgr, repo } = await makeMgr("donot-effect-shaped");
	// Target repo has no vendored skill ⇒ no pointer (a unit must never be pointed at a skill its
	// worktree doesn't contain — the daemon's own install is irrelevant).
	const dto = await mgr.create({ repo, name: "u3", task: "write an Effect service layer for the ingest pipeline", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.options.appendSystemPrompt ?? "").toContain(DO_NOT_BLOCK);
	expect(rec.options.appendSystemPrompt ?? "").not.toContain(".claude/skills/effect");
	// Vendor the skill into the target repo ⇒ pointer fires with the stamp's version.
	const skillDir = path.join(repo, ".claude", "skills", "effect");
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(path.join(skillDir, "SKILL.md"), ["---", "name: effect", "description: t", "verified-against: effect@4.0.0-beta.98", "---", "b"].join("\n"));
	const dto2 = await mgr.create({ repo, name: "u4", task: "write an Effect service layer for the ingest pipeline", approvalMode: "yolo", autoRoute: false });
	const rec2 = (mgr as unknown as InternalHost).agents.get(dto2.id)!;
	const prompt2 = rec2.options.appendSystemPrompt ?? "";
	expect(prompt2).toContain(DO_NOT_BLOCK);
	expect(prompt2).toContain("Load .claude/skills/effect before writing Effect code");
	expect(prompt2).toContain("effect@4.0.0-beta.98");
	await mgr.stop();
});
