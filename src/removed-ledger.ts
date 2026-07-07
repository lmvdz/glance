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
 */

import path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";

export interface RemovedLedger {
	has(id: string): boolean;
	add(id: string): void;
}

function readIds(stateDir: string): Set<string> {
	try {
		const file = path.join(stateDir, "removed-agents.json");
		const b = getStorageBackend();
		if (!b.exists(file)) return new Set();
		const raw0 = b.readTextSync(file);
		if (raw0 === undefined) return new Set();
		const raw = JSON.parse(raw0) as unknown;
		if (!Array.isArray(raw)) return new Set();
		return new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0));
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
		add(id) {
			if (ids.has(id)) return;
			ids.add(id);
			writeIds(stateDir, ids);
		},
	};
}
