/**
 * Validator veto → next-turn reprompt (concern 02, research-mastra-code plan). Off by default
 * (OMP_SQUAD_VETO_REPROMPT). When a land is blocked by an independent validator veto (verdict on the
 * DTO's `validation`), the loop feeds the reason + unmet criteria back into the SAME unit ONCE per veto
 * cycle (blocks === 1) via the continueAgent dep, instead of blind-retrying an unchanged diff until the
 * park ceiling. With the flag unset, or without a veto verdict, continueAgent never fires. The
 * LAND_RETRY_CAP park ceiling is unchanged either way.
 */

import { afterEach, expect, test } from "bun:test";
import { Orchestrator } from "../src/orchestrator.ts";
import type { AgentDTO, AgentStatus, ValidationRecord } from "../src/types.ts";

const savedDrive = process.env.OMP_SQUAD_AUTODRIVE;
const savedFlag = process.env.OMP_SQUAD_VETO_REPROMPT;
afterEach(() => {
	if (savedDrive === undefined) delete process.env.OMP_SQUAD_AUTODRIVE;
	else process.env.OMP_SQUAD_AUTODRIVE = savedDrive;
	if (savedFlag === undefined) delete process.env.OMP_SQUAD_VETO_REPROMPT;
	else process.env.OMP_SQUAD_VETO_REPROMPT = savedFlag;
});

const veto: ValidationRecord = {
	verdict: "veto",
	agreement: 0.5,
	confidence: 0.9,
	perCriterion: [
		{ id: "auth-works", satisfied: false },
		{ id: "tests-pass", satisfied: true },
		{ id: "no-regression", satisfied: false },
	],
	rationale: "auth flow still broken",
	ranAt: 0,
};

const agent = (id: string, status: AgentStatus, validation?: ValidationRecord): AgentDTO => ({
	id,
	name: id,
	status,
	kind: "omp-operator",
	repo: "/r",
	worktree: "/w",
	approvalMode: "write",
	pending: [],
	lastActivity: 0,
	messageCount: 0,
	validation,
});

function buildOrch(flagOn: boolean, dto: AgentDTO, continued: Array<[string, string]>): Orchestrator {
	if (flagOn) process.env.OMP_SQUAD_VETO_REPROMPT = "1";
	else delete process.env.OMP_SQUAD_VETO_REPROMPT;
	return new Orchestrator({
		listAgents: () => [dto],
		spawn: async () => { throw new Error("no spawn"); },
		verify: async () => true,
		land: async () => true,
		verifyAgent: async () => true, // green: pass verify, proceed to land
		landAgentWork: async () => false, // blocked (the veto surfaces here as a falsy land outcome)
		agentHasWork: async () => true,
		continueAgent: async (id, note) => { continued.push([id, note]); },
		log: () => {},
	});
}

test("flag on + veto: fires continueAgent exactly once per veto cycle with the reason + unmet criteria", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const continued: Array<[string, string]> = [];
	const dto = agent("ag", "idle", veto);
	const orch = buildOrch(true, dto, continued);

	await orch.tick(); // blocks === 1 → reprompt
	expect(continued.length).toBe(1);
	const [id, note] = continued[0]!;
	expect(id).toBe("ag");
	expect(note).toContain("auth flow still broken"); // rationale
	expect(note).toContain("auth-works"); // unmet criterion
	expect(note).toContain("no-regression"); // unmet criterion
	expect(note).not.toContain("tests-pass"); // satisfied criterion excluded

	await orch.tick(); // blocks === 2 → NOT fired again (once per veto cycle)
	expect(continued.length).toBe(1);
});

test("flag off: never fires continueAgent even on a veto-blocked land", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const continued: Array<[string, string]> = [];
	const orch = buildOrch(false, agent("ag", "idle", veto), continued);

	await orch.tick();
	await orch.tick();
	expect(continued.length).toBe(0);
});

test("flag on but no veto verdict (plain block): never fires", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const continued: Array<[string, string]> = [];
	// No validation record ⇒ ordinary blocked land, not a veto ⇒ no reprompt.
	const orch = buildOrch(true, agent("ag", "idle", undefined), continued);

	await orch.tick();
	expect(continued.length).toBe(0);
});
