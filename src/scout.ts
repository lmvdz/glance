/**
 * Scout — semantic backlog harvester, sibling to the Observer (OMPSQ-52).
 *
 * The Observer audits *operational* fleet state with pure checks (red gate, stale
 * branches, land failures). The Scout reads the *reasoning* of the fleet and files
 * the latent, file-worthy items an agent surfaced but didn't do: bugs noticed in
 * passing, deferred follow-ups, tech debt called out, design risks. "A system that
 * thinks about what it's thinking about."
 *
 * Two triggers, both fire-and-forget so they never block an agent:
 *   - mid-run: a periodic sweep (start(); driven by the liveReasoning dep) scans
 *     each working agent's NEW reasoning since its last scan, so a ticket can appear
 *     while the agent is still thinking;
 *   - run-end: the manager calls scan() from finalizeRun with the final delta.
 * Both go through the same scan(): one LLM one-shot, deduped against a persisted
 * seen-set AND the current open issues, capped globally + per-run. scan() is
 * serialized (one at a time) so the seen-set is race-free across the two triggers.
 * Tickets are always filed for human triage (do-not-auto-land) — LLM-extracted work
 * is unvetted, so the dispatcher must never auto-spawn the fleet on it.
 *
 * The per-agent scan cursor is persisted (src/scout-cursor.ts, scout-cursor.json in
 * the state dir), so a warm daemon restart scans only reasoning newer than the last
 * scan instead of burning one redundant LLM call per reattached agent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AutomationRecorder } from "./automation-log.ts";
import { buildDriftPrompt, type Hypothesis, newSentinelCallBudget, parseDriftHypothesis, sentinelEnabled } from "./drift-lens.ts";
import type { Classify } from "./intake.ts";
import { extractJsonObject } from "./omp-call.ts";
import type { FeatureCriterion, IssueRef, TranscriptEntry } from "./types.ts";

export type ScoutKind = "bug" | "followup" | "tech-debt" | "risk";
const KINDS: Record<ScoutKind, true> = { bug: true, followup: true, "tech-debt": true, risk: true };

/** One latent backlog item extracted from a chunk of reasoning. */
export interface ScoutTicket {
	title: string;
	detail: string;
	kind: ScoutKind;
}

/** Context for one scan — what the run was, so the filed ticket is traceable. */
export interface ScanContext {
	agent: string;
	task?: string;
	/** Human identifier (or name) of the run's tracking issue, if any. */
	issue?: string;
	/** Receipt run id when the scan is tied to a completed or in-flight run. */
	runId?: string;
	/** Sentinel v0 (plans/sentinel-drift-probe) — the unit's DECLARED acceptance criteria, when known.
	 *  The manager supplies this only for monitor-eligible units (has criteria, not env-denied); a
	 *  criteria-less scan makes the drift path a no-op regardless of the other drift deps. */
	criteria?: FeatureCriterion[];
}

/** A reasoning chunk plus its context — what the mid-run sweep yields per live agent. */
export interface ScanInput extends ScanContext {
	text: string;
}

/** External edges, all injected so the harvester runs without a live daemon. */
export interface ScoutDeps {
	/** One-shot LLM call (e.g. omp --smol --no-tools -p). Returns raw text. */
	extract: Classify;
	/** Sentinel v0 (plans/sentinel-drift-probe) — a SEPARATE cheap one-shot for drift classification,
	 *  gated on its own per-hour budget (constructed in the ctor when this is present, distinct from
	 *  Scout's own backlog `budget`). Absent ⇒ the drift path never runs — Scout behaves exactly as
	 *  today (byte-for-byte), which also holds whenever `OMP_SQUAD_SENTINEL` is unset regardless of
	 *  whether this is supplied. */
	driftExtract?: Classify;
	/** Sentinel v0's ONLY output edge: Scout relays a raw drift HYPOTHESIS here — never a verdict. Scout
	 *  fires-and-relays (doesn't await this): the manager-side sink (src/drift-audit.ts's confirmDrift)
	 *  owns judging, confirming, and the durable record. Absent ⇒ the drift path never runs. */
	onHypothesis?: (h: Hypothesis) => void;
	/** Sentinel v0's OWN observability sink (plans/sentinel-drift-probe review fix) — a SEPARATE
	 *  `AutomationRecorder` from `record` above, so drift-scan LLM calls/finds aggregate on their own
	 *  automation channel instead of inflating the scout backlog loop's `llmCalls`/`found` numbers (a
	 *  drift hypothesis is not a scout "found" ticket). Absent ⇒ drift telemetry goes unrecorded (the
	 *  drift path still runs; only its observability is silent), never falls back to `record`. */
	driftRecord?: AutomationRecorder;
	/** Open Plane issues for the observed repo (dedup against existing work); `null` ⇒ unreachable. */
	listIssues: () => Promise<IssueRef[] | null>;
	/** File a scout ticket → its ref; `null` ⇒ not configured / failed. */
	fileIssue: (title: string, descriptionHtml: string) => Promise<IssueRef | null>;
	/** Working agents' UNSCANNED reasoning for the periodic mid-run sweep (the manager owns the cursor).
	 *  Omit ⇒ run-end harvesting only (no timer is armed). */
	liveReasoning?: () => ScanInput[];
	/** Where to persist seen fingerprints. */
	stateDir: string;
	/** Seen-map filename within stateDir (default "scout-seen.json"). Per-repo scouts pass distinct names
	 *  so multi-repo harvests don't share one dedup map. */
	seenFile?: string;
	/** Clock seam (defaults to Date.now). */
	now?: () => number;
	/** Log sink (defaults to no-op). */
	log?: (msg: string) => void;
	/** Observability sink — one report per scan (each scan = one LLM call). Omit ⇒ unobserved. */
	record?: AutomationRecorder;
}

/** Marks a scout-filed issue so the cap counts its own OPEN issues; also a human-scannable provenance tag. */
const SCOUT_TAG = "[scout]";
/** Embedded in every title so the dispatcher's `noAutoDispatchName` gate skips unvetted scout work. */
const TRIAGE_MARKER = "do-not-auto-land";
/** Min new-reasoning chars worth an LLM call — also the trickle-accrual threshold for the cursor. */
export const MIN_SCAN_CHARS = 200;
const MAX_TEXT = 8000; // cap LLM input to the most recent chars (conclusions/deferrals live at the end)
const DEDUP_THRESHOLD = 0.6; // title-token Jaccard above which a candidate is a dup of existing work

/** Default global cap on Scout LLM calls per rolling hour — a verbose multi-agent fleet can otherwise
 *  burn dozens of scout one-shots/hour (one per scan). Bounds spend regardless of how many issues get
 *  filed (the OMP_SQUAD_SCOUT_MAX/PER_RUN caps bound FILINGS, not CALLS). 0 / negative ⇒ unlimited. */
export const DEFAULT_SCOUT_MAX_CALLS_PER_HOUR = 30;

/** Resolved per-hour LLM-call budget from OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR (default 30; <=0 ⇒ unlimited). */
export function scoutMaxCallsPerHour(): number {
	const raw = process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR;
	if (raw === undefined || raw === "") return DEFAULT_SCOUT_MAX_CALLS_PER_HOUR;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.floor(n) : DEFAULT_SCOUT_MAX_CALLS_PER_HOUR;
}

const HOUR_MS = 3_600_000;

/**
 * Sliding-window limiter over Scout LLM calls. Records each call's timestamp; `tryConsume` admits a
 * call only if fewer than `max` calls fall within the trailing hour. Self-contained (no manager
 * dependency) and clock-injectable so it tests headless. `max <= 0` ⇒ unlimited (always admits).
 */
export class ScoutCallBudget {
	private readonly stamps: number[] = [];
	constructor(
		private readonly maxPerHour: () => number,
		private readonly now: () => number = Date.now,
	) {}

	/** Drop stamps older than the trailing hour, then report how many calls remain in the window. */
	private prune(t: number): void {
		const cutoff = t - HOUR_MS;
		while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
	}

	/** Calls made in the trailing hour (for observability / tests). */
	used(t: number = this.now()): number {
		this.prune(t);
		return this.stamps.length;
	}

	/** Admit + record one call if under budget; return false (and record nothing) when the hour is full. */
	tryConsume(): boolean {
		const max = this.maxPerHour();
		const t = this.now();
		this.prune(t);
		if (max > 0 && this.stamps.length >= max) return false;
		this.stamps.push(t);
		return true;
	}
}

const PROMPT_HEAD = `You are a backlog scout reading an AI software engineer's work session.
Extract ONLY concrete, file-worthy work items the engineer SURFACED but did NOT complete here:
bugs noticed in passing, deferred follow-ups, tech debt called out, design risks, "out of scope" notes.

Do NOT emit:
- the session's own assigned task, or anything actually done/finished here;
- vague musings, questions, restatements, or progress narration;
- anything without a clear, actionable change.

Be conservative — if nothing qualifies, return {"tickets":[]}.
Return ONLY JSON, no prose, no code fence:
{"tickets":[{"title":"imperative, <=90 chars","detail":"1-3 sentences: what & why","kind":"bug|followup|tech-debt|risk"}]}
`;

/** Build the extraction prompt for one reasoning chunk. */
export function buildPrompt(task: string | undefined, text: string): string {
	const t = (task ?? "").trim().slice(0, 300) || "(unspecified)";
	return `${PROMPT_HEAD}\nSession task: ${t}\nSession reasoning:\n${text.slice(-MAX_TEXT)}`;
}

/** Parse the model's {"tickets":[...]} payload into validated tickets. Tolerant of fences / stray prose. */
export function parseTickets(raw: string): ScoutTicket[] {
	const obj = extractJsonObject(raw);
	const arr = obj && Array.isArray(obj.tickets) ? obj.tickets : [];
	const out: ScoutTicket[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const title = typeof r.title === "string" ? r.title.trim().slice(0, 90) : "";
		if (!title) continue;
		const detail = typeof r.detail === "string" ? r.detail.trim().slice(0, 400) : "";
		// `=== true` (not `in`): reject proto-chain keys like "toString" from untrusted LLM output.
		const kind = typeof r.kind === "string" && KINDS[r.kind as ScoutKind] === true ? (r.kind as ScoutKind) : "followup";
		out.push({ title, detail, kind });
	}
	return out;
}

/** Lowercase alnum token set of a title (tag/marker stripped) — the fuzzy-dedup key. */
export function titleTokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/\[[a-z]+\]/g, " ") // drop [scout]/[observer] tags
			.replace(/do-?not-?auto-?land|human[ -]?review/g, " ") // drop triage markers
			.replace(/[^a-z0-9]+/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 1),
	);
}

/** Jaccard overlap of two token sets; 0 when either side is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/**
 * New reasoning (assistant+thinking transcript entries) past `cursor` (a ts), plus the cursor to store
 * next. ts-keyed so it survives the transcript's ring-buffer shifts. Returns text:"" with the cursor
 * UNCHANGED until ≥ MIN_SCAN_CHARS has accrued, so a slow trickle is never skipped past unscanned.
 */
export function unscannedReasoning(transcript: TranscriptEntry[], cursor: number): { text: string; cursor: number } {
	const fresh = transcript.filter((e) => (e.kind === "assistant" || e.kind === "thinking") && e.ts > cursor);
	const text = fresh.map((e) => e.text).join("\n");
	if (text.length < MIN_SCAN_CHARS) return { text: "", cursor };
	return { text, cursor: fresh[fresh.length - 1].ts };
}

/** Stable dedup key for a candidate title — sorted normalized tokens (falls back to the raw title). */
function fingerprint(title: string): string {
	const toks = [...titleTokens(title)].sort();
	return toks.length ? toks.join(" ") : title.toLowerCase().trim();
}

const esc = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Run a transient external (Plane) call with ONE retry, then surface-and-swallow. A thrown Plane
 * error used to be caught silently with `() => null`, degrading the dedup-against-open-issues pass
 * (the scan would file against an empty open-set) with no signal. This retries once; if both throw it
 * runs `onFail` and returns `fallback`, keeping the scan non-fatal.
 */
async function withRetry<T>(fn: () => Promise<T>, fallback: T, onFail: (e: unknown) => void): Promise<T> {
	try {
		return await fn();
	} catch {
		try {
			return await fn();
		} catch (e) {
			onFail(e);
			return fallback;
		}
	}
}

/** Ticket body HTML — provenance first (so triage knows where it came from), then the detail. */
function buildBody(t: ScoutTicket, ctx: ScanContext): string {
	const where = ctx.issue ? ` while working <code>${esc(ctx.issue)}</code>` : "";
	return (
		`<p><strong>Scout</strong> — surfaced from <code>${esc(ctx.agent)}</code>'s reasoning${where}.</p>` +
		`<p><strong>Kind:</strong> ${t.kind}</p>` +
		(t.detail ? `<p>${esc(t.detail)}</p>` : "") +
		`<p><em>Auto-extracted from agent reasoning — verify before acting.</em></p>`
	);
}

interface SeenEntry {
	title: string;
	issueId: string;
	filedAt: number;
	agent?: string;
	runId?: string;
	issue?: string;
}
type SeenMap = Record<string, SeenEntry>;

export class Scout {
	private readonly deps: ScoutDeps;
	private readonly seenPath: string;
	/** Filed-ticket fingerprints, persisted so a latent item is never re-filed (even after it's closed — no nagging). */
	private seen: SeenMap;
	private timer?: Timer;
	/** Guards against overlapping mid-run sweeps — a sweep's LLM calls can outlast the interval. */
	private running = false;
	/** Serializes scan() bodies so the seen-set check/write is race-free across mid-run + run-end. */
	private queue: Promise<void> = Promise.resolve();
	/** Global per-hour cap on Scout LLM calls — bounds spend across the whole fleet (OMPSQ #16). */
	private readonly budget: ScoutCallBudget;
	/** Sentinel v0 (plans/sentinel-drift-probe) — a SEPARATE per-hour budget from `budget` above, so a
	 *  verbose fleet's drift scanning can never starve (or be starved by) Scout's own backlog harvest.
	 *  Only constructed when `deps.driftExtract` is present; undefined ⇒ the drift path never runs. */
	private readonly sentinelBudget?: ScoutCallBudget;

	constructor(deps: ScoutDeps) {
		this.deps = deps;
		this.seenPath = path.join(deps.stateDir, deps.seenFile ?? "scout-seen.json");
		this.seen = this.loadSeen();
		this.budget = new ScoutCallBudget(scoutMaxCallsPerHour, deps.now ?? Date.now);
		this.sentinelBudget = deps.driftExtract ? newSentinelCallBudget(deps.now ?? Date.now) : undefined;
	}

	/** Arm the periodic mid-run sweep. No-op (arms no timer) when BOTH the backlog harvest and Sentinel's
	 *  drift path are disabled, or without a liveReasoning dep — arming the shared sweep for drift alone
	 *  (Scout backlog off, Sentinel on) is exactly the point of folding drift into this one cursor/timer. */
	start(intervalMs = 60_000): void {
		if (this.timer || !this.deps.liveReasoning || (process.env.OMP_SQUAD_SCOUT === "0" && !sentinelEnabled())) return;
		const log = this.deps.log ?? (() => {});
		this.timer = setInterval(() => void this.tick().catch((e) => log(`tick error (contained): ${e instanceof Error ? e.message : String(e)}`)), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** One mid-run sweep: scan each live agent's new reasoning. Inert when BOTH the backlog harvest and
	 *  Sentinel's drift path are disabled; never overlaps itself. */
	async tick(): Promise<void> {
		if (process.env.OMP_SQUAD_SCOUT === "0" && !sentinelEnabled()) return;
		if (this.running) {
			this.deps.record?.({ durationMs: 0, skipReason: "overlap", detail: "previous scout sweep still running" });
			return;
		}
		const live = this.deps.liveReasoning?.() ?? [];
		if (!live.length) {
			this.deps.record?.({ durationMs: 0, skipReason: "idle", detail: "no live agent reasoning to scan" });
			return;
		}
		this.running = true;
		try {
			for (const { text, ...ctx } of live) await this.scan(text, ctx);
		} finally {
			this.running = false;
		}
	}

	/** Harvest from one reasoning chunk. Serialized (one scan at a time) so concurrent mid-run + run-end
	 *  triggers can't both file the same item. Never throws — a transport/LLM edge is logged and dropped. */
	async scan(text: string, ctx: ScanContext): Promise<void> {
		const next = this.queue.then(() => this.runScan(text, ctx));
		this.queue = next.catch(() => {}); // keep the chain alive after a failure
		return next;
	}

	private async runScan(text: string, ctx: ScanContext): Promise<void> {
		if (text.length < MIN_SCAN_CHARS) return;
		const log = this.deps.log ?? (() => {});
		const clock = this.deps.now ?? Date.now;
		// OMP_SQUAD_SCOUT=0 gates only the BACKLOG extraction below (an if/else, like the budget check
		// right under it) — it must NOT `return` out of runScan, because that would also skip `runDrift`
		// at the bottom, making Sentinel inert whenever the backlog harvest is disabled even though
		// Sentinel has its own independent enable gate (`sentinelEnabled()`) and budget.
		// Global per-hour LLM-call budget (OMPSQ #16): a verbose fleet can otherwise burn dozens of scout
		// one-shots/hour. When the window is full, skip the (costly) extraction for this scan — recording a
		// structured non-error skip so throttling is observable and persisted without inflating warn/error counts.
		// No fingerprint/cursor is consumed, so the same reasoning is re-harvested once the window reopens.
		// NOTE: this budget check only gates the BACKLOG extraction below (not `return`s out of runScan) so
		// that the drift block's SEPARATE `sentinelBudget` (Sentinel v0) still gets a chance to run even when
		// Scout's own backlog budget is exhausted — the two are deliberately independent (DESIGN.md).
		if (process.env.OMP_SQUAD_SCOUT === "0") {
			// backlog harvesting disabled — fall through to `runDrift` below untouched.
		} else if (!this.budget.tryConsume()) {
			log(`scout LLM budget reached (${scoutMaxCallsPerHour()}/h) — skipping extraction for ${ctx.agent}`);
			this.deps.record?.({ agent: ctx.agent, durationMs: 0, llmCalls: 0, skipReason: "budget", level: "info", detail: `scout LLM budget reached (${scoutMaxCallsPerHour()}/h) — extraction skipped` });
		} else {
			// t0 spans the LLM call: an event is emitted on EVERY path past here (even no-tickets / error) because
			// the one-shot already cost a call — that spend is the whole reason the operator wants this visible.
			const t0 = clock();
			let found = 0;
			let filed = 0;
			try {
				const tickets = parseTickets(await this.deps.extract(buildPrompt(ctx.task, text)));
				found = tickets.length;
				if (tickets.length) {
					// Open-issue list is a transient external (Plane) call: retry once, then warn instead of silently
					// degrading dedup. `null` (Plane unreachable) is a clean signal; only a THROW retries/warns. A
					// failed list ⇒ we proceed with [] (the seen-set still prevents the worst re-files).
					const open =
						(await withRetry(
							() => this.deps.listIssues(),
							null,
							(e) => log(`listIssues failed after retry — dedup-against-open degraded for this scan: ${e instanceof Error ? e.message : String(e)}`),
						)) ?? [];
					const openTokens = open.map((i) => titleTokens(i.name));
					let openScout = open.filter((i) => i.name.includes(SCOUT_TAG)).length;
					const max = Number(process.env.OMP_SQUAD_SCOUT_MAX) || 20; // cap on scout-filed OPEN issues
					const limit = Number(process.env.OMP_SQUAD_SCOUT_PER_RUN) || 3; // cap on tickets from one scan
					let changed = false;

					for (const t of tickets) {
						if (filed >= limit) break;
						if (openScout >= max) {
							log(`cap reached (${max} open) — skipping "${t.title}"`);
							break;
						}
						const fp = fingerprint(t.title);
						if (this.seen[fp]) continue; // already filed once — never re-file (even if since closed)
						const cand = titleTokens(t.title);
						if (openTokens.some((ot) => jaccard(cand, ot) >= DEDUP_THRESHOLD)) continue; // dup of existing open work

						const title = `${SCOUT_TAG} ${TRIAGE_MARKER}: ${t.title}`;
						const ref = await this.deps.fileIssue(title, buildBody(t, ctx)).catch(() => null);
						if (!ref) {
							log(`file failed for "${t.title}"`);
							continue; // transient — a later scan re-harvests it
						}
						openScout++;
						filed++;
						changed = true;
						this.seen[fp] = { title: t.title, issueId: ref.id, filedAt: clock(), agent: ctx.agent, runId: ctx.runId, issue: ctx.issue };
						log(`filed ${t.kind} ${ref.identifier ?? ref.id}: ${t.title}`);
					}
					if (changed) this.saveSeen();
				}
				this.deps.record?.({ agent: ctx.agent, durationMs: clock() - t0, llmCalls: 1, found, filed, deduped: found - filed });
			} catch (e) {
				log(`scan error (contained): ${e instanceof Error ? e.message : String(e)}`);
				this.deps.record?.({ agent: ctx.agent, durationMs: clock() - t0, llmCalls: 1, level: "error", detail: e instanceof Error ? e.message : String(e) });
			}
		}
		await this.runDrift(text, ctx);
	}

	/**
	 * Sentinel v0 (plans/sentinel-drift-probe) — rides the SAME cursor-advanced reasoning slice the
	 * backlog harvest above just read; there is no second `takeScoutReasoning` consumer, which is what
	 * dissolves the cursor-steal race by construction (DESIGN.md). Scout stays a relay here: it invokes
	 * the action-free lens (buildDriftPrompt → driftExtract → parseDriftHypothesis) and, on a non-null
	 * hypothesis, calls the injected `onHypothesis` sink — it never judges, confirms, or steers (no
	 * validator.ts/rpc-agent.ts import in this file). Fire-and-relay: `onHypothesis` is synchronous
	 * (`(h) => void`), so Scout never awaits whatever judge the manager-side sink kicks off.
	 *
	 * No-ops (zero extra LLM calls) unless ALL of: `sentinelEnabled()`, `deps.driftExtract`,
	 * `deps.onHypothesis`, `ctx.criteria` is non-empty, and the SEPARATE `sentinelBudget` admits the
	 * call. Contained — never throws, so a drift-lens failure can't break the backlog scan it rides
	 * alongside (this method runs after the backlog try/catch above has already settled). Reports via
	 * `deps.driftRecord` (its OWN automation channel), never `deps.record` (the backlog channel) — a
	 * drift scan is not a scout "found" ticket, and conflating them would double-count LLM spend and
	 * "found" against the scout backlog loop's numbers.
	 */
	private async runDrift(text: string, ctx: ScanContext): Promise<void> {
		if (!sentinelEnabled() || !this.deps.driftExtract || !this.deps.onHypothesis || !ctx.criteria?.length) return;
		if (!this.sentinelBudget?.tryConsume()) return;
		const log = this.deps.log ?? (() => {});
		const clock = this.deps.now ?? Date.now;
		const t0 = clock();
		try {
			const raw = await this.deps.driftExtract(buildDriftPrompt(ctx.task, ctx.criteria, text));
			const h = parseDriftHypothesis(raw, { agent: ctx.agent, runId: ctx.runId, now: clock });
			if (h) this.deps.onHypothesis(h);
			this.deps.driftRecord?.({ agent: ctx.agent, durationMs: clock() - t0, llmCalls: 1, found: h ? 1 : 0 });
		} catch (e) {
			log(`drift scan error (contained): ${e instanceof Error ? e.message : String(e)}`);
			this.deps.driftRecord?.({ agent: ctx.agent, durationMs: clock() - t0, llmCalls: 1, level: "error", detail: e instanceof Error ? e.message : String(e) });
		}
	}

	private loadSeen(): SeenMap {
		try {
			if (!existsSync(this.seenPath)) return {};
			const raw = JSON.parse(readFileSync(this.seenPath, "utf8")) as unknown;
			return raw && typeof raw === "object" ? (raw as SeenMap) : {};
		} catch (e) {
			// Corrupt/unreadable ⇒ start fresh (worst case: one redundant re-file) — but surface it: a wiped
			// seen-map means dedup is silently degraded and the scout may re-file already-filed tickets.
			(this.deps.log ?? (() => {}))(`scout seen-map unreadable — starting fresh (dedup degraded): ${e instanceof Error ? e.message : String(e)}`);
			return {};
		}
	}

	private saveSeen(): void {
		try {
			writeFileSync(this.seenPath, JSON.stringify(this.seen));
		} catch (e) {
			(this.deps.log ?? (() => {}))(`persist failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
