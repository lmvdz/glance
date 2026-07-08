/**
 * Concern 03 (harness scorecard, advisory shadow — plans/research-learn-harness-engineering/
 * 03-harness-scorecard-shadow.md): a pure static score over the five subsystems (instructions/tools/
 * environment/state/feedback), computed once at `createWithId` and stamped onto the DTO. Two layers:
 * the pure `scoreHarness`/`harnessScorecardLogLine` functions (no manager needed), and an integration
 * layer proving `SquadManager#create` wires the right signals for each dimension AND that a maximally
 * red (0/5) unit is still spawned successfully — the core "advisory, never blocking" contract.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { harnessScorecardEnabled, harnessScorecardLogLine, scoreHarness, type HarnessScorecardInput } from "../src/harness-scorecard.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

// ───────────────────────────── pure scoreHarness / harnessScorecardLogLine ─────────────────────────────

const GREEN: HarnessScorecardInput = {
	hasInstructions: true,
	toolsScoped: true,
	isolatedEnvironment: true,
	continuityAnchor: true,
	hasFeedbackGate: true,
};

test("scoreHarness: all-green input scores 5/5 with no red flags", () => {
	const card = scoreHarness(GREEN);
	expect(card.score).toBe(5);
	expect(card.redFlags).toEqual([]);
	expect(card.dimensions).toEqual({ instructions: true, tools: true, environment: true, state: true, feedback: true });
});

test("scoreHarness: all-red input scores 0/5 with one red flag per dimension", () => {
	const card = scoreHarness({ hasInstructions: false, toolsScoped: false, isolatedEnvironment: false, continuityAnchor: false, hasFeedbackGate: false });
	expect(card.score).toBe(0);
	expect(card.redFlags).toHaveLength(5);
	expect(card.redFlags.some((f) => f.includes("title-only"))).toBe(true);
	expect(card.redFlags.some((f) => f.includes("unscoped"))).toBe(true);
	expect(card.redFlags.some((f) => f.includes("in place"))).toBe(true);
	expect(card.redFlags.some((f) => f.includes("continuity anchor"))).toBe(true);
	expect(card.redFlags.some((f) => f.includes("feedback gate"))).toBe(true);
});

test("scoreHarness: exactly one red dimension scores 4/5 with exactly one red flag naming it", () => {
	const card = scoreHarness({ ...GREEN, toolsScoped: false });
	expect(card.score).toBe(4);
	expect(card.dimensions.tools).toBe(false);
	expect(card.redFlags).toHaveLength(1);
	expect(card.redFlags[0]).toContain("unscoped");
});

test("scoreHarness: never throws and accepts an injected clock seam", () => {
	const card = scoreHarness({ ...GREEN, now: () => 12345 });
	expect(card.at).toBe(12345);
});

test("harnessScorecardLogLine: undefined for an absent scorecard", () => {
	expect(harnessScorecardLogLine(undefined)).toBeUndefined();
});

test("harnessScorecardLogLine: undefined for a clean 5/5 (nothing to say)", () => {
	expect(harnessScorecardLogLine(scoreHarness(GREEN))).toBeUndefined();
});

test("harnessScorecardLogLine: a one-line diagnostic naming the score and every red flag for a red unit", () => {
	const card = scoreHarness({ ...GREEN, hasInstructions: false, hasFeedbackGate: false });
	const line = harnessScorecardLogLine(card);
	expect(line).toContain("3/5");
	expect(line).toContain("title-only");
	expect(line).toContain("feedback gate");
});

test("harnessScorecardEnabled: default ON when unset", () => {
	const prior = process.env.OMP_SQUAD_HARNESS_SCORECARD;
	delete process.env.OMP_SQUAD_HARNESS_SCORECARD;
	try {
		expect(harnessScorecardEnabled()).toBe(true);
	} finally {
		if (prior === undefined) delete process.env.OMP_SQUAD_HARNESS_SCORECARD;
		else process.env.OMP_SQUAD_HARNESS_SCORECARD = prior;
	}
});

test("harnessScorecardEnabled: OMP_SQUAD_HARNESS_SCORECARD=0 turns it off", () => {
	const prior = process.env.OMP_SQUAD_HARNESS_SCORECARD;
	process.env.OMP_SQUAD_HARNESS_SCORECARD = "0";
	try {
		expect(harnessScorecardEnabled()).toBe(false);
	} finally {
		if (prior === undefined) delete process.env.OMP_SQUAD_HARNESS_SCORECARD;
		else process.env.OMP_SQUAD_HARNESS_SCORECARD = prior;
	}
});

// ───────────────────────────── integration: SquadManager#create wiring ─────────────────────────────

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

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

test("instructions: an issue-dispatched title-only unit (no description, no primer) scores red", async () => {
	const { mgr, repo } = await makeMgr("hs-instructions-red");
	const dto = await mgr.create({
		repo, approvalMode: "yolo", verify: "true",
		issue: { id: "X-1", name: "title only" },
		requires: ["a"], produces: ["b"], featureId: "feat-1",
	});
	expect(dto.harnessScorecard?.dimensions.instructions).toBe(false);
	expect(dto.harnessScorecard?.redFlags.some((f) => f.includes("title-only"))).toBe(true);
	await mgr.stop();
});

test("instructions: an issue carrying an authored spec body (concern 01) scores green", async () => {
	const { mgr, repo } = await makeMgr("hs-instructions-green");
	const dto = await mgr.create({
		repo, approvalMode: "yolo", verify: "true",
		issue: { id: "X-2", name: "title only", description: "Full Tier-2 spec: acceptance criteria, scope, verification steps." },
		requires: ["a"], produces: ["b"], featureId: "feat-1",
	});
	expect(dto.harnessScorecard?.dimensions.instructions).toBe(true);
	// Fully provisioned on every other axis too ⇒ a clean 5/5.
	expect(dto.harnessScorecard?.score).toBe(5);
	expect(dto.harnessScorecard?.redFlags).toEqual([]);
	await mgr.stop();
});

test("instructions: an ad-hoc (non-issue) task counts as instructions — no title/body split to fail", async () => {
	const { mgr, repo } = await makeMgr("hs-instructions-adhoc");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", task: "do the whole thing end to end", requires: ["a"], featureId: "feat-1" });
	expect(dto.harnessScorecard?.dimensions.instructions).toBe(true);
	await mgr.stop();
});

test("tools: no profile grant and no requires/produces scores red", async () => {
	const { mgr, repo } = await makeMgr("hs-tools-red");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", task: "unscoped work", featureId: "feat-1" });
	expect(dto.harnessScorecard?.dimensions.tools).toBe(false);
	await mgr.stop();
});

test("tools: an explicit requires/produces scope contract scores green even without a profile", async () => {
	const { mgr, repo } = await makeMgr("hs-tools-green");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", task: "scoped work", requires: ["src/a.ts"], produces: ["src/b.ts"], featureId: "feat-1" });
	expect(dto.harnessScorecard?.dimensions.tools).toBe(true);
	await mgr.stop();
});

test("environment: a real worktree cut scores green", async () => {
	const { mgr, repo } = await makeMgr("hs-env-green");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", task: "isolated work", requires: ["a"], featureId: "feat-1" });
	expect(dto.harnessScorecard?.dimensions.environment).toBe(true);
	await mgr.stop();
});

test("environment: existingPath pointing at a non-git directory scores red (no isolation)", async () => {
	const { mgr, repo } = await makeMgr("hs-env-red");
	const bare = await fs.mkdtemp(path.join(os.tmpdir(), "hs-env-red-bare-"));
	tmps.push(bare);
	const dto = await mgr.create({ repo, existingPath: bare, approvalMode: "yolo", verify: "true", task: "in-place work", requires: ["a"], featureId: "feat-1" });
	expect(dto.harnessScorecard?.dimensions.environment).toBe(false);
	expect(dto.harnessScorecard?.redFlags.some((f) => f.includes("in place"))).toBe(true);
	await mgr.stop();
});

test("state: featureId alone is a sufficient continuity anchor", async () => {
	const { mgr, repo } = await makeMgr("hs-state-feature");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", task: "anchored work", requires: ["a"], featureId: "feat-1" });
	expect(dto.harnessScorecard?.dimensions.state).toBe(true);
	await mgr.stop();
});

test("state: a tracked issue alone (no featureId) is a sufficient continuity anchor", async () => {
	const { mgr, repo } = await makeMgr("hs-state-issue");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", issue: { id: "X-3", name: "t", description: "spec" }, requires: ["a"] });
	expect(dto.harnessScorecard?.dimensions.state).toBe(true);
	await mgr.stop();
});

test("state: no featureId, no issue, no workflow checkpoint scores red", async () => {
	const { mgr, repo } = await makeMgr("hs-state-red");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", task: "unanchored work", requires: ["a"] });
	expect(dto.harnessScorecard?.dimensions.state).toBe(false);
	await mgr.stop();
});

test("feedback: no verify command and no workflow scores red", async () => {
	const { mgr, repo } = await makeMgr("hs-feedback-red");
	// autoRoute:false so the intake router never fills opts.verify/opts.workflow in behind the scenes —
	// this test wants a genuinely unverified, fire-and-forget dispatch.
	const dto = await mgr.create({ repo, approvalMode: "yolo", task: "no gate at all", requires: ["a"], featureId: "feat-1", autoRoute: false });
	expect(dto.harnessScorecard?.dimensions.feedback).toBe(false);
	expect(dto.harnessScorecard?.redFlags.some((f) => f.includes("feedback gate"))).toBe(true);
	await mgr.stop();
});

test("feedback: an explicit verify command scores green", async () => {
	const { mgr, repo } = await makeMgr("hs-feedback-green");
	const dto = await mgr.create({ repo, approvalMode: "yolo", verify: "true", task: "gated work", requires: ["a"], featureId: "feat-1" });
	expect(dto.harnessScorecard?.dimensions.feedback).toBe(true);
	await mgr.stop();
});

test("a maximally context-poor unit (0/5, every dimension red) is still spawned successfully — advisory, never blocking", async () => {
	const { mgr, repo } = await makeMgr("hs-never-blocks");
	const bare = await fs.mkdtemp(path.join(os.tmpdir(), "hs-never-blocks-bare-"));
	tmps.push(bare);
	// No issue-with-description, no requires/produces/profile, existingPath outside git, no featureId,
	// no verify/workflow, autoRoute:false — every one of the five dimensions is deliberately red.
	const dto = await mgr.create({ repo, existingPath: bare, name: "x", approvalMode: "yolo", autoRoute: false });
	expect(dto.status).not.toBe("error");
	expect(dto.harnessScorecard?.score).toBe(0);
	expect(dto.harnessScorecard?.redFlags).toHaveLength(5);
	await mgr.stop();
});

test("OMP_SQUAD_HARNESS_SCORECARD=0 disables the scorecard entirely (no field on the DTO)", async () => {
	const prior = process.env.OMP_SQUAD_HARNESS_SCORECARD;
	process.env.OMP_SQUAD_HARNESS_SCORECARD = "0";
	try {
		const { mgr, repo } = await makeMgr("hs-disabled");
		const dto = await mgr.create({
			repo, approvalMode: "yolo", verify: "true",
			issue: { id: "X-4", name: "t", description: "spec" }, requires: ["a"], produces: ["b"], featureId: "feat-1",
		});
		expect(dto.harnessScorecard).toBeUndefined();
		await mgr.stop();
	} finally {
		if (prior === undefined) delete process.env.OMP_SQUAD_HARNESS_SCORECARD;
		else process.env.OMP_SQUAD_HARNESS_SCORECARD = prior;
	}
});
