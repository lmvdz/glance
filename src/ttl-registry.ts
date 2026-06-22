/**
 * Generic TTL claim registry — "one JSON file per claim under
 * ~/.omp/squad/<subdir>/<repoKey>/<id>.json, with a heartbeat timestamp and a
 * TTL". Backs both the presence registry (who's working on a repo) and the file
 * lease registry (who's editing a file). Storage layout is byte-compatible with
 * the two hand-rolled implementations it replaced, so other processes and the
 * web UI keep reading the same files.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Minimum shape every stored record must have: a file id and a heartbeat ts. */
export interface TtlRecord {
	id: string;
	heartbeat: number;
}

export interface TtlRegistryOptions<T extends TtlRecord> {
	/** Folder under ~/.omp/squad (e.g. "presence", "leases"). */
	subdir: string;
	/** Default freshness window in ms; entries older than this are stale. */
	ttlMs: number;
	/** Runtime guard so half-written / foreign JSON is skipped. */
	isRecord: (value: unknown) => value is T;
}

export interface TtlRegistry<T extends TtlRecord> {
	/** ~/.omp/squad/<subdir> — the per-repo folders live directly under it. */
	root: string;
	/** Absolute folder holding one repo's claim files. */
	dirFor(repo: string): string;
	/** mkdir -p + write <repoDir>/<entry.id>.json. Throws on IO error (callers add .catch where they swallow). */
	write(repo: string, entry: T): Promise<void>;
	/** Live records in an absolute claim dir; prunes ones past `ttlMs` as it reads. Unsorted. */
	read(dir: string, ttlMs: number): Promise<T[]>;
	/** One record by id, or undefined if missing/unreadable/foreign. */
	readOne(repo: string, id: string): Promise<T | undefined>;
	/** Live records for a repo (prune-on-read). Unsorted. */
	readAll(repo: string, ttlMs?: number): Promise<T[]>;
	/** Delete <repoDir>/<id>.json. Never throws. */
	remove(repo: string, id: string): Promise<void>;
}

/** Stable 16-hex key for a repo path. Must match the old hand-rolled key byte-for-byte. */
export function repoKey(repo: string): string {
	return createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
}

export function ttlRegistry<T extends TtlRecord>({ subdir, ttlMs, isRecord }: TtlRegistryOptions<T>): TtlRegistry<T> {
	const root = path.join(os.homedir(), ".omp", "squad", subdir);
	const dirFor = (repo: string): string => path.join(root, repoKey(repo));

	async function write(repo: string, entry: T): Promise<void> {
		const dir = dirFor(repo);
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(entry));
	}

	async function read(dir: string, ttl: number): Promise<T[]> {
		let names: string[];
		try {
			names = await fsp.readdir(dir);
		} catch {
			return [];
		}
		const cutoff = Date.now() - ttl;
		const live: T[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(dir, name);
			try {
				const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
				if (isRecord(parsed) && parsed.heartbeat >= cutoff) live.push(parsed);
				// ponytail: prune-on-read — a stale entry is deleted the first time any reader sees it past TTL; no background sweeper.
				else if (isRecord(parsed)) await fsp.rm(file, { force: true }).catch(() => {});
			} catch {
				/* skip unreadable / half-written */
			}
		}
		// ponytail: best-effort, last-writer-wins — a heartbeat landing mid-prune can race the rm; harmless at this scale, add per-file locks only if entry churn ever bites.
		return live;
	}

	async function readOne(repo: string, id: string): Promise<T | undefined> {
		try {
			const parsed: unknown = JSON.parse(await fsp.readFile(path.join(dirFor(repo), `${id}.json`), "utf8"));
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	return {
		root,
		dirFor,
		write,
		read,
		readOne,
		readAll: (repo, ttl = ttlMs) => read(dirFor(repo), ttl),
		remove: (repo, id) => fsp.rm(path.join(dirFor(repo), `${id}.json`), { force: true }).catch(() => {}),
	};
}
