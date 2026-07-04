# Persisted transition history

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/jsonl-log.ts (new), src/squad-manager.ts, src/types.ts, src/server.ts, tests/jsonl-log.test.ts (new), tests/transition-history.test.ts (new)

## Goal

`{from,to,reason,at}` transitions recorded by concern 01's `transition()`/`setPending()` hook survive a daemon restart, are exposed as a dedicated low-frequency `SquadEvent`, and are readable via `GET /api/agents/:id/transitions` — all while every cause string and persisted pending text is redacted before it touches disk, matching the guarantee `append()` already gives the transcript (squad-manager.ts:3428-3433).

## Approach

### 1. `src/jsonl-log.ts` — new standalone module, NOT a refactor of `automation-log.ts`

`automation-log.ts` stays untouched. Hand-roll a small generic on the same idiom (capped ring + serialized fire-and-forget spool + torn-line-skipping hydrate) it already proves out, plus size-capped rotation which automation-log.ts deliberately does not have (its header documents unbounded growth as an accepted ceiling — transitions.jsonl does not get that ceiling because it is smaller-volume but longer-lived, and rotation is cheap to add fresh rather than retrofit).

```ts
/**
 * JsonlLog<T> — a small ring+spool JSONL log, generalized from automation-log.ts's idiom
 * (capped in-memory ring, serialized fire-and-forget append, torn-line-skipping hydrate)
 * for reuse by transitions.jsonl. automation-log.ts is NOT refactored to use this — that
 * subsystem's spool is entangled with isMeaningful filtering and stays as-is; unify later
 * if a third consumer appears.
 *
 * Consistency contract: the RING is authoritative for the tail (what recent() returns);
 * the FILE is best-effort (a failed write is logged once per failure episode, never thrown
 * into the caller). A caller that needs the full persisted history reads the file directly
 * (see hydrateAll below) — recent() never does file I/O.
 *
 * Rotation: when the file exceeds `maxBytes`, it is renamed to `<path>.1` (clobbering any
 * previous `.1`) and a fresh file started. This log is NOT a durable forensic record beyond
 * the rotation cap — receipts/transcripts are the long-horizon record; this is a bounded
 * recent-history + live-tail feed.
 */
export interface JsonlLogOptions<T> {
	path: string;
	max?: number; // ring size, default 500
	maxBytes?: number; // rotation threshold, default 2_000_000 (2MB)
	idOf?: (entry: T) => number | string; // for hydrate's lastId-style bookkeeping; optional
	log?: (msg: string) => void;
}

export class JsonlLog<T> {
	private readonly ring: T[] = [];
	private readonly max: number;
	private readonly maxBytes: number;
	private readonly filePath: string;
	private readonly log: (msg: string) => void;
	private spoolFailing = false;
	private spoolTail: Promise<void> = Promise.resolve();

	constructor(opts: JsonlLogOptions<T>) {
		this.filePath = opts.path;
		this.max = opts.max ?? 500;
		this.maxBytes = opts.maxBytes ?? 2_000_000;
		this.log = opts.log ?? ((m) => console.warn(`[jsonl-log] ${m}`));
		this.hydrate();
	}

	/** Ring push + fire-and-forget spool. Never throws. */
	append(entry: T): void {
		this.ring.push(entry);
		if (this.ring.length > this.max) this.ring.shift();
		this.spoolTail = this.spoolTail.then(() => this.spool(entry), () => this.spool(entry));
	}

	/** Ring tail, newest-last (callers reverse if they want newest-first) — no file I/O. */
	recent(limit?: number): T[] {
		return limit && limit > 0 ? this.ring.slice(-limit) : this.ring.slice();
	}

	/** Full persisted history from disk (torn-line-skipping) — for the explicit "full history" request only. */
	async hydrateAll(): Promise<T[]> {
		try {
			const text = await Bun.file(this.filePath).text();
			const out: T[] = [];
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try { out.push(JSON.parse(line) as T); } catch { /* skip torn line */ }
			}
			return out;
		} catch {
			return []; // missing file = normal first-boot case
		}
	}

	private async spool(entry: T): Promise<void> {
		try {
			await this.rotateIfNeeded();
			const dir = this.filePath.slice(0, this.filePath.lastIndexOf("/"));
			await Bun.write(Bun.file(`${dir}/.jsonl-log-touch`), ""); // ensure dir exists cheaply — replaced by fs.mkdir in real impl
			await Bun.write(this.filePath, `${await this.tailOrEmpty()}${JSON.stringify(entry)}\n`); // placeholder; real impl uses fs.appendFile
			if (this.spoolFailing) { this.spoolFailing = false; this.log("spool recovered"); }
		} catch (err) {
			if (!this.spoolFailing) { this.spoolFailing = true; this.log(`spool failed (not persisting): ${err instanceof Error ? err.message : String(err)}`); }
		}
	}
	// ... rotateIfNeeded (stat + rename to .1 past maxBytes), hydrate (sync read of tail into ring on construction)
}
```

Implementation note: the sketch above intentionally leaves `spool`'s exact fs calls loose — mirror `automation-log.ts`'s real `fs.mkdir(dirname, {recursive:true})` + `fs.appendFile` pattern (node:fs/promises, not the placeholder `Bun.write` shown for brevity), and its `hydrate()` uses `readFileSync` synchronously in the constructor exactly like automation-log.ts does. Total module size target: ~60 lines excluding comments, matching the design's estimate — resist adding query/filter helpers here; those belong in the consumer (`transitionHistory()` on `SquadManager`, §3).

### 2. Wire into `transition()`/`setPending()` from concern 01

Add to `SquadManager`:

```ts
private readonly transitionLog: JsonlLog<TransitionEntry>; // constructed in the constructor, path = path.join(this.stateDir, "transitions.jsonl")
```

`TransitionEntry` (new type in `src/types.ts`, near `AgentStatus`):

```ts
export interface TransitionEntry {
	agentId: string;
	from: AgentStatus;
	to: AgentStatus;
	reason: TransitionReason; // from src/agent-lifecycle.ts
	at: number;
	cause?: { error?: string; priorId?: string; [k: string]: unknown };
	denied?: true;
	replayed?: true; // set by concern 04's settle-window pending tagging (not used on TransitionEntry itself in this concern, but reserved on the shared cause shape for forward-compat — do not implement here)
}
```

Replace concern 01's stub `recordTransition`/`recordDenied` bodies:

```ts
private recordTransition(rec: AgentRecord, from: AgentStatus, to: AgentStatus, reason: TransitionReason, cause?: Record<string, unknown>): void {
	const redactedCause = cause ? redactCause(cause) : undefined;
	const entry: TransitionEntry = { agentId: rec.dto.id, from, to, reason, at: Date.now(), cause: redactedCause };
	this.transitionLog.append(entry);
	this.pushTransitionEvent(rec, entry); // concern 03 wires DTO tail + rollup off this same call
	this.emit("event", { type: "transition", entry } satisfies SquadEvent);
}

private recordDenied(rec: AgentRecord, from: AgentStatus, to: AgentStatus, reason: TransitionReason, cause?: Record<string, unknown>): void {
	const entry: TransitionEntry = { agentId: rec.dto.id, from, to, reason, at: Date.now(), cause: cause ? redactCause(cause) : undefined, denied: true };
	this.transitionLog.append(entry);
	this.emit("event", { type: "transition", entry } satisfies SquadEvent);
}

/** Redact every string field of cause (error/title/message/etc.) through the same chokepoint append() uses. */
function redactCause(cause: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(cause)) out[k] = typeof v === "string" ? redact(v) : v;
	return out;
}
```

Also apply `redactCause`-equivalent redaction inside `setPending()` to the `PendingRequest.title`/`message` fields **before** they're stored on `rec.dto.pending` — this is new: today those fields are never redacted (they ride straight into `dto.pending` and get displayed/persisted verbatim). Redact at write (inside `setPending`), matching the design's explicit rejection of redact-at-read (`append()`'s existing architecture keeps secrets out of state at rest, not out of the display layer).

Add `"transition"` to the `SquadEvent` union in `src/types.ts` (squad-manager.ts:798-809):

```ts
| { type: "transition"; entry: TransitionEntry }
```

This is intentionally a **low-frequency, dedicated event** — not riding `emitAgent`'s per-RPC-frame broadcast. `maybePushAlert` (server.ts, out of scope this slice) can subscribe to it later to replace its private `lastStatus` diff; do not touch that code here.

### 3. `GET /api/agents/:id/transitions` endpoint

Model on the existing `/api/agents/:id/transcript` pattern (server.ts:1216-1217). Add near it:

```ts
const mtrans = url.pathname.match(/^\/api\/agents\/([^/]+)\/transitions$/);
if (mtrans) {
	const full = url.searchParams.get("full") === "1";
	return Response.json(await manager.transitionHistory(decodeURIComponent(mtrans[1]), { full }));
}
```

New `SquadManager.transitionHistory(id, opts)`:

```ts
async transitionHistory(id: string, opts: { full?: boolean } = {}): Promise<TransitionEntry[]> {
	const own = this.transitionLog.recent().filter((e) => e.agentId === id);
	if (!opts.full) return own; // ring-served, no file I/O — the default, fast path
	// full=1: read the file too, dedupe against the ring by (agentId,at,reason), and follow
	// cause.priorId lineage (bounded hops, e.g. max 10) to stitch a crash-spanning timeline for
	// an agent that was cold-adopted with a fresh id — concern 04 populates priorId on adopt.
	const fromFile = (await this.transitionLog.hydrateAll()).filter((e) => e.agentId === id);
	const merged = dedupeTransitions([...fromFile, ...own]);
	return this.followLineage(id, merged); // walks cause.priorId chain, bounded, concatenates prior-id histories
}
```

`followLineage` and `dedupeTransitions` are small private helpers on `SquadManager` (or free functions in `agent-lifecycle.ts` if they stay `AgentRecord`-free — prefer that, since lineage-walking only needs `TransitionEntry[]`, not the live record).

## Cross-Repo Side Effects

None. `webapp/src/lib/dto.ts` additions and consumption are concern 03 — this concern ships the wire format (`TransitionEntry`, the `"transition"` event, the endpoint) without touching the webapp.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/jsonl-log.test.ts` — append/ring-cap/rotation-at-maxBytes/torn-line-skip-on-hydrate, all against a temp dir.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/transition-history.test.ts` — drive a fake agent through several `transition()`/`setPending()` calls (using concern 01's guarded methods), assert: (a) `transitions.jsonl` contains the expected lines after a flush wait, (b) a fresh `SquadManager` pointed at the same `stateDir` hydrates the ring on construction, (c) a cause string containing a fake `sk-...` key comes back redacted from both `recent()` and the file, (d) `GET /api/agents/:id/transitions` (via a direct manager call, not a live HTTP server) returns ring-only by default and includes file history with `full=1`.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test` (full suite) — no regression in existing transcript/emit tests now that `setPending` redacts pending text.
- `bun run check`

## Dependency graph

blockedBy: 01-lifecycle-write-path.md
verifyBlocker: confirm `transition()`/`setPending()` exist on `SquadManager` with the `recordTransition`/`recordDenied` stub hook points — `grep -n "private recordTransition\|private recordDenied" src/squad-manager.ts` should return two hits before starting.

## Resolution
Shipped in a17bb3c (+ audit fixes cd5eee4: uuid seq identity for dedupe, per-agent error timestamps, poll-path decay). Redaction moved up into transition() (chokepoint per DESIGN) at implementation time; followLineage filters after ring∪file merge, not before.
