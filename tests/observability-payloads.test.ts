/**
 * ticket #348: usagePayload's `/api/usage` totals summed `r.costUsd ?? 0` for every receipt,
 * folding a costUnknown receipt (unverified-usage harness — see `RunReceipt.costUnknown`) into the
 * fleet total as a fabricated $0 — the same "verified-but-usage-unconfirmed harness renders as free"
 * defect T8 already fixed for attribution-scoreboard.ts/token-burn.ts/cost-aggregate.ts. This pins the
 * fix: a costUnknown receipt is excluded from `costUsd` and tallied into `unattributedRuns` instead.
 *
 * Hermetic: a minimal fake SquadManager (only the `allReceipts()` method usagePayload actually calls)
 * over a real receipt list — no daemon, no filesystem.
 */
import { expect, test } from "bun:test";
import { usagePayload } from "../src/observability-payloads.ts";
import type { SquadManager } from "../src/squad-manager.ts";
import type { RunReceipt } from "../src/types.ts";

function receipt(over: Partial<RunReceipt>): RunReceipt {
	return {
		agentId: "a1",
		name: "unit",
		repo: "/repo",
		runId: "r1",
		startedAt: 0,
		endedAt: 1,
		status: "stopped",
		toolCalls: 1,
		toolTally: {},
		filesTouched: [],
		...over,
	};
}

function fakeManager(receipts: RunReceipt[]): SquadManager {
	return { allReceipts: async () => receipts } as unknown as SquadManager;
}

test("ticket #348: a costUnknown receipt is excluded from usagePayload's costUsd sum and tallied as unattributedRuns", () => {
	const receipts = [
		receipt({ agentId: "known", runId: "r1", costUsd: 3 }),
		receipt({ agentId: "unknown", runId: "r2", costUsd: undefined, costUnknown: true }),
	];
	const url = new URL("http://localhost/api/usage");
	return usagePayload([fakeManager(receipts)], url).then((payload) => {
		expect(payload.costUsd).toBe(3); // never 3 + (undefined ?? 0) folded in as 3
		expect(payload.unattributedRuns).toBe(1);
		expect(payload.runs.length).toBe(2); // both runs still listed — only the $ sum excludes it
	});
});

test("flip: the SAME receipt with costUnknown true→false moves its cost from excluded to counted", async () => {
	const base = receipt({ agentId: "a1", runId: "r1", costUsd: 5 });
	const url = new URL("http://localhost/api/usage");

	const unknownPayload = await usagePayload([fakeManager([{ ...base, costUnknown: true }])], url);
	expect(unknownPayload.costUsd).toBeUndefined(); // totals.costUsd || undefined ⇒ 0 reads as undefined
	expect(unknownPayload.unattributedRuns).toBe(1);

	const knownPayload = await usagePayload([fakeManager([{ ...base, costUnknown: false }])], url);
	expect(knownPayload.costUsd).toBe(5);
	expect(knownPayload.unattributedRuns).toBeUndefined();
});

test("no costUnknown receipts ⇒ unattributedRuns stays undefined (never a spurious 0 surfaced)", async () => {
	const receipts = [receipt({ agentId: "a1", runId: "r1", costUsd: 1 }), receipt({ agentId: "a2", runId: "r2", costUsd: 2 })];
	const payload = await usagePayload([fakeManager(receipts)], new URL("http://localhost/api/usage"));
	expect(payload.costUsd).toBe(3);
	expect(payload.unattributedRuns).toBeUndefined();
});
