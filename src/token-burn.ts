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
	/** True when `costUsd` is absent because this harness's usage ingestion is unverified, not because
	 *  the run was genuinely free (ticket #336 gauntlet finding 3 — see `RunReceipt.costUnknown`). */
	costUnknown?: boolean;
	toolCalls: number;
	endedAt?: number;
}

export interface TokenBurnRollupPayload {
	kind: "fleet-rollup";
	reason: "cost-gate";
	action: string;
	line: string;
	totals: { runs: number; units: number; tokens: number; costUsd: number; toolCalls: number; unattributedRuns: number };
	byUnit: TokenBurnBucket[];
	byLane: TokenBurnBucket[];
	byModel: TokenBurnBucket[];
}

export interface TokenBurnBucket {
	key: string;
	runs: number;
	units: number;
	tokens: number;
	/** Sum of costUsd across KNOWN-cost runs only — a `costUnknown` receipt contributes to `runs` but
	 *  never to this sum (ticket #336 gauntlet finding 3: summing `costUsd ?? 0` for an unverified-usage
	 *  harness fabricates a $0 that reads as "free"). */
	costUsd: number;
	toolCalls: number;
	/** Runs bucketed here whose cost is UNKNOWN (unverified-usage harness, no usage ever arrived) —
	 *  excluded from `costUsd` above; a consumer that ignores this field silently under-counts spend. */
	unattributedRuns: number;
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
		costUnknown: receipt.costUnknown,
		toolCalls: receipt.toolCalls,
		endedAt: receipt.endedAt,
	};
}

function aggregate(receipts: RunReceipt[], keyOf: (receipt: RunReceipt) => string): TokenBurnBucket[] {
	const buckets = new Map<string, TokenBurnBucket & { unitIds: Set<string> }>();
	for (const receipt of receipts) {
		const key = keyOf(receipt);
		const bucket = buckets.get(key) ?? { key, runs: 0, units: 0, tokens: 0, costUsd: 0, toolCalls: 0, unattributedRuns: 0, unitIds: new Set<string>() };
		bucket.runs += 1;
		bucket.unitIds.add(receipt.agentId);
		bucket.units = bucket.unitIds.size;
		bucket.tokens += receiptTokens(receipt) ?? 0;
		// costUnknown: excluded from the sum, tallied separately — never folded into costUsd as a
		// fabricated zero (ticket #336 gauntlet finding 3).
		if (receipt.costUnknown) bucket.unattributedRuns += 1;
		else bucket.costUsd += receipt.costUsd ?? 0;
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
		// costUnknown receipts contribute nothing to the sum (see aggregate() above) — never `costUsd ?? 0`.
		costUsd: receipts.reduce((sum, receipt) => sum + (receipt.costUnknown ? 0 : (receipt.costUsd ?? 0)), 0),
		toolCalls: receipts.reduce((sum, receipt) => sum + receipt.toolCalls, 0),
		unattributedRuns: receipts.filter((receipt) => receipt.costUnknown).length,
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
			unattributedRuns: economics.unattributedRuns,
		},
		byUnit: economics.byUnit,
		byLane: economics.byLane,
		byModel: economics.byModel,
	};
}

/** The face literal `tokenBurnFace` actually returns — narrower than `Record<string, unknown>` so
 *  it satisfies the schema-derived `PointerCardFace` contract (`../schema/channel-card.ts`) at
 *  compile time, notably `title` being required rather than merely "present at runtime". */
export interface TokenBurnFace {
	// Index signature keeps this assignable to `Record<string, unknown>` at the one call site
	// (`squad-manager.ts#projectionFace`) that returns it through that wider, shared return type.
	[key: string]: unknown;
	title: string;
	eyebrow: string;
	body: string;
	detail?: string;
	status?: string;
	tone: "info" | "warning" | "destructive";
	pinned: Record<string, string | number>;
}

export function tokenBurnFace(payload: TokenBurnPayload): TokenBurnFace {
	if (payload.kind === "unit") {
		// costUnknown: say so, never a fabricated "$0.0000" (ticket #336 gauntlet finding 3).
		const costText = payload.costUnknown ? "cost unattributed" : `$${(payload.costUsd ?? 0).toFixed(4)}`;
		return {
			title: `Token burn · ${payload.unit}`,
			eyebrow: "Unit economics",
			body: `${payload.tokens ?? 0} tokens · ${costText}`,
			detail: payload.model ? `${payload.model}${payload.lane ? ` · ${payload.lane}` : ""}` : payload.lane,
			tone: "info",
			pinned: { unit: payload.unit, tokens: payload.tokens ?? 0, cost: costText },
		};
	}
	// unattributedRuns > 0: the totals below are a KNOWN-cost floor, not the whole fleet's spend —
	// call that out rather than let a clean-looking dollar figure imply completeness.
	const unattributedNote = payload.totals.unattributedRuns > 0 ? ` (+${payload.totals.unattributedRuns} unattributed)` : "";
	return {
		title: "Fleet token burn threshold",
		eyebrow: "Fleet economics",
		body: `${payload.totals.tokens} tokens · $${payload.totals.costUsd.toFixed(4)}${unattributedNote} · ${payload.totals.runs} runs`,
		detail: payload.line,
		status: payload.action,
		tone: payload.action === "deny" ? "destructive" : payload.action === "ask" ? "warning" : "info",
		pinned: { units: payload.totals.units, tokens: payload.totals.tokens, cost: `$${payload.totals.costUsd.toFixed(4)}${unattributedNote}` },
	};
}
