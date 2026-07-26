import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";

async function boot(stateDir: string): Promise<SquadManager> {
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "cold-start-wt-"));
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	return mgr;
}

test("a fresh install records its borrowed defaults and unknowns at boot", async () => {
	// Without this the module has no caller: the learning state is never created, the six borrowed
	// defaults never exist, and `proposalSampleFloor` always returns undefined. Concern 16 would be
	// present in the tree and absent from the product.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cold-start-"));
	const mgr = await boot(stateDir);
	const state = await mgr.learningState();
	expect(state?.kind).toBe("learning-state");
	if (state?.kind !== "learning-state") throw new Error("expected a learning state");

	// Everything it knows on day one is BORROWED, and says so.
	expect(state.borrowedDefaults.length).toBeGreaterThanOrEqual(6);
	expect(state.borrowedDefaults.every((rule) => rule.status === "borrowed")).toBe(true);
	// Each one is reversible in a single action, stated in the rule itself.
	expect(state.borrowedDefaults.every((rule) => rule.reversal.trim().length > 0)).toBe(true);
	// The one question that has no default.
	expect(state.outOfHoursContact).toBe("unset");
	// And the ledger says what it cannot know, what would settle it, and what not knowing costs.
	expect(state.unknowns.length).toBeGreaterThan(0);
	for (const unknown of state.unknowns) {
		expect(unknown.settlingEvidence.trim()).toBeTruthy();
		expect(unknown.costOfNotKnowing.trim()).toBeTruthy();
		expect(unknown.requiredSampleSize).toBeGreaterThan(0);
	}
	await mgr.stop();
	await fs.rm(stateDir, { recursive: true, force: true });
});

test("a restart never overwrites what the person has since answered", async () => {
	// The same failure the autoland grant has: a boot-time seed that re-runs is a boot-time seed that
	// silently undoes a human.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cold-start-restart-"));
	const first = await boot(stateDir);
	const original = await first.learningState();
	await first.stop();

	const second = await boot(stateDir);
	const after = await second.learningState();
	expect(after).toEqual(original);
	await second.stop();
	await fs.rm(stateDir, { recursive: true, force: true });
});
