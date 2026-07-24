/**
 * Adoption counters (plans/daily-dogfood-engine/02) — casual sessions/day, prompts/day,
 * push-taps/day, each computed from data the daemon ALREADY durably writes:
 *
 *  - casual sessions: `receipts/<agentId>.jsonl` (src/receipts.ts) — `RunReceipt.startedAt` is a
 *    durable, restart-surviving per-run timestamp; casual units are the console-lane "chat" units
 *    (POST /api/console and `glance here` both create `name: "chat"`, ids `chat-*`).
 *  - prompts: `transitions.jsonl` (lifecycle-truth's CLOSED substrate) — a transition INTO
 *    `working` FROM `idle`|`input` is a turn start, i.e. a prompt. RunReceipt cannot count these:
 *  - room interactions: `channels.jsonl` / DB `channel_entries` — user-authored channel posts
 *    and manager-authored needs-you cards prove the room surface is participating in the same loop.
 *  - push taps: `push-taps.jsonl` — appended by POST /api/push-tap, which the webapp fires once
 *    when a page open arrived via a push-notification tap (the `?push=1` marker src/push.ts adds).
 *
 * The by-day functions are pure (already-loaded arrays in, `{utcDay: count}` out — unit-testable
 * without a scratch daemon); `computeAdoptionCounters` is the one I/O wrapper. Deliberately the
 * smallest honest version of each metric, not an analytics platform: counters are best-effort,
 * self-admittedly approximate, and never gate behavior.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { dedupeTransitions } from "./agent-lifecycle.ts";
import { readAllReceipts } from "./receipts.ts";
import type { RunReceipt, TransitionEntry } from "./types.ts";
import type { ChannelEntry } from "./channels.ts";

/** One push-notification tap, appended to `push-taps.jsonl` (same `JsonlLog<T>` infra as
 *  `transitions.jsonl` — see squad-manager.ts's `pushTapLog`). */
export interface PushTapEntry {
	ts: number;
	agentId: string;
}

/** `{ "YYYY-MM-DD" (UTC): count }` per metric. Sparse — days with zero activity are absent;
 *  consumers that need a dense window (the doctor summary, the weekly ledger row) fill zeros. */
export interface AdoptionCounters {
	casualSessionsByDay: Record<string, number>;
	promptsByDay: Record<string, number>;
	pushTapsByDay: Record<string, number>;
	roomInteractionsByDay: Record<string, number>;
}

export const PUSH_TAPS_FILE = "push-taps.jsonl";
const TRANSITIONS_FILE = "transitions.jsonl";

/** Casual-marking convention at count-time (arbitration §RT2-4a: read `name`/kind generically, no
 *  hard dependency on the on-ramp epic): today every casual lane — webapp console AND `glance
 *  here` — creates units named exactly "chat" (server.ts's POST /api/console handler).
 *
 * @substrate exported for tests only — tests/adoption-counters.test.ts asserts this convention
 * directly; every in-repo caller (`casualSessionsByDay`, `computeAdoptionCounters`) is a sibling
 * function in this same file. */
export function isCasualSessionName(name: string | undefined): boolean {
	return name === "chat";
}

/** Id-shaped fallback for sources that carry no `name` (transitions.jsonl): `newAgentId("chat")`
 *  (spawn-identity.ts) yields `chat-<ts36>-<seq>-<hex>`, so the prefix is the same convention the
 *  receipt names encode — this catches a LIVE chat unit whose first run hasn't finalized a receipt yet.
 *
 * @substrate exported for tests only — tests/adoption-counters.test.ts asserts this convention
 * directly; its only in-repo caller is `promptsByDay`, in this same file. */
export function isCasualAgentId(agentId: string | undefined): boolean {
	return typeof agentId === "string" && agentId.startsWith("chat-");
}

/** UTC calendar day of an epoch-ms timestamp, `YYYY-MM-DD`. UTC on purpose: a fixed, DST-free
 *  bucketing that two machines (daemon, CLI probe) can never disagree on.
 *
 * @substrate exported for tests only — tests/adoption-counters.test.ts asserts this bucketing
 * directly; every in-repo caller (`casualSessionsByDay`, `promptsByDay`, `pushTapsByDay`,
 * `roomInteractionsByDay`) is a sibling function in this same file. */
export function utcDayOf(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

const bump = (acc: Record<string, number>, day: string): void => {
	acc[day] = (acc[day] ?? 0) + 1;
};

/**
 * Distinct casual sessions per UTC day. A session = one agentId; an ACP-backed chat unit finalizes
 * one receipt PER TURN (acp-agent-driver emits agent_start/agent_end around each turn), so counting
 * receipts raw would re-derive prompts/day under the wrong name — dedupe by (agentId, day). A
 * session that spans two days counts on both: it was genuinely used on each.
 *
 * @substrate exported for tests only — tests/adoption-counters.test.ts asserts this rollup
 * directly; its only in-repo caller is `computeAdoptionCounters`, in this same file.
 */
export function casualSessionsByDay(receipts: RunReceipt[]): Record<string, number> {
	const seen = new Set<string>();
	const out: Record<string, number> = {};
	for (const r of receipts) {
		if (!isCasualSessionName(r.name)) continue;
		if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt) || r.startedAt <= 0) continue; // torn/foreign line — skip, never NaN-bucket
		const day = utcDayOf(r.startedAt);
		const key = `${r.agentId}\n${day}`;
		if (seen.has(key)) continue;
		seen.add(key);
		bump(out, day);
	}
	return out;
}

/**
 * Prompts per UTC day for casual agents: every recorded (non-denied) transition INTO `working`
 * FROM `idle`|`input` is a turn start. `casualAgentIds` is the receipt-derived name→id set;
 * `isCasualAgentId` catches live chat units with no receipt yet. Denied entries never happened —
 * excluded.
 *
 * @substrate exported for tests only — tests/adoption-counters.test.ts asserts this rollup
 * directly; its only in-repo caller is `computeAdoptionCounters`, in this same file.
 */
export function promptsByDay(transitions: TransitionEntry[], casualAgentIds?: ReadonlySet<string>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const t of transitions) {
		if (t.denied) continue;
		if (t.to !== "working" || (t.from !== "idle" && t.from !== "input")) continue;
		if (!(casualAgentIds?.has(t.agentId) || isCasualAgentId(t.agentId))) continue;
		if (typeof t.at !== "number" || !Number.isFinite(t.at) || t.at <= 0) continue;
		bump(out, utcDayOf(t.at));
	}
	return out;
}

/** Push taps per UTC day. Every entry is one tap — the webapp's sessionStorage dedupe is the
 *  double-count guard, not this function.
 *
 * @substrate exported for tests only — tests/adoption-counters.test.ts asserts this rollup
 * directly; its only in-repo caller is `computeAdoptionCounters`, in this same file. */
export function pushTapsByDay(entries: PushTapEntry[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of entries) {
		if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts <= 0) continue;
		bump(out, utcDayOf(e.ts));
	}
	return out;
}

/** Room interactions per UTC day. Counts durable room-surface activity, not passive page loads:
 *  human-authored channel posts plus manager-authored needs-you cards. Those two events are the
 *  room equivalents of "prompted" and "noticed attention", and both already live in the channel
 *  substrate, so this adds no counter store. */
export function roomInteractionsByDay(entries: ChannelEntry[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of entries) {
		const isHumanPost = e.kind === "user";
		const isNeedsYouCard = e.kind === "system" && e.event?.kind === "needs-you";
		if (!isHumanPost && !isNeedsYouCard) continue;
		if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts <= 0) continue;
		bump(out, utcDayOf(e.ts));
	}
	return out;
}

/** Sum per-day counts across managers (DB mode has one stateDir per org manager). */
export function mergeAdoptionCounters(list: AdoptionCounters[]): AdoptionCounters {
	const merged: AdoptionCounters = { casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {}, roomInteractionsByDay: {} };
	for (const c of list) {
		for (const key of ["casualSessionsByDay", "promptsByDay", "pushTapsByDay", "roomInteractionsByDay"] as const) {
			for (const [day, n] of Object.entries(c[key])) merged[key][day] = (merged[key][day] ?? 0) + n;
		}
	}
	return merged;
}

/** Structural check for a counters payload that crossed a trust boundary (the doctor probe reading
 *  GET /api/adoption from a daemon of unknown vintage) — record fields with numeric values. */
export function isAdoptionCounters(v: unknown): v is AdoptionCounters {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (["casualSessionsByDay", "promptsByDay", "pushTapsByDay"] as const).every((key) => {
		const field = o[key];
		return typeof field === "object" && field !== null && Object.values(field as Record<string, unknown>).every((n) => typeof n === "number");
	});
}

/** Fixed-window rollup for the doctor line and the weekly ledger row: today's three numbers plus
 *  the trailing-7-UTC-day sums (today inclusive). Pure — `now` injectable for tests. */
export interface AdoptionSummary {
	day: string;
	sessions: number;
	prompts: number;
	pushTaps: number;
	sessions7: number;
	prompts7: number;
	pushTaps7: number;
	roomInteractions: number;
	roomInteractions7: number;
}

export function summarizeAdoption(c: AdoptionCounters, now: number = Date.now()): AdoptionSummary {
	const days: string[] = [];
	for (let i = 0; i < 7; i++) days.push(utcDayOf(now - i * 86_400_000));
	const sum = (rec: Record<string, number>) => days.reduce((acc, d) => acc + (rec[d] ?? 0), 0);
	const today = days[0];
	return {
		day: today,
		sessions: c.casualSessionsByDay[today] ?? 0,
		prompts: c.promptsByDay[today] ?? 0,
		pushTaps: c.pushTapsByDay[today] ?? 0,
		roomInteractions: c.roomInteractionsByDay?.[today] ?? 0,
		sessions7: sum(c.casualSessionsByDay),
		prompts7: sum(c.promptsByDay),
		pushTaps7: sum(c.pushTapsByDay),
		roomInteractions7: sum(c.roomInteractionsByDay ?? {}),
	};
}

/** Torn-line-tolerant JSONL read that honors JsonlLog's `.1` rotation (rotated tail first, so the
 *  result stays roughly append-ordered). Missing files are the normal first-boot case. Each parsed
 *  line is narrowed through `isValid` before being trusted as `T` — no blind cast off `JSON.parse`,
 *  so a foreign/malformed line reads the same as a torn one (dropped, not silently mistyped). */
async function readJsonl<T>(filePath: string, isValid: (v: unknown) => v is T): Promise<T[]> {
	const out: T[] = [];
	for (const p of [`${filePath}.1`, filePath]) {
		let text: string;
		try {
			text = await fs.readFile(p, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // torn tail (crash mid-append) — drop the line, keep the rest
			}
			if (isValid(parsed)) out.push(parsed);
		}
	}
	return out;
}

/** Structural narrow for a `transitions.jsonl` line — the fields `promptsByDay`/`dedupeTransitions`
 *  actually read. Mirrors `isAdoptionCounters`'s own object+typeof style below. */
function isTransitionEntryLike(v: unknown): v is TransitionEntry {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.agentId === "string" && typeof o.from === "string" && typeof o.to === "string" && typeof o.at === "number";
}

/** Structural narrow for a `push-taps.jsonl` line — mirrors `isTransitionEntryLike` above. */
function isPushTapEntryLike(v: unknown): v is PushTapEntry {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.ts === "number" && typeof o.agentId === "string";
}

/**
 * Load the three durable sources under `stateDir` and count. `live` lets the daemon fold in its
 * own in-memory rings (JsonlLog appends are fire-and-forget, so a tap recorded milliseconds ago
 * may not have spooled yet — without this, the live-verify "tap then read GET /api/adoption"
 * round-trip races the spool). Duplicates between ring and file are dropped: transitions by their
 * `seq` uuid (dedupeTransitions), taps by (ts, agentId).
 */
export async function computeAdoptionCounters(
	stateDir: string,
	live?: { transitions?: TransitionEntry[]; pushTaps?: PushTapEntry[]; channelEntries?: ChannelEntry[] },
): Promise<AdoptionCounters> {
	const [receipts, fileTransitions, fileTaps] = await Promise.all([
		readAllReceipts(stateDir),
		readJsonl(path.join(stateDir, TRANSITIONS_FILE), isTransitionEntryLike),
		readJsonl(path.join(stateDir, PUSH_TAPS_FILE), isPushTapEntryLike),
	]);
	const transitions = dedupeTransitions([...fileTransitions, ...(live?.transitions ?? [])]);
	const tapSeen = new Set<string>();
	const taps: PushTapEntry[] = [];
	for (const t of [...fileTaps, ...(live?.pushTaps ?? [])]) {
		if (typeof t?.ts !== "number" || typeof t?.agentId !== "string") continue; // foreign/corrupt line
		const key = `${t.ts}\n${t.agentId}`;
		if (tapSeen.has(key)) continue;
		tapSeen.add(key);
		taps.push(t);
	}
	const casualIds = new Set<string>();
	for (const r of receipts) if (isCasualSessionName(r.name)) casualIds.add(r.agentId);
	const channelEntries = live?.channelEntries ?? [];
	return {
		casualSessionsByDay: casualSessionsByDay(receipts),
		promptsByDay: promptsByDay(transitions, casualIds),
		pushTapsByDay: pushTapsByDay(taps),
		roomInteractionsByDay: roomInteractionsByDay(channelEntries),
	};
}
