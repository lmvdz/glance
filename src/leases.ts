/**
 * File leases — soft, advisory "I'm editing this file" claims so two agents
 * don't unknowingly edit the same file (the exact hazard that bit squad-manager.ts).
 *
 * A lease is keyed by (repo, repo-relative file) and held by a session. It is
 * NEVER a hard lock: the lease-hook records leases on edit and surfaces a ⚠ when
 * another holder already has the file; humans see contended files in the command
 * center. Collision-safe storage: one JSON file per lease under
 * ~/.omp/squad/leases/<repo-hash>/<lease-id>.json, heartbeat-TTL for staleness.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const LEASE_TTL_MS = 120_000;

const ROOT = path.join(os.homedir(), ".omp", "squad", "leases");

export interface LeaseEntry {
	id: string;
	repo: string;
	/** Repo-relative path being edited. */
	file: string;
	operator: string;
	/** Session/agent label holding the lease. */
	session: string;
	host: string;
	since: number;
	heartbeat: number;
}

export interface LeaseInput {
	repo: string;
	file: string;
	operator?: string;
	session: string;
}

function repoKey(repo: string): string {
	return createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
}

function dirFor(repo: string): string {
	return path.join(ROOT, repoKey(repo));
}

/** Stable lease id per (session, file) so re-editing the same file refreshes one entry. */
function leaseId(session: string, file: string): string {
	return createHash("sha1").update(`${session}\0${file}`).digest("hex").slice(0, 20);
}

function isLease(value: unknown): value is LeaseEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && typeof v.file === "string" && typeof v.session === "string" && typeof v.heartbeat === "number";
}

/** Claim or refresh a lease on a file. Returns the lease id. */
export async function claimLease(input: LeaseInput): Promise<string> {
	const id = leaseId(input.session, input.file);
	const now = Date.now();
	const dir = dirFor(input.repo);
	await fsp.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${id}.json`);
	let since = now;
	try {
		const prev: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
		if (isLease(prev)) since = prev.since;
	} catch {
		/* new lease */
	}
	const entry: LeaseEntry = {
		id,
		repo: path.resolve(input.repo),
		file: input.file,
		operator: input.operator ?? process.env.OMP_SQUAD_OPERATOR ?? os.userInfo().username ?? "unknown",
		session: input.session,
		host: os.hostname(),
		since,
		heartbeat: now,
	};
	await fsp.writeFile(file, JSON.stringify(entry));
	return id;
}

async function readDir(dir: string, ttlMs: number): Promise<LeaseEntry[]> {
	let names: string[];
	try {
		names = await fsp.readdir(dir);
	} catch {
		return [];
	}
	const cutoff = Date.now() - ttlMs;
	const live: LeaseEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const f = path.join(dir, name);
		try {
			const parsed: unknown = JSON.parse(await fsp.readFile(f, "utf8"));
			if (isLease(parsed) && parsed.heartbeat >= cutoff) live.push(parsed);
			else if (isLease(parsed)) await fsp.rm(f, { force: true }).catch(() => {});
		} catch {
			/* skip */
		}
	}
	return live;
}

/** Live leases on a repo. */
export async function leasesFor(repo: string, ttlMs = LEASE_TTL_MS): Promise<LeaseEntry[]> {
	return (await readDir(dirFor(repo), ttlMs)).sort((a, b) => a.file.localeCompare(b.file));
}

/** Other sessions currently leasing a specific file. */
export async function holdersOf(repo: string, file: string, session: string, ttlMs = LEASE_TTL_MS): Promise<LeaseEntry[]> {
	return (await leasesFor(repo, ttlMs)).filter((l) => l.file === file && l.session !== session);
}

export async function heartbeatSession(session: string, repo: string): Promise<void> {
	const now = Date.now();
	for (const l of await leasesFor(repo, LEASE_TTL_MS * 4)) {
		if (l.session !== session) continue;
		l.heartbeat = now;
		await fsp.writeFile(path.join(dirFor(repo), `${l.id}.json`), JSON.stringify(l)).catch(() => {});
	}
}

/** Release every lease held by a session (on shutdown). */
export async function releaseSession(session: string, repo: string): Promise<void> {
	for (const l of await leasesFor(repo, LEASE_TTL_MS * 8)) {
		if (l.session === session) await fsp.rm(path.join(dirFor(repo), `${l.id}.json`), { force: true }).catch(() => {});
	}
}
