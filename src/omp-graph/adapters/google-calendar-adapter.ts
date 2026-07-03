/**
 * google-calendar adapter — meetings (past history + UPCOMING) as omp-graph tracks.
 *
 * CLI-FIRST (faster: no in-process OAuth round-trip), API fallback:
 *   1. a calendar CLI — default `gcalcli --tsv` (override the binary via
 *      OMP_GRAPH_GOOGLE_CLI); parsed by parseGcalTsv.
 *   2. else the Calendar REST API with a token from ctx.config.google.TOKEN.
 *   3. else [] (adapter degrades; no MEETINGS group).
 *
 * Emits:
 *   - spans : each meeting (start→end) — future ones extend past the "now" line
 *   - bars  : meetings per day
 *   - bands : busy stretches (merged meeting intervals) — the "location" analog
 *
 * The pure transform + TSV parser are exported for tests; only the adapter does IO.
 */

import type { BandSegment, GraphGroup, GraphTrack, Span, TimeRange } from "../schema.ts";
import { bucketSums, DAY_MS, inRange } from "../schema.ts";
import { adapterConfig, type AdapterContext, type SourceAdapter } from "../adapter.ts";

export interface CalendarEvent {
	id?: string;
	title: string;
	start: number; // epoch ms
	end: number; // epoch ms
	allDay?: boolean;
	status?: string; // confirmed | tentative | cancelled
}

const local = (date: string, time?: string): number => Date.parse(time ? `${date} ${time}` : `${date} 00:00`);

/**
 * Parse `gcalcli --tsv` agenda output. Default columns:
 *   start_date  start_time  end_date  end_time  title...
 * All-day events have empty time columns. Defensive: skips malformed rows. Pure.
 */
export function parseGcalTsv(tsv: string): CalendarEvent[] {
	const out: CalendarEvent[] = [];
	for (const line of tsv.split("\n")) {
		if (!line.trim()) continue;
		const c = line.split("\t");
		if (c.length < 4) continue;
		const [sd, st, ed, et, ...rest] = c;
		const start = local(sd, st || undefined);
		const end = local(ed || sd, et || undefined);
		if (Number.isNaN(start) || Number.isNaN(end)) continue;
		out.push({ title: rest.join(" ").trim() || "(busy)", start, end: end > start ? end : start + 30 * 60_000, allDay: !st });
	}
	return out;
}

/** Merge overlapping meeting intervals into "busy" band segments within the range. Pure. */
export function busyBands(events: CalendarEvent[], range: TimeRange): BandSegment[] {
	const iv = events
		.map((e) => ({ t0: Math.max(range.start, e.start), t1: Math.min(range.end, e.end) }))
		.filter((e) => e.t1 > e.t0)
		.sort((a, b) => a.t0 - b.t0);
	const bands: BandSegment[] = [];
	for (const e of iv) {
		const last = bands[bands.length - 1];
		if (last && e.t0 <= last.t1) last.t1 = Math.max(last.t1, e.t1);
		else bands.push({ t0: e.t0, t1: e.t1, category: "busy" });
	}
	return bands;
}

/** Turn calendar events into omp-graph tracks. Pure. */
export function calendarTracks(events: CalendarEvent[], range: TimeRange, group: string, source: string, limit = 300): GraphTrack[] {
	const spans: Span[] = events
		.filter((e) => e.end > range.start && e.start < range.end && !e.allDay)
		.sort((a, b) => a.start - b.start)
		.slice(0, limit)
		.map((e) => ({
			t0: e.start,
			t1: e.end > e.start ? e.end : e.start + 30 * 60_000,
			label: e.title,
			status: e.status === "tentative" ? "tentative" : "busy",
			meta: { minutes: Math.round((e.end - e.start) / 60_000) },
		}));

	const meetings: GraphTrack = { id: "gcal.meetings", label: "MEETINGS", group, source, type: "spans", spans };

	const perDay: GraphTrack = {
		id: "gcal.perDay",
		label: "MEETINGS / DAY",
		group,
		source,
		unit: "meetings",
		type: "bars",
		binMs: DAY_MS,
		scale: "linear",
		bins: bucketSums(range, DAY_MS, events.filter((e) => !e.allDay && inRange(e.start, range)).map((e) => ({ t: e.start, v: 1 }))),
	};

	const busy: GraphTrack = { id: "gcal.busy", label: "BUSY", group, source, type: "bands", segments: busyBands(events, range) };

	return [meetings, perDay, busy];
}

// ── IO ────────────────────────────────────────────────────────────────────

const ymd = (t: number): string => {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** CLI path: run the configured calendar CLI (gcalcli --tsv) and parse it. null on any failure. */
async function fetchViaCli(range: TimeRange, ctx: AdapterContext): Promise<CalendarEvent[] | null> {
	const bin = adapterConfig(ctx, "google", "CLI") ?? "gcalcli";
	try {
		const proc = Bun.spawn([bin, "--nocolor", "agenda", ymd(range.start), ymd(range.end + DAY_MS), "--tsv"], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0 || !text.trim()) return null;
		return parseGcalTsv(text);
	} catch {
		return null; // binary missing / spawn blocked → fall through to API
	}
}

/** API fallback: Calendar REST with a bearer token from ctx.config.google.TOKEN. null when no token / unreachable. */
async function fetchViaApi(range: TimeRange, ctx: AdapterContext): Promise<CalendarEvent[] | null> {
	const token = adapterConfig(ctx, "google", "TOKEN");
	if (!token) return null;
	const cal = adapterConfig(ctx, "google", "CALENDAR") ?? "primary";
	const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${new Date(range.start).toISOString()}&timeMax=${new Date(range.end).toISOString()}`;
	try {
		const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
		if (!res.ok) return null;
		const data = (await res.json().catch(() => null)) as { items?: GCalApiEvent[] } | null;
		if (!data?.items) return null;
		const ms = (g?: { dateTime?: string; date?: string }): number => (g?.dateTime ? Date.parse(g.dateTime) : g?.date ? Date.parse(`${g.date}T00:00:00`) : NaN);
		return data.items
			.map((ev) => ({ id: ev.id, title: ev.summary ?? "(busy)", start: ms(ev.start), end: ms(ev.end), allDay: !!ev.start?.date, status: ev.status }))
			.filter((e) => !Number.isNaN(e.start) && !Number.isNaN(e.end));
	} catch {
		return null;
	}
}

interface GCalApiEvent {
	id?: string;
	summary?: string;
	status?: string;
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
}

const GROUP: GraphGroup = { id: "meetings", label: "MEETINGS", order: 3 };

export const googleCalendarAdapter: SourceAdapter = {
	id: "google",
	label: "Google Calendar",
	group: GROUP,
	async tracks(range, ctx: AdapterContext): Promise<GraphTrack[]> {
		const events = (await fetchViaCli(range, ctx)) ?? (await fetchViaApi(range, ctx));
		if (!events || !events.length) return [];
		return calendarTracks(events, range, GROUP.id, "google", ctx.limit ?? 300);
	},
};
