import { describe, expect, test } from "bun:test";
import { buildFleetEconomics, unitTokenBurnPayload } from "./token-burn.ts";
import type { RunReceipt } from "./types.ts";

function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		agentId: "unit-a",
		name: "Unit A",
		repo: "/repo",
		runId: "run-a",
		startedAt: 100,
		endedAt: 200,
		status: "idle",
		toolCalls: 0,
		toolTally: {},
		tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 999 },
		costUsd: 0,
		filesTouched: [],
		...overrides,
	};
}

function byKey<T extends { key: string }>(rows: T[]): Record<string, T> {
	return Object.fromEntries(rows.map((row) => [row.key, row]));
}

describe("unitTokenBurnPayload", () => {
	test("preserves the receipt fields rendered on the token-burn unit card", () => {
		const payload = unitTokenBurnPayload(receipt({
			agentId: "agent-17",
			name: "Verifier",
			repo: "/fleet/repo",
			runId: "run-17",
			lane: "hotfix",
			model: "openai/gpt-5.6-sol",
			toolCalls: 7,
			tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 1234 },
			costUsd: 0.9876,
			endedAt: 456,
		}));

		expect(payload).toEqual({
			kind: "unit",
			agentId: "agent-17",
			unit: "Verifier",
			repo: "/fleet/repo",
			lane: "hotfix",
			model: "openai/gpt-5.6-sol",
			runId: "run-17",
			tokens: 1234,
			costUsd: 0.9876,
			toolCalls: 7,
			endedAt: 456,
		});
	});

	/** ticket #336 gauntlet finding 3 (grok, HIGH): a receipt with no costUsd because its harness's usage
	 *  ingestion is unverified must carry that forward as `costUnknown`, not silently drop into the
	 *  payload as if it were simply absent (which a consumer would then render as a fabricated $0). */
	test("carries costUnknown through so a per-unit card can say 'unattributed', not fabricate $0", () => {
		const payload = unitTokenBurnPayload(receipt({ costUsd: undefined, costUnknown: true }));
		expect(payload.costUsd).toBeUndefined();
		expect(payload.costUnknown).toBe(true);
	});
});

describe("buildFleetEconomics", () => {
	test("aggregates GET /api/usage receipt token, cost, tool, unit, lane, and model fields", () => {
		const economics = buildFleetEconomics([
			receipt({ agentId: "agent-a", name: "Alpha", lane: "feature", model: "model-a", runId: "r1", toolCalls: 2, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 100 }, costUsd: 1.25 }),
			receipt({ agentId: "agent-b", name: "Alpha", lane: "hotfix", model: "model-a", runId: "r2", toolCalls: 3, tokens: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 70 }, costUsd: 0.75 }),
			receipt({ agentId: "agent-c", name: "Beta", lane: "feature", model: "model-b", runId: "r3", toolCalls: 5, tokens: { input: 9, output: 10, cacheRead: 11, cacheWrite: 12, total: 30 }, costUsd: 2 }),
		]);

		expect({ runs: economics.runs, units: economics.units, tokens: economics.tokens, costUsd: economics.costUsd, toolCalls: economics.toolCalls, unattributedRuns: economics.unattributedRuns }).toEqual({
			runs: 3,
			units: 3,
			tokens: 200,
			costUsd: 4,
			toolCalls: 10,
			unattributedRuns: 0,
		});
		expect(byKey(economics.byUnit)).toEqual({
			Alpha: { key: "Alpha", runs: 2, units: 2, tokens: 170, costUsd: 2, toolCalls: 5, unattributedRuns: 0 },
			Beta: { key: "Beta", runs: 1, units: 1, tokens: 30, costUsd: 2, toolCalls: 5, unattributedRuns: 0 },
		});
		expect(byKey(economics.byLane)).toEqual({
			feature: { key: "feature", runs: 2, units: 2, tokens: 130, costUsd: 3.25, toolCalls: 7, unattributedRuns: 0 },
			hotfix: { key: "hotfix", runs: 1, units: 1, tokens: 70, costUsd: 0.75, toolCalls: 3, unattributedRuns: 0 },
		});
		expect(byKey(economics.byModel)).toEqual({
			"model-a": { key: "model-a", runs: 2, units: 2, tokens: 170, costUsd: 2, toolCalls: 5, unattributedRuns: 0 },
			"model-b": { key: "model-b", runs: 1, units: 1, tokens: 30, costUsd: 2, toolCalls: 5, unattributedRuns: 0 },
		});
	});

	/** ticket #336 gauntlet finding 3 (grok, HIGH): codex has no usageVerified, so a run whose usage
	 *  never arrived stamps costUnknown:true with costUsd left undefined (squad-manager.ts's
	 *  finalizeRun). Before this fix, `costUsd ?? 0` folded that into the sum — a verified-but-
	 *  usage-unconfirmed harness rendered as literally free. Pin: the unknown receipt contributes
	 *  nothing to costUsd, but IS counted in unattributedRuns so nothing silently disappears. */
	test("a costUnknown receipt is excluded from cost sums and tallied as unattributedRuns instead — never fabricated as $0", () => {
		const economics = buildFleetEconomics([
			receipt({ agentId: "agent-known", name: "Known", lane: "feature", model: "claude-opus-4-8", runId: "r1", toolCalls: 2, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 100 }, costUsd: 1.5 }),
			receipt({ agentId: "agent-codex", name: "Codex", lane: "feature", model: "gpt-5.6-sol[high]", runId: "r2", toolCalls: 4, tokens: undefined, costUsd: undefined, costUnknown: true }),
		]);

		expect(economics.costUsd).toBe(1.5); // the unknown run's absent cost never became a fabricated 0
		expect(economics.unattributedRuns).toBe(1);
		expect(economics.runs).toBe(2); // still counted as a real run — just cost-unattributed, not vanished

		const byModel = byKey(economics.byModel);
		expect(byModel["gpt-5.6-sol[high]"]).toEqual({ key: "gpt-5.6-sol[high]", runs: 1, units: 1, tokens: 0, costUsd: 0, toolCalls: 4, unattributedRuns: 1 });
		expect(byModel["claude-opus-4-8"]).toEqual({ key: "claude-opus-4-8", runs: 1, units: 1, tokens: 100, costUsd: 1.5, toolCalls: 2, unattributedRuns: 0 });
	});
});
