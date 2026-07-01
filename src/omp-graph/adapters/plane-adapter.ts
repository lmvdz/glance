/**
 * plane adapter — the delivery timeline (Plane issues) as omp-graph tracks.
 *
 * The first NON-git/receipts source, proving the "add one file → new lane" claim
 * with an existing internal integration (src/plane.ts, no new secrets). Emits:
 *   - events : issues closed (the delivery milestones)
 *   - bars   : issues closed per day
 *   - spans  : issue lifetimes (created → completed|now), i.e. work in flight
 *
 * Pure transform exported for tests; only the adapter hits Plane (and degrades
 * to [] when Plane isn't configured/reachable).
 */

import type { GraphGroup, GraphTrack, TimeRange, Span } from "../schema.ts";
import { bucketSums, DAY_MS, inRange } from "../schema.ts";
import type { AdapterContext, SourceAdapter } from "../adapter.ts";
import { listPlaneIssuesRaw, planeConfigured, type PlaneIssueTemporal } from "../../plane.ts";

/** Turn Plane issues into omp-graph tracks. Pure. */
export function planeTracks(issues: PlaneIssueTemporal[], range: TimeRange, group: string, source: string, limit = 200): GraphTrack[] {
	const completed = issues.filter((i): i is PlaneIssueTemporal & { completedAt: number } => i.completedAt != null && inRange(i.completedAt, range));

	const events: GraphTrack = {
		id: "plane.closed",
		label: "CLOSED",
		group,
		source,
		type: "events",
		marks: completed
			.slice()
			.sort((a, b) => b.completedAt - a.completedAt)
			.slice(0, limit)
			.sort((a, b) => a.completedAt - b.completedAt)
			.map((i) => ({
				t: i.completedAt,
				label: `✓ ${i.identifier ? i.identifier + " " : ""}${i.name}`.slice(0, 72),
				kind: "done",
				meta: { ...(i.identifier ? { id: i.identifier } : {}), state: i.state ?? "" },
			})),
	};

	const closedBars: GraphTrack = {
		id: "plane.closedPerDay",
		label: "CLOSED / DAY",
		group,
		source,
		unit: "issues",
		type: "bars",
		binMs: DAY_MS,
		scale: "linear",
		bins: bucketSums(range, DAY_MS, completed.map((i) => ({ t: i.completedAt, v: 1 }))),
	};

	const spans: Span[] = issues
		.filter((i) => i.createdAt != null && (i.completedAt ?? range.end) > range.start && i.createdAt < range.end)
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
		.slice(0, limit)
		.map((i) => ({
			t0: i.createdAt as number,
			t1: i.completedAt ?? range.end,
			label: i.identifier ?? i.name,
			status: i.state,
			meta: { ...(i.identifier ? { id: i.identifier } : {}), name: i.name.slice(0, 60) },
		}));

	const wip: GraphTrack = { id: "plane.issues", label: "ISSUES", group, source, type: "spans", spans };

	return [events, closedBars, wip];
}

const GROUP: GraphGroup = { id: "delivery", label: "DELIVERY", order: 2 };

export const planeAdapter: SourceAdapter = {
	id: "plane",
	label: "Plane",
	group: GROUP,
	async tracks(range, ctx: AdapterContext): Promise<GraphTrack[]> {
		if (!ctx.repo || !planeConfigured()) return [];
		const issues = await listPlaneIssuesRaw(ctx.repo);
		if (!issues || !issues.length) return [];
		return planeTracks(issues, range, GROUP.id, "plane", ctx.limit ?? 200);
	},
};
