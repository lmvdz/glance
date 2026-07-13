/**
 * Learning-loop metrics + flag scaffolding (agentic-learning-loop concern 01).
 *
 * The baseline the rest of the learning loop is measured against — without this, "the loop
 * helps" is unfalsifiable. Mirrors automation-log.ts's shape (an in-memory ring for live
 * rollups + an append-only spool so history survives a restart) rather than inventing a new
 * persistence pattern. Bun/Node stdlib only, no sqlite, no dependency.
 *
 * Five metrics, all derived from signals that already exist elsewhere in the codebase:
 *   - first-try-green rate  — verify passed with zero fixup visits (workflow engine).
 *   - fixups-to-green       — fixup visits consumed before verify passed.
 *   - escalation rate       — the run reached the `escalate` node.
 *   - land-failure-streak   — how often observer.ts's ≥N land-failure finding fires.
 *   - primer-empty rate     — buildContextPrimer returned "" at a cold-start call site.
 *   - primer-undelivered    — a primer was built for a harness that cannot receive one.
 *
 * Flag pattern (reused by concerns 03/04/05/06/07): `learningFlags()` resolves each
 * `OMP_SQUAD_*` flag to "on"/"off", defaulting OFF. `=ab` hashes a caller-supplied id (agent
 * or branch) to a STABLE 50/50 variant, so half the fleet can run each arm for a fair A/B
 * comparison without flapping the same id between runs.
 */

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── flags ─────────────────────────────────────────────────────────────────────────────────

export type Variant = "on" | "off";

export interface LearningFlags {
	reflexion: Variant;
	rewardBoost: Variant;
	failureMemory: Variant;
	modelOutcomes: Variant;
	thresholdTuner: Variant;
	decisionCapture: Variant;
}

const FLAG_ENV: Record<keyof LearningFlags, string> = {
	reflexion: "OMP_SQUAD_REFLEXION",
	rewardBoost: "OMP_SQUAD_REWARD_BOOST",
	failureMemory: "OMP_SQUAD_FAILURE_MEMORY",
	modelOutcomes: "OMP_SQUAD_MODEL_OUTCOMES",
	thresholdTuner: "OMP_SQUAD_THRESHOLD_TUNER",
	decisionCapture: "OMP_SQUAD_DECISION_CAPTURE",
};

/** FNV-1a-style stable hash, used ONLY to pick a deterministic 50/50 A/B variant per id — never
 *  for anything security-sensitive. Same id always resolves to the same arm within one flag. */
function stableHash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** A stable on/off split for `id` under `envVar` — decorrelated per flag (the hash seeds on
 *  `envVar:id`) so one id isn't pinned to the same arm across every flag simultaneously. */
export function stableVariant(envVar: string, id: string): Variant {
	return stableHash(`${envVar}:${id}`) % 2 === 0 ? "on" : "off";
}

function resolveVariant(envVar: string, id: string): Variant {
	const raw = process.env[envVar];
	if (raw === "1") return "on";
	if (raw === "ab") return stableVariant(envVar, id);
	return "off"; // unset or any other value ⇒ off (safe default)
}

/** Resolve every learning-loop flag at once. `id` (agent or branch id) is only consulted for
 *  flags set to `=ab`; omit it for a global (non-A/B) read. Read fresh every call (never
 *  cached) so tests/ops can flip env vars per-case, matching autodrive()/landFailCap() etc. */
export function learningFlags(id = ""): LearningFlags {
	return {
		reflexion: resolveVariant(FLAG_ENV.reflexion, id),
		rewardBoost: resolveVariant(FLAG_ENV.rewardBoost, id),
		failureMemory: resolveVariant(FLAG_ENV.failureMemory, id),
		modelOutcomes: resolveVariant(FLAG_ENV.modelOutcomes, id),
		thresholdTuner: resolveVariant(FLAG_ENV.thresholdTuner, id),
		decisionCapture: resolveVariant(FLAG_ENV.decisionCapture, id),
	};
}

export function isOn(v: Variant): boolean {
	return v === "on";
}

// ── metrics ───────────────────────────────────────────────────────────────────────────────

export type MetricName =
	| "first-try-green"
	| "fixups-to-green"
	| "escalation"
	| "land-failure-streak"
	| "primer-empty"
	/** A primer was built, but the chosen harness has no channel to deliver it (ACP without
	 *  OMP_SQUAD_ACP_CONTEXT=prompt). Recorded OUTSIDE the branch it measures. */
	| "primer-undelivered"
	| "model-outcome-recorded"
	| "model-outcome-blocked"
	| "veto-reprompt"
	| "decision-captured"
	| "model-route-decision";

export interface MetricEvent {
	/** Strictly-increasing id (epoch millis, bumped on collision) — stable sort + dedupe key. */
	id: number;
	/** Epoch millis the metric was recorded. */
	at: number;
	name: MetricName;
	value: number;
	/** `{flag, variant}` for A/B attribution, e.g. `{flag: "reflexion", variant: "on"}`. */
	tags?: Record<string, string>;
}

const RING_MAX = 5000;

export function metricsPath(baseDir: string): string {
	return path.join(baseDir, "learning-metrics.jsonl");
}

/** `first-try-green` derivation: proof passed AND zero fixup visits were consumed. Exported so
 *  both the recording site and tests share one definition. */
export function isFirstTryGreen(proofOk: boolean, fixupVisits: number): boolean {
	return proofOk && fixupVisits === 0;
}

export interface MetricRollupRow {
	name: MetricName;
	count: number;
	sum: number;
	avg: number;
	/** Breakdown by tag value (e.g. per `variant`) when events carry tags. */
	byTag?: Record<string, Record<string, { count: number; sum: number; avg: number }>>;
}

export interface MetricQuery {
	name?: MetricName;
	sinceMs?: number;
	limit?: number;
}

/**
 * LearningMetrics — the append-only-spooled, ring-backed metrics recorder. One instance lives
 * on the manager (mirrors `this.automation`); `record()` never throws (a metrics failure must
 * never break the run it's observing).
 */
export class LearningMetrics {
	private readonly baseDir: string;
	private readonly ring: MetricEvent[] = [];
	private readonly max: number;
	private readonly log: (msg: string) => void;
	private lastId = 0;
	private spoolFailing = false;
	private spoolTail: Promise<void> = Promise.resolve();

	constructor(baseDir: string, opts: { max?: number; log?: (msg: string) => void } = {}) {
		this.baseDir = baseDir;
		this.max = opts.max ?? RING_MAX;
		this.log = opts.log ?? ((m) => console.warn(`[metrics] ${m}`));
		this.hydrate();
	}

	private nextId(now: number): number {
		this.lastId = now > this.lastId ? now : this.lastId + 1;
		return this.lastId;
	}

	/** Record one metric sample. Never throws. */
	record(name: MetricName, value: number, tags?: Record<string, string>, now = Date.now()): MetricEvent {
		try {
			const e: MetricEvent = { id: this.nextId(now), at: now, name, value, tags };
			this.ring.push(e);
			if (this.ring.length > this.max) this.ring.shift();
			this.spoolTail = this.spoolTail.then(
				() => this.spool(e),
				() => this.spool(e),
			);
			return e;
		} catch (err) {
			this.log(`record failed (metric dropped, run continues): ${err instanceof Error ? err.message : String(err)}`);
			return { id: now, at: now, name, value, tags };
		}
	}

	private async spool(e: MetricEvent): Promise<void> {
		try {
			const file = metricsPath(this.baseDir);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.appendFile(file, `${JSON.stringify(e)}\n`);
			if (this.spoolFailing) {
				this.spoolFailing = false;
				this.log("metrics spool recovered — samples are persisting again");
			}
		} catch (err) {
			if (!this.spoolFailing) {
				this.spoolFailing = true;
				this.log(`metrics spool failed (samples are NOT persisting): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private hydrate(): void {
		let text: string;
		try {
			text = readFileSync(metricsPath(this.baseDir), "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.log(`metrics spool unreadable on hydrate — starting empty: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const lines = text.split("\n").filter((l) => l.trim());
		for (const line of lines.slice(-this.max)) {
			try {
				const e = JSON.parse(line) as MetricEvent;
				this.ring.push(e);
				if (typeof e.id === "number" && e.id > this.lastId) this.lastId = e.id;
			} catch {
				/* tolerate a torn trailing line */
			}
		}
	}

	/** Recent events, newest first. */
	recent(q: MetricQuery = {}, now = Date.now()): MetricEvent[] {
		const cutoff = q.sinceMs ? now - q.sinceMs : 0;
		const out = this.ring
			.filter((e) => (!q.name || e.name === q.name) && e.at >= cutoff)
			.slice()
			.reverse();
		const limit = q.limit ?? 500;
		return limit > 0 ? out.slice(0, limit) : out;
	}

	/** Per-metric rollup over the trailing window (default 24h), broken down by each tag key's value —
	 *  the A/B comparison surface: `rollup().find(r => r.name==="first-try-green").byTag?.variant` gives
	 *  `{on: {...}, off: {...}}`. */
	rollup(windowMs = 24 * 3_600_000, now = Date.now()): MetricRollupRow[] {
		const cutoff = now - windowMs;
		const rows = new Map<MetricName, MetricRollupRow>();
		for (const e of this.ring) {
			if (e.at < cutoff) continue;
			let r = rows.get(e.name);
			if (!r) {
				r = { name: e.name, count: 0, sum: 0, avg: 0 };
				rows.set(e.name, r);
			}
			r.count++;
			r.sum += e.value;
			r.avg = r.sum / r.count;
			for (const [tagKey, tagVal] of Object.entries(e.tags ?? {})) {
				r.byTag ??= {};
				r.byTag[tagKey] ??= {};
				const bucket = (r.byTag[tagKey][tagVal] ??= { count: 0, sum: 0, avg: 0 });
				bucket.count++;
				bucket.sum += e.value;
				bucket.avg = bucket.sum / bucket.count;
			}
		}
		return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
	}
}
