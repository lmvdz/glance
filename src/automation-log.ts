/**
 * Automation activity log — the observability spine for the daemon's background loops
 * (Scout, Observer, Opportunity, Dispatcher). Until this, those loops were invisible:
 * the audit log records only operator-initiated mutations, and the loops' own progress
 * went to stdout (ephemeral). So nobody could answer "what is running in the background,
 * how often is it firing, and what is it costing me?" — exactly the gap behind a burst of
 * Scout LLM calls appearing with no way to see why.
 *
 * Each loop emits one structured AutomationEvent per unit of work (Scout: per reasoning
 * scan = one LLM call; the others: per tick). Mirrors audit.ts: an in-memory ring powers
 * the live feed + rollups, and MEANINGFUL events (work done or an error) additionally spool
 * to <stateDir>/automation.jsonl so the costly/notable history survives a restart — while a
 * no-op heartbeat tick stays in the ring only, so the disk doesn't grow a line every 60s
 * forever. Bun/Node stdlib only, no sqlite, no dependency.
 *
 * ponytail: meaningful events spool append-only (no rotation); heartbeats live only in the
 * ring (lost on restart, which is fine — liveness is a live concept). Ceiling: a very
 * long-lived daemon's spool grows unbounded and reads go linear. Upgrade path: rotate the
 * spool, or fold into the sqlite schema, only if retention becomes a real need.
 */

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AutomationEvent, AutomationLoop } from "./types.ts";

export type { AutomationEvent, AutomationLoop } from "./types.ts";

/** What a loop hands the recorder: everything but the fields the recorder stamps (id/at) and binds (loop/repo). */
export type AutomationReport = Omit<AutomationEvent, "id" | "at" | "loop" | "repo">;

/** A loop's bound recorder callback — the manager curries in the loop name + repo. */
export type AutomationRecorder = (report: AutomationReport) => void;

const RING_MAX = 2000;

export function automationPath(baseDir: string): string {
	return path.join(baseDir, "automation.jsonl");
}

// Monotonic id even when several events resolve in the same millisecond — the id is the stable sort +
// dedupe key, so it must strictly increase per process. Module-level (mirrors audit.ts): several managers
// in DB mode share it, which is fine — ids stay globally unique and ordered.
let lastId = 0;
function nextId(now: number): number {
	lastId = now > lastId ? now : lastId + 1;
	return lastId;
}

/** A unit "did something" (or errored) — worth persisting. A pure heartbeat (all-zero, info) is not. */
export function isMeaningful(e: Pick<AutomationEvent, "llmCalls" | "filed" | "found" | "spawned" | "level">): boolean {
	return (e.llmCalls ?? 0) > 0 || (e.filed ?? 0) > 0 || (e.found ?? 0) > 0 || (e.spawned ?? 0) > 0 || e.level === "warn" || e.level === "error";
}

/** Per-loop aggregate over a window — the at-a-glance "what's running and what it cost" view. */
export interface AutomationRollupRow {
	loop: AutomationLoop;
	/** Emitted units in the window (Scout: scans; others: ticks). */
	events: number;
	llmCalls: number;
	found: number;
	filed: number;
	spawned: number;
	errors: number;
	/** Most-recent activity ts in the window — 0 if the loop was silent (lets the UI flag a stalled loop). */
	lastAt: number;
}

export interface AutomationQuery {
	loop?: AutomationLoop;
	/** Only events at-or-newer than now - sinceMs. */
	sinceMs?: number;
	/** Max events returned (newest first). Default 200; <=0 ⇒ no cap. */
	limit?: number;
	/** Drop heartbeats — return only events that did work or errored. */
	meaningfulOnly?: boolean;
}

export class AutomationLog {
	private readonly baseDir: string;
	private readonly ring: AutomationEvent[] = [];
	private readonly max: number;
	private readonly onEvent?: (e: AutomationEvent) => void;
	/** Where failures (spool/hydrate) surface. Defaults to console.warn so a silently-failing spool is at
	 *  least visible; the manager can inject its own structured logger. */
	private readonly log: (msg: string) => void;
	/** Spool failures are logged once per error episode (not per event) so a wedged disk doesn't flood. */
	private spoolFailing = false;

	constructor(baseDir: string, opts: { max?: number; onEvent?: (e: AutomationEvent) => void; log?: (msg: string) => void } = {}) {
		this.baseDir = baseDir;
		this.max = opts.max ?? RING_MAX;
		this.onEvent = opts.onEvent;
		this.log = opts.log ?? ((m) => console.warn(`[automation-log] ${m}`));
		this.hydrate();
	}

	/** Bind a recorder for one loop — the manager curries the loop name + (optional) repo so loop code
	 *  only reports its metrics. The returned fn is a no-op-safe sink (catches its own errors). */
	for(loop: AutomationLoop, repo?: string): AutomationRecorder {
		return (report: AutomationReport) => {
			try {
				this.record({ ...report, loop, repo });
			} catch (err) {
				// Recording must never break the loop it observes — but a swallowed recorder error means the
				// loop's activity went unrecorded, so surface it (non-fatally) instead of dropping it silently.
				this.log(`failed to record ${loop} event (loop continues): ${err instanceof Error ? err.message : String(err)}`);
			}
		};
	}

	/** Stamp + ring + (if meaningful) spool one event. Returns the stamped event. */
	record(input: Omit<AutomationEvent, "id" | "at"> & { at?: number }, now = Date.now()): AutomationEvent {
		const e: AutomationEvent = { ...input, id: nextId(now), at: input.at ?? now };
		this.ring.push(e);
		if (this.ring.length > this.max) this.ring.shift();
		this.onEvent?.(e);
		if (isMeaningful(e)) void this.spool(e);
		return e;
	}

	private async spool(e: AutomationEvent): Promise<void> {
		try {
			const file = automationPath(this.baseDir);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.appendFile(file, `${JSON.stringify(e)}\n`);
			if (this.spoolFailing) {
				this.spoolFailing = false;
				this.log("automation spool recovered — meaningful events are persisting again");
			}
		} catch (err) {
			// Best-effort persistence — the ring still has it for the live feed — but a silently-failing spool
			// means the meaningful/costly history is being LOST on restart, which the operator must know about.
			// Surface it once per failure episode (not per event) so a wedged disk doesn't flood the log.
			if (!this.spoolFailing) {
				this.spoolFailing = true;
				this.log(`automation spool failed (meaningful events are NOT persisting): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/** Seed the ring from the tail of the spool so a restart still shows recent meaningful history. */
	private hydrate(): void {
		let text: string;
		try {
			text = readFileSync(automationPath(this.baseDir), "utf8");
		} catch (err) {
			// A missing spool is the normal first-boot case; any OTHER read error (permissions, I/O) means the
			// persisted history exists but couldn't be loaded — surface it rather than silently starting empty.
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.log(`automation spool unreadable on hydrate — starting with empty history: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const lines = text.split("\n").filter((l) => l.trim());
		for (const line of lines.slice(-this.max)) {
			try {
				const e = JSON.parse(line) as AutomationEvent;
				this.ring.push(e);
				if (typeof e.id === "number" && e.id > lastId) lastId = e.id;
			} catch {
				/* skip a torn line */
			}
		}
	}

	/** Recent events, newest first, with optional loop/window/limit filters. */
	recent(q: AutomationQuery = {}, now = Date.now()): AutomationEvent[] {
		const cutoff = q.sinceMs ? now - q.sinceMs : 0;
		const out = this.ring
			.filter((e) => (!q.loop || e.loop === q.loop) && e.at >= cutoff && (!q.meaningfulOnly || isMeaningful(e)))
			.slice()
			.reverse();
		const limit = q.limit ?? 200;
		return limit > 0 ? out.slice(0, limit) : out;
	}

	/** Per-loop aggregates over the trailing window (default 1h) — the dashboard's summary cards. */
	rollup(windowMs = 3_600_000, now = Date.now()): AutomationRollupRow[] {
		const cutoff = now - windowMs;
		const rows = new Map<AutomationLoop, AutomationRollupRow>();
		const ensure = (loop: AutomationLoop): AutomationRollupRow => {
			let r = rows.get(loop);
			if (!r) {
				r = { loop, events: 0, llmCalls: 0, found: 0, filed: 0, spawned: 0, errors: 0, lastAt: 0 };
				rows.set(loop, r);
			}
			return r;
		};
		for (const e of this.ring) {
			if (e.at < cutoff) continue;
			const r = ensure(e.loop);
			r.events++;
			r.llmCalls += e.llmCalls ?? 0;
			r.found += e.found ?? 0;
			r.filed += e.filed ?? 0;
			r.spawned += e.spawned ?? 0;
			if (e.level === "warn" || e.level === "error") r.errors++;
			if (e.at > r.lastAt) r.lastAt = e.at;
		}
		return [...rows.values()].sort((a, b) => a.loop.localeCompare(b.loop));
	}
}
