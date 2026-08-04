/**
 * The stateDir ledger idiom — ONE implementation of the durable-tiny-JSON pattern that had grown
 * eight hand-rolled copies (dispatch-ledger, removed-ledger, goal-overlap-ledger, race-ledger,
 * land-ledger ×3, failure-memory — goal-overlap-ledger's own header admitted "this is that exact
 * pattern"). Concern 03 of plans/deepen-modules.
 *
 * The shared contract every copy re-implemented, now in one place:
 *  - reads NEVER throw: missing / unreadable / corrupt / wrong-shape ⇒ the empty value — a bad
 *    file degrades to in-memory behaviour for this boot, it never crashes the caller's tick;
 *  - writes are best-effort: a disk failure must never break the operation the ledger records;
 *  - writes are DURABLE and ATOMIC through the StorageBackend seam (tmp+rename) — which also
 *    fixes the one former copy (land-ledger) that used raw non-atomic `node:fs` and whose writes
 *    an Archil/remote-storage swap would have silently lost.
 *
 * Four shapes cover every ledger in the tree; POLICY stays with the declaring module (pair
 * keying, first-wins refinement, tombstone-also-name, streak clear-on-success):
 *  - `openSetLedger`  — cached id set, sorted-array file (dispatch, removed, goal-overlap);
 *  - `openMapLedger`  — cached key→record object file (race);
 *  - `mapFile`        — UNcached key→record accessor, read-modify-write per call, for ledgers
 *    read by other processes'/modules' cadence (land-failures, failure-annotations);
 *  - `listFile`       — UNcached append-only list (forced-land / validator-override audit trails).
 *
 * Retention (POSITION.md FIELD-1 "bounded with guards, never merely deleted"): `listFile` takes
 * optional `{ maxEntries, minRetained }` — oldest entries are dropped only above `maxEntries`,
 * never below `minRetained`. Deliberately NOT wired onto the existing audit trails: forced-land
 * and validator-override are compliance-auditable records (src/compliance.ts) and must never
 * silently drop; the guard exists here for the next append-only ledger that is NOT an audit trail.
 */

import path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";

/** Read + parse a ledger file. Missing/unreadable/corrupt ⇒ `undefined`, never a throw. */
function readLedgerFile(stateDir: string, fileName: string): unknown {
	try {
		const file = path.join(stateDir, fileName);
		const b = getStorageBackend();
		if (!b.exists(file)) return undefined;
		const raw = b.readTextSync(file);
		if (raw === undefined) return undefined;
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** Durable, atomic, best-effort write — a disk failure never propagates to the caller. */
function writeLedgerFile(stateDir: string, fileName: string, serialized: string): void {
	try {
		getStorageBackend().writeDurableSync(path.join(stateDir, fileName), serialized);
	} catch {
		/* best-effort: the operation being recorded must never break on a disk failure */
	}
}

const defaultDecodeIds = (raw: unknown): readonly string[] =>
	Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

export interface SetLedger {
	has(id: string): boolean;
	/** Add every id not already present; ONE durable write when anything changed. */
	add(...ids: string[]): void;
	/** Remove an id; a no-op (no write) when absent. */
	delete(id: string): void;
}

/** Cached id-set ledger over a sorted-JSON-array file, eagerly loaded once at open. `decode` lets
 *  a declarer supply a real Schema decode for its trust boundary (removed-ledger does). */
export function openSetLedger(stateDir: string, fileName: string, decode: (raw: unknown) => readonly string[] = defaultDecodeIds): SetLedger {
	let ids: Set<string>;
	try {
		ids = new Set(decode(readLedgerFile(stateDir, fileName)));
	} catch {
		ids = new Set();
	}
	const persist = (): void => writeLedgerFile(stateDir, fileName, JSON.stringify([...ids].sort()));
	return {
		has: (id) => ids.has(id),
		add(...toAdd) {
			let changed = false;
			for (const id of toAdd) {
				if (!id || ids.has(id)) continue;
				ids.add(id);
				changed = true;
			}
			if (changed) persist();
		},
		delete(id) {
			if (!ids.delete(id)) return;
			persist();
		},
	};
}

const decodeRecord = <T>(raw: unknown): Record<string, T> =>
	raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, T>) : {};

export interface MapLedger<T> {
	get(key: string): T | undefined;
	/** Set the key and durably write. Conditional policies (first-wins etc.) belong to the caller,
	 *  built from `get` + `put`. */
	put(key: string, value: T): void;
}

/** Cached key→record ledger, eagerly loaded once at open (single-writer contexts only). */
export function openMapLedger<T>(stateDir: string, fileName: string): MapLedger<T> {
	const all = decodeRecord<T>(readLedgerFile(stateDir, fileName));
	return {
		get: (key) => all[key],
		put(key, value) {
			all[key] = value;
			writeLedgerFile(stateDir, fileName, JSON.stringify(all));
		},
	};
}

export interface MapFile<T> {
	/** Fresh read every call — for ledgers whose readers/writers span module cadences. */
	read(): Record<string, T>;
	write(all: Record<string, T>): void;
}

/** UNcached key→record accessor: read-modify-write per call (the land-failures idiom — the
 *  manager is single-writer single-event-loop, so per-call freshness beats a cache other readers
 *  would race). */
export function mapFile<T>(stateDir: string, fileName: string): MapFile<T> {
	return {
		read: () => decodeRecord<T>(readLedgerFile(stateDir, fileName)),
		write: (all) => writeLedgerFile(stateDir, fileName, JSON.stringify(all)),
	};
}

export interface ListFileOptions {
	/** Retention guard (FIELD-1): drop-oldest above this many entries… */
	maxEntries?: number;
	/** …but never retain fewer than this many (the floor beats the cap on conflict). */
	minRetained?: number;
}

export interface ListFile<T> {
	/** Every entry, oldest first. Corrupt/missing ⇒ empty. */
	read(): T[];
	/** Append one entry (read-modify-write, durable). Returns the new entry count. */
	append(entry: T): number;
}

/** UNcached append-only list. Retention is opt-in and floor-guarded; audit trails must not use it. */
export function listFile<T>(stateDir: string, fileName: string, opts: ListFileOptions = {}): ListFile<T> {
	const read = (): T[] => {
		const raw = readLedgerFile(stateDir, fileName);
		return Array.isArray(raw) ? (raw as T[]) : [];
	};
	return {
		read,
		append(entry) {
			let list = read();
			list.push(entry);
			const floor = Math.max(opts.minRetained ?? 0, 0);
			if (opts.maxEntries !== undefined && list.length > Math.max(opts.maxEntries, floor)) {
				list = list.slice(list.length - Math.max(opts.maxEntries, floor));
			}
			writeLedgerFile(stateDir, fileName, JSON.stringify(list));
			return list.length;
		},
	};
}
