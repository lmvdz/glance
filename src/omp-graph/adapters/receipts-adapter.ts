/**
 * receipts adapter — the fleet's run history (cost, sessions, busy/idle) as tracks.
 *
 * Emits the three primitives git doesn't:
 *   - series : $ spend per hour (the fleet's "heartbeat")
 *   - spans  : every agent run, start→end, colored by status
 *   - bands  : fleet active vs idle stretches (coalesced busy hours)
 *
 * Uses the FULL receipt history (readAllReceipts) rather than only live agents,
 * so the dossier reflects the whole window even after agents are pruned. The
 * transform is pure and exported for tests; only the adapter does IO.
 */

import type { GraphGroup, GraphTrack, SeriesPoint, Span, BandSegment, TimeRange } from "../schema.ts";
import { bucketSums, HOUR_MS, inRange } from "../schema.ts";
import type { AdapterContext, SourceAdapter } from "../adapter.ts";
import type { RunReceipt } from "../../types.ts";
import { readAllReceipts } from "../../receipts.ts";

/** Coalesce a per-hour active flag into contiguous "active" band segments. Pure. */
export function coalesceActive(active: boolean[], range: TimeRange, binMs: number): BandSegment[] {
	const segments: BandSegment[] = [];
	let runStart = -1;
	for (let i = 0; i <= active.length; i++) {
		const on = i < active.length && active[i];
		if (on && runStart === -1) runStart = i;
		else if (!on && runStart !== -1) {
			segments.push({ t0: range.start + runStart * binMs, t1: range.start + i * binMs, category: "active" });
			runStart = -1;
		}
	}
	return segments;
}

/** Turn receipts into omp-graph tracks. Pure. */
export function receiptTracks(receipts: RunReceipt[], range: TimeRange, group: string, source: string, limit = 400): GraphTrack[] {
	// cost/hr: sum costUsd into hourly bins at the run's end time.
	const costPoints: SeriesPoint[] = bucketSums(
		range,
		HOUR_MS,
		receipts.map((r) => ({ t: r.endedAt ?? r.startedAt, v: r.costUsd ?? 0 })),
	).map((b) => ({ t: b.t, v: b.v }));

	const cost: GraphTrack = {
		id: "receipts.cost",
		label: "COST / HR",
		group,
		source,
		unit: "$",
		type: "series",
		scale: "sqrt",
		points: costPoints,
	};

	// spans: each run that overlaps the window, newest-first cap.
	const spans: Span[] = receipts
		.filter((r) => r.startedAt && r.endedAt && r.endedAt > range.start && r.startedAt < range.end)
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
		.slice(0, limit)
		.map((r) => ({
			t0: r.startedAt,
			t1: r.endedAt as number,
			label: r.name,
			status: r.status,
			value: r.costUsd ?? 0,
			meta: { files: r.filesTouched?.length ?? 0, tokens: r.tokens?.total ?? 0, toolCalls: r.toolCalls ?? 0 },
		}))
		.sort((a, b) => a.t0 - b.t0);

	const sessions: GraphTrack = {
		id: "receipts.sessions",
		label: "SESSIONS",
		group,
		source,
		type: "spans",
		spans,
	};

	// bands: mark each hour the fleet had a run in flight, then coalesce.
	const span = Math.max(0, range.end - range.start);
	const n = Math.max(1, Math.ceil(span / HOUR_MS));
	const active = new Array<boolean>(n).fill(false);
	for (const r of receipts) {
		if (!r.startedAt || !r.endedAt) continue;
		const from = Math.max(range.start, r.startedAt);
		const to = Math.min(range.end, r.endedAt);
		if (to <= from) continue;
		const i0 = Math.floor((from - range.start) / HOUR_MS);
		const i1 = Math.min(n - 1, Math.floor((to - range.start) / HOUR_MS));
		for (let i = i0; i <= i1; i++) if (i >= 0) active[i] = true;
	}
	const state: GraphTrack = {
		id: "receipts.state",
		label: "FLEET STATE",
		group,
		source,
		type: "bands",
		segments: coalesceActive(active, range, HOUR_MS),
	};

	return [cost, sessions, state];
}

const GROUP: GraphGroup = { id: "fleet", label: "FLEET ACTIVITY", order: 0 };

export const receiptsAdapter: SourceAdapter = {
	id: "receipts",
	label: "Receipts",
	group: GROUP,
	async tracks(range, ctx: AdapterContext): Promise<GraphTrack[]> {
		const receipts = ctx.stateDir ? await readAllReceipts(ctx.stateDir) : [];
		if (!receipts.length) return [];
		const inWindow = receipts.filter((r) => inRange(r.endedAt ?? r.startedAt, range) || (r.startedAt < range.end && (r.endedAt ?? r.startedAt) > range.start));
		if (!inWindow.length) return [];
		return receiptTracks(inWindow, range, GROUP.id, "receipts", ctx.limit ?? 400);
	},
};
