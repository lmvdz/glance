/**
 * crm adapter — relationship touches (Telegram/CRM) as omp-graph tracks.
 *
 * Respects the source system's ADR-001 boundary: it consumes DERIVED, body-free
 * touch summaries (the `{peer, at, direction, summary}` records the inkwell/
 * marketing local-extractor `push`es), NEVER raw DM bodies. FILE/CLI-FIRST (fast,
 * and the derived-push output is a natural JSONL feed), API fallback:
 *   1. OMP_GRAPH_CRM_FILE  — a JSONL/JSON file of touches (local-extractor output)
 *   2. OMP_GRAPH_CRM_CLI   — a command emitting the same
 *   3. OMP_GRAPH_CRM_URL   — intel-board's GET /api/intel/feed?platform=&since=
 *   4. else []
 *
 * Emits:
 *   - bars   : touches per day (the relationship pulse)
 *   - events : notable touches (in/out, with the body-free summary)
 *   - spans  : per-contact conversation windows (first→last touch in range)
 *
 * The tolerant parser + pure transform are exported for tests; only the adapter
 * does IO. Tolerant by design: DerivedInteraction, Interaction, and a native
 * CrmTouch all map through toTouch().
 */

import type { GraphGroup, GraphTrack, Span, TimeRange } from "../schema.ts";
import { bucketSums, DAY_MS, inRange } from "../schema.ts";
import { adapterConfig, type AdapterContext, type SourceAdapter } from "../adapter.ts";

export interface CrmTouch {
	contact: string;
	at: number; // epoch ms
	direction?: "in" | "out";
	channel?: string;
	summary?: string;
	sentiment?: string;
}

const asMs = (v: unknown): number | undefined => {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const t = Date.parse(v);
		return Number.isNaN(t) ? undefined : t;
	}
	return undefined;
};

/** Map any touch-ish record (DerivedInteraction | Interaction | CrmTouch | intel item) → CrmTouch. Pure, tolerant. */
export function toTouch(raw: unknown): CrmTouch | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const at = asMs(r.at ?? r.createdAt ?? r.ts ?? r.timestamp);
	if (at === undefined) return null;
	const ref = r.ref as Record<string, unknown> | undefined;
	const contact = r.contact ?? r.peerUsername ?? r.peerExternalId ?? r.realName ?? r.contactId ?? ref?.realName ?? r.refId ?? "unknown";
	const dir = String(r.direction ?? "").toLowerCase();
	const direction = dir.startsWith("in") ? "in" : dir.startsWith("out") ? "out" : undefined;
	return {
		contact: String(contact),
		at,
		direction,
		channel: typeof r.channel === "string" ? r.channel : typeof r.platform === "string" ? r.platform : undefined,
		summary: typeof r.summary === "string" ? r.summary : undefined,
		sentiment: typeof r.sentiment === "string" ? r.sentiment : undefined,
	};
}

/** Parse a JSON array OR JSONL of touch-ish records into CrmTouch[]. Pure. */
export function parseTouches(text: string): CrmTouch[] {
	const t = text.trim();
	if (!t) return [];
	if (t.startsWith("[")) {
		try {
			const arr = JSON.parse(t) as unknown[];
			return arr.map(toTouch).filter((x): x is CrmTouch => x !== null);
		} catch {
			return [];
		}
	}
	const out: CrmTouch[] = [];
	for (const line of t.split("\n")) {
		if (!line.trim()) continue;
		try {
			const touch = toTouch(JSON.parse(line));
			if (touch) out.push(touch);
		} catch {
			// tolerate a torn line
		}
	}
	return out;
}

const arrow = (d?: "in" | "out"): string => (d === "in" ? "←" : d === "out" ? "→" : "·");

/** Turn touches into omp-graph tracks. Pure. */
export function crmTracks(touches: CrmTouch[], range: TimeRange, group: string, source: string, limit = 200): GraphTrack[] {
	const inWin = touches.filter((t) => inRange(t.at, range));

	const perDay: GraphTrack = {
		id: "crm.touches",
		label: "TOUCHES / DAY",
		group,
		source,
		unit: "touches",
		type: "bars",
		binMs: DAY_MS,
		scale: "linear",
		bins: bucketSums(range, DAY_MS, inWin.map((t) => ({ t: t.at, v: 1 }))),
	};

	const events: GraphTrack = {
		id: "crm.events",
		label: "TOUCHES",
		group,
		source,
		type: "events",
		marks: inWin
			.slice()
			.sort((a, b) => b.at - a.at)
			.slice(0, limit)
			.sort((a, b) => a.at - b.at)
			.map((t) => ({
				t: t.at,
				label: `${arrow(t.direction)} ${t.contact}${t.summary ? ": " + t.summary : ""}`.slice(0, 72),
				kind: t.direction ?? "in",
				meta: { contact: t.contact, ...(t.channel ? { channel: t.channel } : {}), ...(t.sentiment ? { sentiment: t.sentiment } : {}) },
			})),
	};

	// per-contact conversation window (first→last touch in range)
	const byContact = new Map<string, { t0: number; t1: number; n: number; out: number }>();
	for (const t of inWin) {
		const c = byContact.get(t.contact) ?? { t0: t.at, t1: t.at, n: 0, out: 0 };
		c.t0 = Math.min(c.t0, t.at);
		c.t1 = Math.max(c.t1, t.at);
		c.n += 1;
		if (t.direction === "out") c.out += 1;
		byContact.set(t.contact, c);
	}
	const spans: Span[] = [...byContact.entries()]
		.sort((a, b) => a[1].t0 - b[1].t0)
		.slice(0, limit)
		.map(([contact, c]) => ({
			t0: c.t0,
			t1: c.t1 > c.t0 ? c.t1 : c.t0 + 30 * 60_000,
			label: contact,
			status: c.out > c.n - c.out ? "out" : c.out === 0 ? "in" : "mixed",
			value: c.n,
			meta: { touches: c.n },
		}));
	const relationships: GraphTrack = { id: "crm.contacts", label: "CONTACTS", group, source, type: "spans", spans };

	return [perDay, events, relationships];
}

// ── IO ──────────────────────────────────────────────────────────────────────

async function fetchViaFile(ctx: AdapterContext): Promise<CrmTouch[] | null> {
	const file = adapterConfig(ctx, "crm", "FILE");
	if (!file) return null;
	const text = await Bun.file(file).text().catch(() => "");
	return text.trim() ? parseTouches(text) : [];
}

async function fetchViaCli(ctx: AdapterContext): Promise<CrmTouch[] | null> {
	const cmd = adapterConfig(ctx, "crm", "CLI");
	if (!cmd) return null;
	try {
		const proc = Bun.spawn(cmd.split(" ").filter(Boolean), { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return code === 0 ? parseTouches(text) : null;
	} catch {
		return null;
	}
}

async function fetchViaApi(range: TimeRange, ctx: AdapterContext): Promise<CrmTouch[] | null> {
	const base = adapterConfig(ctx, "crm", "URL");
	if (!base) return null;
	const token = adapterConfig(ctx, "crm", "TOKEN");
	const platform = adapterConfig(ctx, "crm", "PLATFORM") ?? "telegram";
	const url = `${base.replace(/\/$/, "")}/api/intel/feed?platform=${encodeURIComponent(platform)}&since=${new Date(range.start).toISOString()}&limit=250`;
	try {
		const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
		if (!res.ok) return null;
		const body = (await res.json().catch(() => null)) as { data?: { items?: unknown[] } } | null;
		const items = body?.data?.items ?? [];
		return items.map(toTouch).filter((x): x is CrmTouch => x !== null);
	} catch {
		return null;
	}
}

const GROUP: GraphGroup = { id: "crm", label: "CRM", order: 4 };

export const crmAdapter: SourceAdapter = {
	id: "crm",
	label: "CRM",
	group: GROUP,
	async tracks(range, ctx: AdapterContext): Promise<GraphTrack[]> {
		const touches = (await fetchViaFile(ctx)) ?? (await fetchViaCli(ctx)) ?? (await fetchViaApi(range, ctx));
		if (!touches || !touches.length) return [];
		return crmTracks(touches, range, GROUP.id, "crm", ctx.limit ?? 200);
	},
};
