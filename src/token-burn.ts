import { TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT } from "./transcript-event-kinds.ts";
import type { RunReceipt } from "./types.ts";

export { TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT };

export interface TokenBurnUnitPayload {
	kind: "unit";
	agentId: string;
	unit: string;
	repo: string;
	lane?: string;
	model?: string;
	runId: string;
	tokens?: number;
	costUsd?: number;
	toolCalls: number;
	endedAt?: number;
}

export interface TokenBurnRollupPayload {
	kind: "fleet-rollup";
	reason: "cost-gate";
	action: string;
	line: string;
	totals: { runs: number; units: number; tokens: number; costUsd: number; toolCalls: number };
	byUnit: TokenBurnBucket[];
	byLane: TokenBurnBucket[];
	byModel: TokenBurnBucket[];
}

export interface TokenBurnBucket {
	key: string;
	runs: number;
	units: number;
	tokens: number;
	costUsd: number;
	toolCalls: number;
}

export type TokenBurnPayload = TokenBurnUnitPayload | TokenBurnRollupPayload;

function receiptTokens(receipt: RunReceipt): number | undefined {
	return receipt.tokens?.total;
}

function bucketKey(value: string | undefined): string {
	return value && value.trim() ? value : "unknown";
}

export function unitTokenBurnPayload(receipt: RunReceipt): TokenBurnUnitPayload {
	return {
		kind: "unit",
		agentId: receipt.agentId,
		unit: receipt.name,
		repo: receipt.repo,
		lane: receipt.lane,
		model: receipt.model,
		runId: receipt.runId,
		tokens: receiptTokens(receipt),
		costUsd: receipt.costUsd,
		toolCalls: receipt.toolCalls,
		endedAt: receipt.endedAt,
	};
}

function aggregate(receipts: RunReceipt[], keyOf: (receipt: RunReceipt) => string): TokenBurnBucket[] {
	const buckets = new Map<string, TokenBurnBucket & { unitIds: Set<string> }>();
	for (const receipt of receipts) {
		const key = keyOf(receipt);
		const bucket = buckets.get(key) ?? { key, runs: 0, units: 0, tokens: 0, costUsd: 0, toolCalls: 0, unitIds: new Set<string>() };
		bucket.runs += 1;
		bucket.unitIds.add(receipt.agentId);
		bucket.units = bucket.unitIds.size;
		bucket.tokens += receiptTokens(receipt) ?? 0;
		bucket.costUsd += receipt.costUsd ?? 0;
		bucket.toolCalls += receipt.toolCalls;
		buckets.set(key, bucket);
	}
	return [...buckets.values()]
		.map(({ unitIds: _unitIds, ...bucket }) => bucket)
		.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.key.localeCompare(b.key));
}

export function buildFleetEconomics(receipts: RunReceipt[]): TokenBurnRollupPayload["totals"] & { byUnit: TokenBurnBucket[]; byLane: TokenBurnBucket[]; byModel: TokenBurnBucket[] } {
	const units = new Set(receipts.map((receipt) => receipt.agentId));
	return {
		runs: receipts.length,
		units: units.size,
		tokens: receipts.reduce((sum, receipt) => sum + (receiptTokens(receipt) ?? 0), 0),
		costUsd: receipts.reduce((sum, receipt) => sum + (receipt.costUsd ?? 0), 0),
		toolCalls: receipts.reduce((sum, receipt) => sum + receipt.toolCalls, 0),
		byUnit: aggregate(receipts, (receipt) => bucketKey(receipt.name || receipt.agentId)),
		byLane: aggregate(receipts, (receipt) => bucketKey(receipt.lane)),
		byModel: aggregate(receipts, (receipt) => bucketKey(receipt.model)),
	};
}

export function fleetTokenBurnPayload(receipts: RunReceipt[], verdict: { action: string; line: string }): TokenBurnRollupPayload {
	const economics = buildFleetEconomics(receipts);
	return {
		kind: "fleet-rollup",
		reason: "cost-gate",
		action: verdict.action,
		line: verdict.line,
		totals: {
			runs: economics.runs,
			units: economics.units,
			tokens: economics.tokens,
			costUsd: economics.costUsd,
			toolCalls: economics.toolCalls,
		},
		byUnit: economics.byUnit,
		byLane: economics.byLane,
		byModel: economics.byModel,
	};
}

export function tokenBurnFace(payload: TokenBurnPayload): Record<string, unknown> {
	if (payload.kind === "unit") {
		return {
			title: `Token burn · ${payload.unit}`,
			eyebrow: "Unit economics",
			body: `${payload.tokens ?? 0} tokens · $${(payload.costUsd ?? 0).toFixed(4)}`,
			detail: payload.model ? `${payload.model}${payload.lane ? ` · ${payload.lane}` : ""}` : payload.lane,
			tone: "info",
			pinned: { unit: payload.unit, tokens: payload.tokens ?? 0, cost: `$${(payload.costUsd ?? 0).toFixed(4)}` },
		};
	}
	return {
		title: "Fleet token burn threshold",
		eyebrow: "Fleet economics",
		body: `${payload.totals.tokens} tokens · $${payload.totals.costUsd.toFixed(4)} · ${payload.totals.runs} runs`,
		detail: payload.line,
		status: payload.action,
		tone: payload.action === "deny" ? "destructive" : payload.action === "ask" ? "warning" : "info",
		pinned: { units: payload.totals.units, tokens: payload.totals.tokens, cost: `$${payload.totals.costUsd.toFixed(4)}` },
	};
}
