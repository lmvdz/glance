/**
 * Restart-safe goal-overlap disclosure ledger (src/goal-overlap-ledger.ts) — the durable half of
 * the goal-overlap spam fix (EXECUTION-LOG.md "Post-ship fix: goal-overlap spam"). Same
 * tiny-JSON-per-stateDir shape as `land-ledger.test.ts` covers for `land-ledger.ts`: membership,
 * independence between distinct pairs, on-disk persistence across a fresh read of the same dir
 * (the "restart" this whole fix exists for), and corrupt/missing-file resilience.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openGoalOverlapLedger } from "../src/goal-overlap-ledger.ts";

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "goal-overlap-ledger-"));
}

test("a fresh ledger has nothing announced; add() then has() reports it", async () => {
	const dir = await tmpDir();
	const ledger = openGoalOverlapLedger(dir);
	expect(ledger.has("owner-1", "candidate-1")).toBe(false);
	ledger.add("owner-1", "candidate-1");
	expect(ledger.has("owner-1", "candidate-1")).toBe(true);
});

test("pairs are directional and independent — swapping the ids is a different pair, unrelated pairs never collide", async () => {
	const dir = await tmpDir();
	const ledger = openGoalOverlapLedger(dir);
	ledger.add("owner-1", "candidate-1");
	expect(ledger.has("candidate-1", "owner-1")).toBe(false); // swapped roles, not the same pair
	expect(ledger.has("owner-1", "candidate-2")).toBe(false); // same owner, different candidate
	expect(ledger.has("owner-2", "candidate-1")).toBe(false); // different owner, same candidate
});

test("adding the same pair twice is a no-op, not a duplicate write", async () => {
	const dir = await tmpDir();
	const ledger = openGoalOverlapLedger(dir);
	ledger.add("owner-1", "candidate-1");
	ledger.add("owner-1", "candidate-1");
	const raw = JSON.parse(await fs.readFile(path.join(dir, "goal-overlap-ledger.json"), "utf8")) as string[];
	expect(raw).toHaveLength(1);
});

test("the ledger persists on disk (survives a 'restart' — a fresh ledger instance over the same dir)", async () => {
	const dir = await tmpDir();
	const first = openGoalOverlapLedger(dir);
	first.add("owner-1", "candidate-1");
	first.add("owner-1", "candidate-2");

	// Simulate a restart: no shared in-memory state, only the file on disk.
	const second = openGoalOverlapLedger(dir);
	expect(second.has("owner-1", "candidate-1")).toBe(true);
	expect(second.has("owner-1", "candidate-2")).toBe(true);
	expect(second.has("owner-1", "candidate-3")).toBe(false);
});

test("ids that could collide under a naive string join stay distinct pairs", async () => {
	const dir = await tmpDir();
	const ledger = openGoalOverlapLedger(dir);
	// A plain delimiter join would make ("a b", "c") and ("a", "b c") the same key. An operator can
	// name a unit anything, and the id embeds that name verbatim (spawn-identity.ts's `newAgentId`).
	ledger.add("a b", "c");
	expect(ledger.has("a", "b c")).toBe(false);
	expect(ledger.has("a b", "c")).toBe(true);
});

test("a missing or corrupt ledger file reads as empty, never throws", async () => {
	const dir = await tmpDir();
	expect(openGoalOverlapLedger(dir).has("owner-1", "candidate-1")).toBe(false);
	await fs.writeFile(path.join(dir, "goal-overlap-ledger.json"), "{not json");
	expect(openGoalOverlapLedger(dir).has("owner-1", "candidate-1")).toBe(false);
	// And it's still writable afterward — corruption on read must not brick future adds.
	const recovered = openGoalOverlapLedger(dir);
	recovered.add("owner-1", "candidate-1");
	expect(openGoalOverlapLedger(dir).has("owner-1", "candidate-1")).toBe(true);
});
