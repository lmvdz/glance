/**
 * Operator-attention substrate (plans/comprehension/01-attention-substrate.md) — a durable,
 * tenant-scoped record of what the human has actually looked at, per (repo, file).
 *
 * Two stores, deliberately different lifetimes (DESIGN.md "Attention substrate" row):
 *   - Raw feed: a `JsonlLog<AttentionEvent>` at `<stateDir>/operator-attention.jsonl` — bounded
 *     telemetry, rotated like every other JsonlLog consumer. NEVER read for fog: rotation clobbers
 *     `.1`, so a flood of events (or just enough time) can silently erase a file's view history if
 *     anything downstream trusted this feed as durable.
 *   - Compacted last-seen map: `<stateDir>/attention-seen.json`, written through
 *     `getStorageBackend()` (failure-memory.ts's whole-file-map idiom — load-on-boot,
 *     corrupt/missing ⇒ `{}`, debounced durable write). This is fog's ONLY source. Updates are a
 *     max-merge (`lastSeenAt` never moves backward) — a stale event replaying after a fresher one
 *     must not resurrect debt on a file the operator already reviewed.
 *
 * Naming note: this file's `AttentionEvent` is UNRELATED to the existing `AttentionEvent` in
 * `types.ts` (an agent's own `notify`/`squad_attention` signal, surfaced as `AgentDTO.attentionEvents`
 * — "the agent flagged this for me"). This one is the inverse: "the operator looked at this." The
 * name collision is unfortunate but both are the plan's/codebase's existing vocabulary; nothing
 * imports both under the same identifier.
 */

import * as path from "node:path";
import { envBool } from "./config.ts";
import { getStorageBackend } from "./dal/storage.ts";
import { errText } from "./err-text.ts";
import { JsonlLog } from "./jsonl-log.ts";
import { normalizeRepoPath } from "./project-registry.ts";

export type AttentionKind = "diff-viewed" | "answer-read" | "debrief-heard" | "pr-reviewed" | "surprise";

export interface AttentionEvent {
	kind: AttentionKind;
	repo: string;
	file?: string;
	agentId?: string;
	prNumber?: number;
	answerId?: string;
	/** Stamped server-side from the DB-mode session user id — NEVER accepted from a client body.
	 *  Absent in file mode (no stable per-viewer identity there). */
	viewerId?: string;
	/** Stamped server-side (or by the store's own clock) — NEVER accepted from a client body. */
	at: number;
}

/** One (repo,file) row of the compacted last-seen map. `lastSeenAt` is the max over every event
 *  that ever touched this file (monotone — see module doc); `byViewer` is the DB-mode per-viewer
 *  breakdown, absent when nothing carried a `viewerId` yet (the common file-mode case). */
export interface SeenEntry {
	lastSeenAt: number;
	byViewer?: Record<string, number>;
}

/** `"${normalizeRepoPath(repo)}\0${file}"` → its seen entry. The `\0` join mirrors
 *  `hotAreasFromReceipts`'s existing per-file key convention (fabric.ts) rather than a bare space —
 *  a repo or file path containing a literal space must not collide with another (repo,file) pair. */
export type SeenMap = Record<string, SeenEntry>;

/** What the caller may set on a new event — `viewerId` is included (the server-derived identity is
 *  threaded through as an ordinary field, same as `repo`/`file`), but `at` never is: the store stamps
 *  it, so nothing upstream can backdate or forge a seen-timestamp. */
export type AttentionRecordInput = Omit<AttentionEvent, "at">;

export interface RecordResult {
	ok: boolean;
	reason?: "disabled" | "rate-limited" | "coalesced";
}

/** `diff-viewed`/`pr-reviewed`/`surprise` are genuine "I looked at this file" signals and feed the
 *  seen map; `answer-read`/`debrief-heard` are read receipts for a different artifact (an Answer, a
 *  voice debrief) that never carries a `file` in the (repo,file) sense this map compacts. */
const SEEN_UPDATING_KINDS = new Set<AttentionKind>(["diff-viewed", "pr-reviewed", "surprise"]);

/** Two identical `{kind,repo,file,agentId,viewerId}` events within this window are one operator
 *  action reported twice (a re-render, a duplicate observer callback) — idempotent 200, not a second
 *  ledger entry. */
const COALESCE_WINDOW_MS = 30_000;

/** The compacted map's own write is debounced, not synchronous per event — a burst of viewport
 *  entries (a 40-file diff scrolling past) must not fsync 40 times. `stop()` flushes any pending
 *  write so a graceful shutdown never loses it (only a crash can — same contract as `pendingPersistTimers`
 *  in squad-manager.ts). */
const WRITE_COALESCE_MS = 2_000;

const DEFAULT_RATE_LIMIT_PER_MIN = 120;

function seenKey(repo: string, file: string): string {
	return `${normalizeRepoPath(repo)}\0${file}`;
}

function seenPath(stateDir: string): string {
	return path.join(stateDir, "attention-seen.json");
}

/** Corrupt/missing ⇒ empty (worst case: one boot's worth of view history is forgotten, never a
 *  crash) — the exact `failure-memory.ts` idiom this module's doc comment cites. */
function loadSeenMap(stateDir: string): SeenMap {
	try {
		const b = getStorageBackend();
		const p = seenPath(stateDir);
		if (!b.exists(p)) return {};
		const raw0 = b.readTextSync(p);
		if (raw0 === undefined) return {};
		const raw = JSON.parse(raw0) as unknown;
		return raw && typeof raw === "object" ? (raw as SeenMap) : {};
	} catch {
		return {};
	}
}

/** Comprehension concern 08's compacted per-(repo,file) `surprise` TAP COUNT map — same durability
 *  contract as the seen map above (`attention-surprise.json`, `getStorageBackend()`,
 *  debounced-write-on-flush) and deliberately NOT derived from `recentEvents()`/the raw JSONL feed:
 *  that feed rotates (module doc — "NEVER read for fog"), so a durable per-file COUNT needs its own
 *  compacted store, exactly like `lastSeenAt` needed one instead of trusting the ring tail. Keyed by
 *  the SAME `seenKey`/`fogKey` convention so `computeFog`'s `surpriseCounts` input joins directly. */
export type SurpriseCountMap = Record<string, number>;

function surprisePath(stateDir: string): string {
	return path.join(stateDir, "attention-surprise.json");
}

/** Same corrupt/missing ⇒ empty contract as `loadSeenMap`. */
function loadSurpriseCounts(stateDir: string): SurpriseCountMap {
	try {
		const b = getStorageBackend();
		const p = surprisePath(stateDir);
		if (!b.exists(p)) return {};
		const raw0 = b.readTextSync(p);
		if (raw0 === undefined) return {};
		const raw = JSON.parse(raw0) as unknown;
		if (!raw || typeof raw !== "object") return {};
		const out: SurpriseCountMap = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/** Minute-bucket token limiter — same shape as `server.ts`'s `minuteRateAllowed` (not imported from
 *  there to avoid a src/attention.ts → src/server.ts dependency; this module is constructed by
 *  `SquadManager`, well below `server.ts` in the dependency graph). */
function minuteRateAllowed(bucket: Map<string, { minute: number; count: number }>, key: string, limit: number, now: number): boolean {
	const minute = Math.floor(now / 60_000);
	const k = key || "unknown";
	const rec = bucket.get(k);
	if (!rec || rec.minute !== minute) {
		bucket.set(k, { minute, count: 1 });
		return true;
	}
	rec.count++;
	return rec.count <= limit;
}

export interface AttentionStoreOptions {
	stateDir: string;
	log?: (msg: string) => void;
	/** Injectable clock — tests drive coalesce/rate-limit windows without real sleeps. */
	now?: () => number;
	/** Per-actor events/minute before a 429 (module doc default: 120). */
	rateLimitPerMin?: number;
}

/**
 * Owns both stores (module doc) for one daemon's lifetime. Constructed ONCE on `SquadManager`
 * (mirrors `transitionLog`'s construction in the manager constructor), never per-request — a
 * per-request instance would reload the seen map from disk on every GET and lose every in-flight
 * rate-limit/coalesce bucket the moment a request finished.
 */
export class AttentionStore {
	private readonly stateDir: string;
	private readonly log: (msg: string) => void;
	private readonly now: () => number;
	private readonly rateLimitPerMin: number;
	private readonly raw: JsonlLog<AttentionEvent>;
	private seenMap: SeenMap;
	/** Concern-08 surprise-tap counts — see `SurpriseCountMap`'s doc above. Written through the same
	 *  debounced-flush path as `seenMap`; both are part of one `dirty` flag since every event that
	 *  touches either always originates from the same `record()` call. */
	private surpriseCounts: SurpriseCountMap;
	private readonly rateBuckets = new Map<string, { minute: number; count: number }>();
	/** Coalesce key → last-seen `at`, for the 30s idempotent-replay window. Unbounded but tiny in
	 *  practice (one entry per distinct (kind,repo,file,agentId,viewerId) tuple ever reported). */
	private readonly coalesceLast = new Map<string, number>();
	private writeTimer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;

	constructor(opts: AttentionStoreOptions) {
		this.stateDir = opts.stateDir;
		this.log = opts.log ?? ((m) => console.warn(`[attention] ${m}`));
		this.now = opts.now ?? (() => Date.now());
		this.rateLimitPerMin = opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
		this.raw = new JsonlLog<AttentionEvent>({ path: path.join(this.stateDir, "operator-attention.jsonl"), log: (m) => this.log(`operator-attention.jsonl: ${m}`) });
		this.seenMap = loadSeenMap(this.stateDir);
		this.surpriseCounts = loadSurpriseCounts(this.stateDir);
	}

	/** `GLANCE_ATTENTION=0` — the kill switch (DESIGN.md "Privacy posture" row). Read live (not
	 *  cached at construction) so a runtime flag flip takes effect without a daemon restart. */
	disabled(): boolean {
		return !envBool("GLANCE_ATTENTION", true);
	}

	/**
	 * Record one attention event. `rateLimitKey` is the caller's per-actor bucket key (typically
	 * `actor.id`) — never persisted, purely a rate-limit dimension.
	 *
	 * Fails soft on every rejection reason (`{ ok:false, reason }`), never throws: attention is a
	 * best-effort telemetry signal, not a critical write path.
	 */
	record(input: AttentionRecordInput, rateLimitKey: string): RecordResult {
		if (this.disabled()) return { ok: false, reason: "disabled" };
		if (!minuteRateAllowed(this.rateBuckets, rateLimitKey, this.rateLimitPerMin, this.now())) return { ok: false, reason: "rate-limited" };
		const at = this.now();
		const event: AttentionEvent = { ...input, at };
		const coalesceKey = `${event.kind}\0${event.repo}\0${event.file ?? ""}\0${event.agentId ?? ""}\0${event.viewerId ?? ""}`;
		const lastAt = this.coalesceLast.get(coalesceKey);
		if (lastAt !== undefined && at - lastAt < COALESCE_WINDOW_MS) {
			// Idempotent replay: no duplicate JSONL entry, no redundant map merge — but still a 200,
			// not an error. The operator's viewport observer firing twice for one dwell is normal.
			return { ok: true, reason: "coalesced" };
		}
		this.coalesceLast.set(coalesceKey, at);
		this.raw.append(event);
		if (SEEN_UPDATING_KINDS.has(event.kind) && event.file) this.mergeSeen(event.repo, event.file, event.viewerId, at);
		// Concern 08: a `surprise` tap ALSO increments its own durable per-(repo,file) count — the
		// seen-map merge above already moved `lastSeenAt` forward (a surprise tap is itself a "looked at
		// this" signal), but `computeFog`'s boost needs a COUNT, which the seen map's max-merge can't
		// represent (a repeated view never regresses `lastSeenAt` to something incrementable).
		if (event.kind === "surprise" && event.file) this.incrementSurprise(event.repo, event.file);
		return { ok: true };
	}

	/** Max-merge into the compacted map — `lastSeenAt`/each viewer's own timestamp only ever moves
	 *  forward (module doc: a stale replay must never resurrect debt on an already-reviewed file). */
	private mergeSeen(repo: string, file: string, viewerId: string | undefined, at: number): void {
		const key = seenKey(repo, file);
		const existing = this.seenMap[key];
		const lastSeenAt = Math.max(existing?.lastSeenAt ?? 0, at);
		let byViewer = existing?.byViewer;
		if (viewerId) byViewer = { ...byViewer, [viewerId]: Math.max(byViewer?.[viewerId] ?? 0, at) };
		this.seenMap[key] = byViewer ? { lastSeenAt, byViewer } : { lastSeenAt };
		this.scheduleWrite();
	}

	/** Increment the durable surprise-tap count for one (repo,file) pair. Same key convention as
	 *  `mergeSeen` (`seenKey`) so `computeFog`'s `surpriseCounts` input joins against it directly. */
	private incrementSurprise(repo: string, file: string): void {
		const key = seenKey(repo, file);
		this.surpriseCounts[key] = (this.surpriseCounts[key] ?? 0) + 1;
		this.scheduleWrite();
	}

	private scheduleWrite(): void {
		this.dirty = true;
		if (this.writeTimer) return;
		this.writeTimer = setTimeout(() => this.flush(), WRITE_COALESCE_MS);
		// A pending debounce timer must never keep the daemon process alive on its own.
		if (typeof this.writeTimer.unref === "function") this.writeTimer.unref();
	}

	/** Force the debounced map write out immediately. Called by `stop()` so a graceful shutdown
	 *  never loses the ≤2s window — only an actual crash can. Safe to call when nothing is dirty. */
	flush(): void {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		if (!this.dirty) return;
		this.dirty = false;
		try {
			getStorageBackend().writeDurableSync(seenPath(this.stateDir), JSON.stringify(this.seenMap));
		} catch (err) {
			// Best-effort: a disk failure must never break whatever caller triggered this flush.
			this.log(`attention-seen.json write failed: ${errText(err)}`);
		}
		try {
			getStorageBackend().writeDurableSync(surprisePath(this.stateDir), JSON.stringify(this.surpriseCounts));
		} catch (err) {
			this.log(`attention-surprise.json write failed: ${errText(err)}`);
		}
	}

	/** Call from the manager's `stop()`, mirroring every other debounced-write subsystem there. */
	stop(): void {
		this.flush();
	}

	/** The map read fresh, restricted to `repos` when given (each side normalized, like every other
	 *  repo-scoped fabric read). `undefined` means unrestricted (every key in the map) — an explicit
	 *  EMPTY array is NOT the same thing and must restrict to nothing: a caller whose actor-visible
	 *  repo set is genuinely empty passes `[]` on purpose, and treating that as "unrestricted" would
	 *  silently hand them every tenant's seen map the moment they had none of their own. */
	seenMapFor(repos?: string[]): SeenMap {
		if (repos === undefined) return { ...this.seenMap };
		if (repos.length === 0) return {};
		const keys = new Set(repos.map(normalizeRepoPath));
		const out: SeenMap = {};
		for (const [key, entry] of Object.entries(this.seenMap)) {
			const repo = key.slice(0, key.indexOf("\0"));
			if (keys.has(repo)) out[key] = entry;
		}
		return out;
	}

	lastSeen(repo: string, file: string): SeenEntry | undefined {
		return this.seenMap[seenKey(repo, file)];
	}

	/** Concern-08 fog wiring: the durable surprise-count map, restricted to `repos` exactly like
	 *  `seenMapFor` — `undefined` means unrestricted, an explicit `[]` means "nothing" (fail closed),
	 *  never conflated (same tenant-scoping contract, same reasoning: a caller with a genuinely empty
	 *  actor-visible repo set must never be handed another tenant's counts just because it asked for
	 *  "no filter" by omission vs. asked for "empty" on purpose). */
	surpriseCountsFor(repos?: string[]): SurpriseCountMap {
		if (repos === undefined) return { ...this.surpriseCounts };
		if (repos.length === 0) return {};
		const keys = new Set(repos.map(normalizeRepoPath));
		const out: SurpriseCountMap = {};
		for (const [key, count] of Object.entries(this.surpriseCounts)) {
			const repo = key.slice(0, key.indexOf("\0"));
			if (keys.has(repo)) out[key] = count;
		}
		return out;
	}

	/** Raw feed's ring tail — bounded telemetry (module doc), NEVER the fog's read source. Newest
	 *  events last, like every other `JsonlLog.recent()` caller sees. */
	recentEvents(limit?: number): AttentionEvent[] {
		return this.raw.recent(limit);
	}
}

/** The privacy filter every GET route runs raw events/the seen map through (DESIGN.md "Tenant
 *  scoping" row: "a tested deliverable with an acceptance test", not prose). `viewerId` is the
 *  caller's own DB-mode identity (undefined in file mode, or for an admin who simply doesn't need
 *  one) — never trusted from a query string. */
export interface AttentionActor {
	viewerId?: string;
	isAdmin: boolean;
}

/**
 * Non-admin: every event stays in the list (so aggregates like "3 people looked at this file" are
 * still derivable), but any OTHER viewer's `viewerId` is stripped — the actor's OWN events keep
 * their real id, everyone else's read as anonymous. Admin: unchanged, full raw read (disclosed in
 * fog UI copy per DESIGN.md — an admin raw-read is a deliberate, disclosed capability, not a leak).
 */
export function redactAttentionForActor(events: AttentionEvent[], actor: AttentionActor): AttentionEvent[] {
	if (actor.isAdmin) return events;
	return events.map((e) => (e.viewerId !== undefined && e.viewerId === actor.viewerId ? e : { ...e, viewerId: undefined }));
}

/** Same redaction, applied to the compacted map's `byViewer` breakdowns instead of raw events —
 *  a non-admin keeps their own per-viewer timestamp (if any) and loses everyone else's; `lastSeenAt`
 *  (the aggregate) is never redacted, in either tier — it carries no identity on its own. */
export function redactSeenMapForActor(map: SeenMap, actor: AttentionActor): SeenMap {
	if (actor.isAdmin) return map;
	const out: SeenMap = {};
	for (const [key, entry] of Object.entries(map)) {
		if (!entry.byViewer) {
			out[key] = entry;
			continue;
		}
		const mine = actor.viewerId !== undefined ? entry.byViewer[actor.viewerId] : undefined;
		out[key] = { lastSeenAt: entry.lastSeenAt, byViewer: mine !== undefined ? { [actor.viewerId as string]: mine } : undefined };
	}
	return out;
}
