/**
 * derive — the "so what?" layer of omp-graph.
 *
 * Descriptive tracks say WHAT happened (commits, cost, runs, tickets). This runs
 * after compose, reads the assembled tracks + raw receipts, and computes DERIVED
 * efficiency tracks + Insight callouts that say whether it's going WELL — the
 * numbers that provoke a decision. Pure (receipts + now injected) → unit-testable.
 */

import type { Bin, GraphDoc, GraphTrack, Insight, TimeRange } from "./schema.ts";
import { bucketSums, DAY_MS, inRange } from "./schema.ts";
import type { RunReceipt } from "../types.ts";

/** Day-bucketed sum of a bars track's bins (aligned to the range). */
function daySums(doc: GraphDoc, id: string, range: TimeRange): Bin[] {
	const t = doc.tracks.find((z) => z.id === id);
	if (!t || t.type !== "bars") return bucketSums(range, DAY_MS, []);
	return bucketSums(range, DAY_MS, t.bins.map((b) => ({ t: b.t, v: b.v })));
}

/** Sum a bars track's bins by id — the true, uncapped count (marks may be capped for legibility). */
function sumBars(doc: GraphDoc, id: string): number {
	const t = doc.tracks.find((z) => z.id === id);
	return t && t.type === "bars" ? t.bins.reduce((a, b) => a + b.v, 0) : 0;
}

/** First-half vs second-half fractional change of a per-day series. */
export function halfTrend(bins: Bin[]): number | null {
	if (bins.length < 2) return null;
	const mid = Math.floor(bins.length / 2);
	const a = bins.slice(0, mid).reduce((s, b) => s + b.v, 0);
	const b = bins.slice(mid).reduce((s, x) => s + x.v, 0);
	if (a === 0) return null;
	return (b - a) / a;
}

const arrow = (t: number | null): string => (t === null ? "" : t > 0.08 ? "↑" : t < -0.08 ? "↓" : "→");
const pct = (t: number | null): string => (t === null ? "" : `${t > 0 ? "+" : ""}${Math.round(t * 100)}%`);
const fmtAge = (ms: number): string => {
	const d = Math.floor(ms / DAY_MS);
	const h = Math.floor((ms % DAY_MS) / 3_600_000);
	return d > 0 ? `${d}d ${h}h` : `${h}h`;
};

export function derive(doc: GraphDoc, receipts: RunReceipt[], range: TimeRange, now: number): { tracks: GraphTrack[]; insights: Insight[] } {
	const inWin = receipts.filter((r) => inRange(r.endedAt ?? r.startedAt, range));

	const totalCost = inWin.reduce((a, r) => a + (r.costUsd ?? 0), 0);
	const costByDay = bucketSums(range, DAY_MS, inWin.map((r) => ({ t: r.endedAt ?? r.startedAt, v: r.costUsd ?? 0 })));
	const commitsByDay = daySums(doc, "git.commits", range);
	const totalCommits = commitsByDay.reduce((a, b) => a + b.v, 0);
	// true closed count from the uncapped daily bars — plane.closed MARKS cap at `limit`
	// for legibility, so counting them understated cost/ticket once past the cap.
	const ticketsClosed = sumBars(doc, "plane.closedPerDay");

	// token cache-hit rate — context reuse, the cheapest cost lever
	const cacheRead = inWin.reduce((a, r) => a + (r.tokens?.cacheRead ?? 0), 0);
	const inputTok = inWin.reduce((a, r) => a + (r.tokens?.input ?? 0), 0);
	const cacheWrite = inWin.reduce((a, r) => a + (r.tokens?.cacheWrite ?? 0), 0);
	// reuse = cached-read ÷ ALL input-side tokens (fresh input + cache read + cache write);
	// omitting cacheWrite overstated the hit rate on cache-heavy cold-start runs.
	const cacheDenom = cacheRead + inputTok + cacheWrite;
	const cacheHit = cacheDenom > 0 ? cacheRead / cacheDenom : 0;

	// idle burn — spend on runs that produced no files
	const idleRuns = inWin.filter((r) => (r.filesTouched?.length ?? 0) === 0);
	const idleCost = idleRuns.reduce((a, r) => a + (r.costUsd ?? 0), 0);
	const idlePct = totalCost > 0 ? idleCost / totalCost : 0;
	const idleByDay = bucketSums(range, DAY_MS, idleRuns.map((r) => ({ t: r.endedAt ?? r.startedAt, v: r.costUsd ?? 0 })));

	// flow metrics from plane issues: oldest in-flight, WIP, cycle time
	let oldest: { name: string; ms: number } | null = null;
	let wip = 0;
	let cycleSum = 0;
	let cycleN = 0;
	const issues = doc.tracks.find((z) => z.id === "plane.issues");
	if (issues && issues.type === "spans") {
		for (const sp of issues.spans) {
			if (sp.status === "completed") {
				cycleSum += sp.t1 - sp.t0;
				cycleN += 1;
			} else if (sp.t1 >= range.end - DAY_MS) {
				wip += 1;
				const age = now - sp.t0;
				if (!oldest || age > oldest.ms) oldest = { name: sp.label, ms: age };
			}
		}
	}
	// Only ELAPSED time counts for rates/trends: a future window (upcoming meetings /
	// renewals) must not dilute velocity or fake a "↓" trend from its empty trailing
	// days. Clamp the denominator + trim future-day bins before the half-over-half.
	const elapsedEnd = Math.min(range.end, now);
	const elapsedDays = Math.max(1, Math.round((elapsedEnd - range.start) / DAY_MS));
	const elapsed = (bins: Bin[]): Bin[] => bins.filter((b) => b.t < elapsedEnd);
	const commitsPerDay = totalCommits / elapsedDays;
	const velTrend = halfTrend(elapsed(commitsByDay));

	// ── derived tracks ──
	const tracks: GraphTrack[] = [];
	const cpcPoints = costByDay
		.map((c, i) => ({ t: c.t, v: (commitsByDay[i]?.v ?? 0) > 0 ? c.v / (commitsByDay[i]?.v ?? 1) : 0 }))
		.filter((p) => p.v > 0);
	if (cpcPoints.length) tracks.push({ id: "derived.costPerCommit", label: "$ / COMMIT", group: "efficiency", source: "derived", unit: "$", type: "series", scale: "sqrt", points: cpcPoints });
	if (idleByDay.some((b) => b.v > 0)) tracks.push({ id: "derived.idleBurn", label: "IDLE $ / DAY", group: "efficiency", source: "derived", unit: "$", type: "bars", binMs: DAY_MS, scale: "linear", bins: idleByDay });

	// ── insight callouts ──
	const costTrend = halfTrend(elapsed(costByDay));
	const insights: Insight[] = [
		{
			id: "cpt",
			label: "cost / shipped ticket",
			value: ticketsClosed > 0 ? `$${(totalCost / ticketsClosed).toFixed(0)}` : "—",
			sub: `${ticketsClosed} shipped`,
			tone: ticketsClosed === 0 ? "neutral" : totalCost / ticketsClosed > 50 ? "warn" : "good",
		},
		{
			id: "idle",
			label: "idle burn",
			value: `${Math.round(idlePct * 100)}%`,
			sub: `$${idleCost.toFixed(0)} · 0 output`,
			tone: idlePct > 0.4 ? "bad" : idlePct > 0.2 ? "warn" : "good",
		},
		{
			id: "cache",
			label: "cache hit",
			value: `${Math.round(cacheHit * 100)}%`,
			sub: "token reuse",
			tone: cacheHit > 0.7 ? "good" : cacheHit > 0.4 ? "warn" : "bad",
		},
		{
			id: "cpc",
			label: "cost / commit",
			value: totalCommits > 0 ? `$${(totalCost / totalCommits).toFixed(1)}` : "—",
			sub: `${arrow(costTrend)} ${pct(costTrend)} spend`.trim(),
			tone: "neutral",
		},
	];
	insights.push({
		id: "velocity",
		label: "velocity",
		value: `${commitsPerDay.toFixed(1)}/d`,
		sub: `${arrow(velTrend)} ${pct(velTrend)} commits`.trim(),
		tone: "neutral",
	});
	if (issues && issues.type === "spans" && (cycleN > 0 || wip > 0)) {
		insights.push({
			id: "cycle",
			label: "cycle time",
			value: cycleN > 0 ? fmtAge(cycleSum / cycleN) : "—",
			sub: `${cycleN} closed`,
			tone: cycleN > 0 && cycleSum / cycleN > 3 * DAY_MS ? "warn" : "neutral",
		});
		insights.push({ id: "wip", label: "work in flight", value: `${wip}`, sub: "open tickets", tone: wip > 10 ? "warn" : "neutral" });
	}
	if (oldest) insights.push({ id: "oldest", label: "oldest in-flight", value: fmtAge(oldest.ms), sub: oldest.name, tone: oldest.ms > 3 * DAY_MS ? "warn" : "neutral" });

	return { tracks, insights };
}
