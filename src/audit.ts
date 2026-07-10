/**
 * Append-only fleet-action audit log: every actor-initiated mutation
 * (create / prompt / answer / interrupt / kill / restart / remove / commission /
 * land) lands here as one JSONL line — actor, action, target, outcome. The
 * server exposes it at GET /api/audit and the web "Audit" view renders it.
 * Mirrors receipts.ts: Bun/Node stdlib only, no sqlite, no dependency.
 *
 * ponytail: append-only JSONL under <stateDir>/audit.jsonl. Cheap to append and
 * read in order. Ceiling: a full-file scan per read + no rotation/retention, so
 * a very long-lived daemon's log grows unbounded and reads go linear. Upgrade
 * path: move to the sqlite `audit` table (already in the DB schema) only if
 * cross-field queries or retention become a real need.
 */

import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";
import type { Actor, AuditEntry } from "./types.ts";

export function auditPath(baseDir: string): string {
	return path.join(baseDir, "audit.jsonl");
}

// Monotonic id even when several actions resolve in the same millisecond — the id
// is the stable sort + dedupe key, so it must strictly increase per process.
let lastId = 0;
export function nextAuditId(now = Date.now()): number {
	lastId = now > lastId ? now : lastId + 1;
	return lastId;
}

export interface AuditInput {
	/** Actor object (its `.id` is stored) or a raw actor id string. */
	actor: Actor | string;
	action: string;
	target?: string | null;
	outcome?: "ok" | "error";
	detail?: string;
	/** Optional provenance tag ("voice" | "composer", kept as an open string) — observability-only,
	 *  never consulted for authz/tier decisions. Contain-or-omit: absent when the caller didn't have one. */
	source?: string;
}

/** Stamp id + at, normalize the actor to its id, and default outcome to "ok". */
export function makeAuditEntry(input: AuditInput, now = Date.now()): AuditEntry {
	const actor = typeof input.actor === "string" ? input.actor : input.actor.id;
	const entry: AuditEntry = {
		id: nextAuditId(now),
		at: now,
		actor,
		action: input.action,
		target: input.target ?? null,
		outcome: input.outcome ?? "ok",
	};
	if (input.detail) entry.detail = input.detail;
	if (input.source !== undefined) entry.source = input.source;
	return entry;
}

export async function appendAudit(baseDir: string, entry: AuditEntry): Promise<void> {
	const file = auditPath(baseDir);
	await getStorageBackend().appendDurable(file, `${JSON.stringify(entry)}\n`);
}

export interface AuditQuery {
	/** Max entries returned (newest first). Default 200; <=0 ⇒ no cap. */
	limit?: number;
	/** Exact-match filters. */
	actor?: string;
	action?: string;
	target?: string;
}

/** Read the log newest-first, applying optional exact-match filters + a bounded limit. */
export async function readAudit(baseDir: string, q: AuditQuery = {}): Promise<AuditEntry[]> {
	const text = await getStorageBackend().readText(auditPath(baseDir));
	if (text === undefined) return [];
	const out: AuditEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: AuditEntry;
		try {
			e = JSON.parse(line) as AuditEntry;
		} catch {
			continue; // skip a torn/partial trailing line rather than throw
		}
		if (q.actor && e.actor !== q.actor) continue;
		if (q.action && e.action !== q.action) continue;
		if (q.target && e.target !== q.target) continue;
		out.push(e);
	}
	out.reverse();
	const limit = q.limit ?? 200;
	return limit > 0 ? out.slice(0, limit) : out;
}
