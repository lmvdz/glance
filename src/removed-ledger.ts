/**
 * Durable "explicitly removed" tombstone — the `rm`-doesn't-stick incident.
 *
 * `SquadManager.remove()` deleting an id from the in-memory roster and persisting the roster
 * snapshot is NOT enough in DB-root/multi-tenant mode: a per-org `SquadManager` is evicted after
 * an idle window and lazily re-created on the next request (`ManagerRegistry.evictIdle`/`get`).
 * On the fresh instance's `start()`, `reconnectLive()` unconditionally reattaches any still-
 * persisted TERMINAL-marked workflow record verbatim (`this.agents.set(p.id, rec)` — the exact
 * original id, not a freshly-minted one), and `adoptOrphanedAgents()` can re-adopt any persisted
 * record whose worktree still exists on disk. Neither path has ever consulted "was this id
 * explicitly removed" — no such signal existed. Worse, `remove()` itself silently no-ops
 * (`if (!rec) return`) whenever the id isn't currently resident in `this.agents` (exactly the
 * eviction-race window), so the persisted row is never touched at all and the very next
 * `start()` reattaches it.
 *
 * This is the same tiny-JSON-set pattern as `dispatch-ledger.ts` (restart-safe, per-stateDir —
 * which is already per-ORG in DB-root mode, see manager-registry.ts's `path.join(root, "orgs",
 * orgId)`), deliberately NOT plumbed through the `Store`/`DbStore`/`FileStore` abstraction:
 * it needs to durably persist an id EVEN when that id was never resident in `this.agents` (so
 * there is nothing to fold into a roster snapshot), which the full-snapshot-replace `Store`
 * contract doesn't support.
 *
 * Keyed by AGENT id, not Plane issue id, on purpose: a tombstoned id must never resurrect, but
 * the underlying issue must remain dispatchable — a later dispatch tick mints a fresh,
 * non-deterministic agent id (`newAgentId`) for a still-open issue, which is a DIFFERENT string
 * and so is never shadowed by this ledger.
 *
 * SEQUEL — tombstone-by-name incident: `remove()`'s original fix above tombstoned whatever string
 * the caller passed as `id`, unvalidated. The CLI's `glance rm <name>` (and any other name-based
 * caller) passes the agent's DISPLAY NAME, not its id — every resurrection guard filters by the
 * record's real `id` (e.g. `ompsq-422-mrb7dh74-3-528e10f5`), which never equals the bare name
 * (e.g. `ompsq-422`). Result: the ledger filled up with names that shadow nothing, the live record
 * was never actually removed from the persisted snapshot under its real id, and the next restart
 * reattached it verbatim — `rm` "worked" (the CLI printed "removed") and the agent came back
 * anyway. `remove()` now resolves any caller-supplied identifier (id OR name, live OR persisted) to
 * the record's canonical id FIRST, and tombstones that — the name is only ever added alongside it,
 * never in place of it (see `add`'s `alsoTombstone` param).
 */

import path from "node:path";
import { Schema } from "effect";
import { getStorageBackend } from "./dal/storage.ts";
import { decodeJsonWith } from "./schema/external-json.ts";

export interface RemovedLedger {
	has(id: string): boolean;
	/** Tombstone the record's canonical id. `alsoTombstone` is optional defense-in-depth (the
	 *  tombstone-by-name incident): when the caller resolved a bare display NAME to this id (an
	 *  operator's `rm <name>` — see squad-manager.ts's `remove()`), the raw name is ALSO written into
	 *  the same array so a future filter that (incorrectly) queries by name still hits. The id is the
	 *  correctness fix; the name is belt-and-suspenders and never required to be present. */
	add(id: string, alsoTombstone?: string): void;
	/** Clear a tombstone — an AUTHORIZED creator deliberately re-creating the id (createWithId's
	 *  explicit-id paths: fork, spawnFleetBranch's deterministic workflow-branch ids). Without this,
	 *  a workflow resume re-spawning a deterministic branch id after an operator `rm` would run once
	 *  and then silently vanish at the next restart (every reattach/adopt/restore path filters
	 *  tombstoned ids). Idempotent; a no-op for an untombstoned id. Only clears the exact id passed —
	 *  a defense-in-depth name entry (see `add`) is deliberately left alone, since it may belong to an
	 *  unrelated record that happens to share the removed one's display name. */
	delete(id: string): void;
}

/** On-disk shape: a JSON array of tombstoned agent ids (written sorted by writeIds). A real Schema
 *  decode (src/schema/external-json.ts convention) rather than a `JSON.parse as` cast — persisted
 *  state survives daemon upgrades, so the shape check is a genuine trust boundary, and it keeps the
 *  json-parse-as-cast ratchet flat. */
const RemovedIdsSchema = Schema.Array(Schema.String);

function readIds(stateDir: string): Set<string> {
	try {
		const file = path.join(stateDir, "removed-agents.json");
		const b = getStorageBackend();
		if (!b.exists(file)) return new Set();
		const raw0 = b.readTextSync(file);
		if (raw0 === undefined) return new Set();
		const ids = decodeJsonWith(RemovedIdsSchema, raw0);
		return new Set((ids ?? []).filter((x) => x.length > 0));
	} catch {
		return new Set(); // corrupt/unreadable ⇒ behave as "nothing tombstoned" this boot; never crash start()
	}
}

function writeIds(stateDir: string, ids: Set<string>): void {
	try {
		getStorageBackend().writeDurableSync(path.join(stateDir, "removed-agents.json"), JSON.stringify([...ids].sort()));
	} catch {
		/* best-effort: a disk failure here must not block `rm` from at least removing the live record */
	}
}

export function openRemovedLedger(stateDir: string): RemovedLedger {
	const ids = readIds(stateDir);
	return {
		has(id) {
			return ids.has(id);
		},
		add(id, alsoTombstone) {
			let changed = false;
			if (!ids.has(id)) {
				ids.add(id);
				changed = true;
			}
			if (alsoTombstone && alsoTombstone !== id && !ids.has(alsoTombstone)) {
				ids.add(alsoTombstone);
				changed = true;
			}
			if (changed) writeIds(stateDir, ids);
		},
		delete(id) {
			if (!ids.delete(id)) return;
			writeIds(stateDir, ids);
		},
	};
}
