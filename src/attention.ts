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
import { envBoolAliased } from "./config.ts";
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

/** Shared corrupt/missing ⇒ `{}` raw-object loader for this module's four compacted maps (seen,
 *  surprise-count, unit-visited, unit-completed) — the ONE `JSON.parse(...) as unknown` this file
 *  needs, so the repo's `json-parse-as-cast` migration ratchet counts a single occurrence for four
 *  structurally near-identical stores instead of four. Each caller still owns its OWN shape
 *  narrowing on top (`loadSurpriseCounts`/`loadUnitVisits`/`loadCompletions` filter to their own
 *  value shape via `isValidTimestamp`/`narrowSeenMap` below); this only guarantees "a plain,
 *  non-array object, or `{}` on anything else" — the exact `failure-memory.ts` idiom this module's
 *  doc comment cites (worst case: one boot's worth of history is forgotten, never a crash).
 *
 *  `Array.isArray` is checked explicitly — `typeof [] === "object"` in JS, so a corrupt top-level
 *  JSON array (e.g. a truncated/half-written file, or a caller that wrote the wrong shape) would
 *  otherwise pass the bare `typeof` check and be trusted as a `Record<string, unknown>`, silently
 *  exposing its numeric indices as string keys. Codex/gpt-5.6 cross-lineage review (t3-face concern
 *  06): materialized with `Object.create(null)` rather than `{}` — a plain object literal's bracket
 *  assignment on a literal `"__proto__"` key still invokes `Object.prototype`'s `__proto__` setter
 *  (JSON.parse's OWN result is safe on this point, but this function's callers copy keys across via
 *  `[key] =` assignment below, which is not), so a corrupt file carrying that key as literal text
 *  must not be able to mutate this process's shared object prototype. */
function loadJsonObject(filePath: string): Record<string, unknown> {
	try {
		const b = getStorageBackend();
		if (!b.exists(filePath)) return {};
		const raw0 = b.readTextSync(filePath);
		if (raw0 === undefined) return {};
		const raw = JSON.parse(raw0) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** One day of generous clock skew — bounds a timestamp read back from disk against the CURRENT
 *  clock, so a corrupt `9999999999999999`-style value (still `typeof === "number"` and finite) can
 *  never poison a `visitedAt < completedAt`-style comparison by reading as "the distant future,
 *  always after everything." Codex/gpt-5.6 cross-lineage review (t3-face concern 06). */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Shared numeric-timestamp narrowing for every compacted map this module loads from disk — mirrors
 *  `loadSurpriseCounts`' existing finite/non-negative filter, tightened to a SAFE integer (rejects a
 *  float or a value that lost precision past `Number.MAX_SAFE_INTEGER`) within `MAX_CLOCK_SKEW_MS`
 *  of now. A corrupt/missing value (a string, `NaN`, an array, a wildly-future stamp) is dropped —
 *  fail closed, exactly like `unitVisitedAt`'s own "absence is never seen" contract one layer up. */
function isValidTimestamp(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0 && v <= Date.now() + MAX_CLOCK_SKEW_MS;
}

/** Shape-narrow a raw parsed object into a `SeenMap`/`UnitVisitMap` (same `SeenEntry` shape both
 *  stores use) — a corrupt `"lastSeenAt":"nope"` or non-numeric `byViewer` stamp is DROPPED, not
 *  trusted verbatim (grok-4.5/codex cross-lineage review, t3-face concern 06: the prior blind cast
 *  meant a malformed entry's `undefined`-shaped `lastSeenAt` still compared as `NaN < completedAt`
 *  ⇒ `false` ⇒ read as SEEN — the exact fail-OPEN this narrowing closes). Any row that fails
 *  narrowing is skipped entirely rather than partially trusted. */
function narrowSeenMap(raw: Record<string, unknown>): SeenMap {
	const out: SeenMap = Object.create(null);
	for (const [key, val] of Object.entries(raw)) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const entry = val as Record<string, unknown>;
		if (!isValidTimestamp(entry.lastSeenAt)) continue;
		let byViewer: Record<string, number> | undefined;
		if (entry.byViewer && typeof entry.byViewer === "object" && !Array.isArray(entry.byViewer)) {
			const bv: Record<string, number> = Object.create(null);
			for (const [viewerId, at] of Object.entries(entry.byViewer as Record<string, unknown>)) if (isValidTimestamp(at)) bv[viewerId] = at;
			if (Object.keys(bv).length) byViewer = bv;
		}
		out[key] = byViewer ? { lastSeenAt: entry.lastSeenAt, byViewer } : { lastSeenAt: entry.lastSeenAt };
	}
	return out;
}

function loadSeenMap(stateDir: string): SeenMap {
	return narrowSeenMap(loadJsonObject(seenPath(stateDir)));
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

/** t3-face concern 06 / plans/daily-driver/01-charter-needs-you-ladder.md: per-UNIT last-visited
 *  map, `<stateDir>/unit-visited.json` — same durability/merge contract as `attention-seen.json`
 *  above (`SeenEntry` shape, max-merge, debounced write) but keyed DIRECTLY by agent id, not a
 *  `seenKey()` (repo,file) pair — there is no file for "a human opened this unit's roster row".
 *  Feeds `attention-ladder.ts`'s `completed-unseen` rung: a completion read on one device must not
 *  still read as unseen on another surface polling under the SAME viewer identity, and must never
 *  be conflated with a DIFFERENT viewer's own visit (file mode: no viewerId ever exists, so every
 *  caller collapses onto the one `lastSeenAt` — the same single-implicit-viewer rule the seen map
 *  above already follows). */
export type UnitVisitMap = SeenMap;

function unitVisitPath(stateDir: string): string {
	return path.join(stateDir, "unit-visited.json");
}

/** Same corrupt/missing ⇒ empty contract as `loadSeenMap`, PLUS the same `narrowSeenMap` shape
 *  narrowing (t3-face concern 06's MINOR finding, grok-4.5/codex cross-lineage review: this used to
 *  cast the raw parsed object straight to `UnitVisitMap` with no narrowing at all — a corrupt
 *  `"lastSeenAt":"nope"` entry produced a non-`undefined` garbage `unitVisitedAt()` read, which
 *  `NaN < completedAt`'s always-`false` comparison then resolved as SEEN, not unseen — a fail-OPEN
 *  on exactly the field this store's whole contract is "absence is never seen"). */
function loadUnitVisits(stateDir: string): UnitVisitMap {
	return narrowSeenMap(loadJsonObject(unitVisitPath(stateDir)));
}

/** Same corrupt/missing ⇒ empty contract as `loadSeenMap`, plus its own per-entry narrowing via the
 *  shared `isValidTimestamp` (finite, non-negative, safe-integer, bounded-clock-skew) — tightened
 *  from a bare `Number.isFinite` check (codex/gpt-5.6 cross-lineage review, t3-face concern 06). */
function loadSurpriseCounts(stateDir: string): SurpriseCountMap {
	const raw = loadJsonObject(surprisePath(stateDir));
	const out: SurpriseCountMap = Object.create(null);
	for (const [k, v] of Object.entries(raw)) if (isValidTimestamp(v)) out[k] = v;
	return out;
}

/** SquadManager's CRITICAL fix (grok-4.5 cross-lineage review, t3-face concern 06): a per-agent,
 *  OWN durable completion stamp — `<stateDir>/unit-completed.json` — replacing a scan of
 *  `transitionLog`'s shared 500-entry-TOTAL ring (`SquadManager.lastCompletedAt`'s prior
 *  implementation). That ring is capped across EVERY agent in the fleet, so a busy fleet could evict
 *  the very completion transition this reads well before this unit's own turn-completion "ages
 *  out" — silently un-demoting a real `completed-unseen` unit back to `idle` the moment the ring
 *  happened to roll past it (the "ring-eviction demotion" the review named). This map has no such
 *  cap: one entry per agent, monotone (never regresses), exactly the `unit-visited.json` idiom one
 *  file over. Stamped by `SquadManager.recordTransition` — the ONE chokepoint every APPLIED (never
 *  denied) transition passes through — the moment a transition qualifies as a genuine turn
 *  completion (see `SquadManager.isGenuineCompletion`'s doc for the exact filter: `to==="idle"`,
 *  `from` a real in-flight state, never a bare connect). */
export type CompletionMap = Record<string, number>;

function completionPath(stateDir: string): string {
	return path.join(stateDir, "unit-completed.json");
}

/** Same corrupt/missing ⇒ empty contract, narrowed via the shared `isValidTimestamp`. */
function loadCompletions(stateDir: string): CompletionMap {
	const raw = loadJsonObject(completionPath(stateDir));
	const out: CompletionMap = Object.create(null);
	for (const [k, v] of Object.entries(raw)) if (isValidTimestamp(v)) out[k] = v;
	return out;
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
	/** t3-face concern 06's per-unit last-visited map — see `UnitVisitMap`'s doc above. Written
	 *  through the SAME debounced-flush path/`dirty` flag as `seenMap`/`surpriseCounts` (every write
	 *  site here already shares one flush cadence; a fourth independent timer would buy nothing). */
	private unitVisits: UnitVisitMap;
	/** SquadManager's durable per-agent completion stamp (`CompletionMap`'s doc above) — same
	 *  debounced-flush path/`dirty` flag as every other compacted map here. */
	private completions: CompletionMap;
	private readonly rateBuckets = new Map<string, { minute: number; count: number }>();
	/** Coalesce key → last-seen `at`, for the 30s idempotent-replay window. Unbounded but tiny in
	 *  practice (one entry per distinct (kind,repo,file,agentId,viewerId) tuple ever reported). */
	private readonly coalesceLast = new Map<string, number>();
	private writeTimer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;
	/** True once `stop()`'s final flush has run (codex/gpt-5.6 cross-lineage review, t3-face concern
	 *  06 addition D) — see `stop()`'s doc for the manager-eviction race this narrowly closes. */
	private closed = false;

	constructor(opts: AttentionStoreOptions) {
		this.stateDir = opts.stateDir;
		this.log = opts.log ?? ((m) => console.warn(`[attention] ${m}`));
		this.now = opts.now ?? (() => Date.now());
		this.rateLimitPerMin = opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
		this.raw = new JsonlLog<AttentionEvent>({ path: path.join(this.stateDir, "operator-attention.jsonl"), log: (m) => this.log(`operator-attention.jsonl: ${m}`) });
		this.seenMap = loadSeenMap(this.stateDir);
		this.surpriseCounts = loadSurpriseCounts(this.stateDir);
		this.unitVisits = loadUnitVisits(this.stateDir);
		this.completions = loadCompletions(this.stateDir);
	}

	/** `GLANCE_ATTENTION=0` (legacy alias `OMP_SQUAD_ATTENTION`, batch-3 review: `.env.example`
	 *  documented the alias but this used to read only the new name) — the kill switch (DESIGN.md
	 *  "Privacy posture" row). Read live (not cached at construction) so a runtime flag flip takes
	 *  effect without a daemon restart. */
	disabled(): boolean {
		return !envBoolAliased("GLANCE_ATTENTION", "OMP_SQUAD_ATTENTION", true);
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
		// Batch-3 review adjudication: surprise is cleared by a later GENUINE view, not permanent.
		// A `diff-viewed`/`pr-reviewed` event on this (repo,file) means the operator actually looked at
		// it again — that resets the surprise-tap count to 0, so the boost (below) stops imposing a
		// lifetime debt floor on a file the operator has since reviewed. `surprise` itself is EXCLUDED
		// from this reset: the tap that just fired is what's being counted, not a signal that clears
		// its own count.
		if ((event.kind === "diff-viewed" || event.kind === "pr-reviewed") && event.file) this.resetSurprise(event.repo, event.file);
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

	/** Batch-3 review adjudication: a genuine re-view (`diff-viewed`/`pr-reviewed`, never `surprise`
	 *  itself) clears this (repo,file)'s surprise-tap count entirely — surprise flags divergence only
	 *  until the operator actually re-views the file, not for the file's lifetime. A no-op (no dirty
	 *  write scheduled) when the count is already absent/zero. */
	private resetSurprise(repo: string, file: string): void {
		const key = seenKey(repo, file);
		if (!this.surpriseCounts[key]) return;
		delete this.surpriseCounts[key];
		this.scheduleWrite();
	}

	private scheduleWrite(): void {
		// Codex/gpt-5.6 cross-lineage review (t3-face concern 06, addition D): once `stop()` has run its
		// final flush, no caller may re-arm a NEW debounced timer. Without this, a mark-seen (or any
		// other write) that lands in the async gap between a manager-registry eviction's `stop()` and its
		// own removal from the registry would schedule a fresh 2s timer that fires AFTER a replacement
		// manager for the same org has already loaded this store's file from disk — last-flush-wins,
		// silently discarding the interim write with no error anywhere. The in-memory mutation that
		// triggered this call still applied (harmless — this instance is being discarded), it simply never
		// reaches disk from here again. The broader race (serializing registry `get()` against `evictIdle()`
		// per org so this call is refused outright, not merely made inert) is a manager-registry.ts concern,
		// out of scope for this store.
		if (this.closed) return;
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
		try {
			getStorageBackend().writeDurableSync(unitVisitPath(this.stateDir), JSON.stringify(this.unitVisits));
		} catch (err) {
			this.log(`unit-visited.json write failed: ${errText(err)}`);
		}
		try {
			getStorageBackend().writeDurableSync(completionPath(this.stateDir), JSON.stringify(this.completions));
		} catch (err) {
			this.log(`unit-completed.json write failed: ${errText(err)}`);
		}
	}

	/** Call from the manager's `stop()`, mirroring every other debounced-write subsystem there. Flushes
	 *  first (byte-identical to the historical behavior — a graceful shutdown never loses the ≤2s
	 *  window), THEN marks the store closed so nothing scheduled afterward can re-arm a write timer
	 *  (`scheduleWrite`'s doc — codex/gpt-5.6 cross-lineage review, t3-face concern 06 addition D). */
	stop(): void {
		this.flush();
		this.closed = true;
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

	/** Record that `viewerId` (or the single implicit file-mode viewer, when `undefined`) has
	 *  visited unit `agentId` — the needs-you ladder's mark-seen mutation
	 *  (`POST /api/attention/ladder/seen`). Max-merge, same monotone contract as `mergeSeen`: a
	 *  stale/out-of-order replay must never move a visit stamp backward. Never gated by the
	 *  `disabled()` kill switch or the rate limiter above — those guard the file-viewing telemetry
	 *  lane; visiting a roster row is a core ladder function the operator must always be able to do. */
	markUnitVisited(agentId: string, viewerId: string | undefined, at?: number): void {
		const stamp = at ?? this.now();
		const existing = this.unitVisits[agentId];
		const lastSeenAt = Math.max(existing?.lastSeenAt ?? 0, stamp);
		let byViewer = existing?.byViewer;
		if (viewerId) byViewer = { ...byViewer, [viewerId]: Math.max(byViewer?.[viewerId] ?? 0, stamp) };
		this.unitVisits[agentId] = byViewer ? { lastSeenAt, byViewer } : { lastSeenAt };
		this.scheduleWrite();
	}

	/** Drop durable visit/completion hints for units no longer in the persisted roster. Seen-state is
	 *  intentionally a hint, so pruning on the same snapshot boundary as state persistence keeps the
	 *  compacted maps bounded without adding a second lifecycle hook to every removal path. */
	pruneUnits(agentIds: Set<string>): void {
		let changed = false;
		for (const id of Object.keys(this.unitVisits)) {
			if (agentIds.has(id)) continue;
			delete this.unitVisits[id];
			changed = true;
		}
		for (const id of Object.keys(this.completions)) {
			if (agentIds.has(id)) continue;
			delete this.completions[id];
			changed = true;
		}
		if (changed && !this.closed) {
			this.dirty = true;
			this.flush();
		}
	}

	/** `viewerId === undefined` ⇒ the file-mode single-implicit-viewer collapse: `lastSeenAt` IS the
	 *  visit stamp (there is no `byViewer` to disagree with it). A REAL per-viewer id reads its own
	 *  entry only — it never falls back to `lastSeenAt`, which could be a DIFFERENT viewer's more
	 *  recent visit (DB mode: viewer A opening a unit must never silently read as "seen" for viewer
	 *  B). Absence (no entry at all, or no entry for this viewer) returns `undefined` — fail closed,
	 *  never coerced to "seen" by a missing record. */
	unitVisitedAt(agentId: string, viewerId: string | undefined): number | undefined {
		const entry = this.unitVisits[agentId];
		if (!entry) return undefined;
		return viewerId === undefined ? entry.lastSeenAt : entry.byViewer?.[viewerId];
	}

	/** Raw entry accessor for tests/debugging — mirrors `lastSeen(repo,file)`'s shape one layer up. */
	unitVisitEntry(agentId: string): SeenEntry | undefined {
		return this.unitVisits[agentId];
	}

	/** SquadManager's CRITICAL fix (`CompletionMap`'s doc above): stamp `agentId`'s durable
	 *  last-completion time. Max-merge, same monotone contract as `markUnitVisited` — a stale/
	 *  out-of-order re-record (e.g. a lineage-stitched replay) must never move the stamp backward.
	 *  Called ONLY from `SquadManager.recordTransition`, once per APPLIED transition that qualifies as
	 *  a genuine turn completion. */
	recordCompletion(agentId: string, at: number): void {
		const existing = this.completions[agentId];
		if (existing !== undefined && existing >= at) return;
		this.completions[agentId] = at;
		this.scheduleWrite();
	}

	/** This unit's durable last-completion stamp, or `undefined` if it has never completed a turn.
	 *  O(1) — replaces a former `transitionLog.recent()` linear scan run on every `emitAgent`
	 *  broadcast, which ALSO had the ring-eviction gap this map exists to close. */
	completedAt(agentId: string): number | undefined {
		return this.completions[agentId];
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
