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
import * as os from "node:os";
import * as path from "node:path";
import { ttlRegistry } from "./ttl-registry.ts";

export const LEASE_TTL_MS = 120_000;

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

/** Stable lease id per (session, file) so re-editing the same file refreshes one entry. */
function leaseId(session: string, file: string): string {
	return createHash("sha1").update(`${session}\0${file}`).digest("hex").slice(0, 20);
}

function isLease(value: unknown): value is LeaseEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && typeof v.file === "string" && typeof v.session === "string" && typeof v.heartbeat === "number";
}

const reg = ttlRegistry<LeaseEntry>({ subdir: "leases", ttlMs: LEASE_TTL_MS, isRecord: isLease });

/** Remove leases dirs for repos/worktrees with no live lease (called periodically by the daemon). */
export function sweepLeases(): Promise<number> {
	return reg.sweep();
}

/** Claim or refresh a lease on a file. Returns the lease id. */
export async function claimLease(input: LeaseInput): Promise<string> {
	const id = leaseId(input.session, input.file);
	const now = Date.now();
	const prev = await reg.readOne(input.repo, id);
	const entry: LeaseEntry = {
		id,
		repo: path.resolve(input.repo),
		file: input.file,
		operator: input.operator ?? process.env.OMP_SQUAD_OPERATOR ?? os.userInfo().username ?? "unknown",
		session: input.session,
		host: os.hostname(),
		since: prev?.since ?? now,
		heartbeat: now,
	};
	await reg.write(input.repo, entry);
	return id;
}

/** Live leases on a repo. */
export async function leasesFor(repo: string, ttlMs = LEASE_TTL_MS): Promise<LeaseEntry[]> {
	return (await reg.readAll(repo, ttlMs)).sort((a, b) => a.file.localeCompare(b.file));
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
		await reg.write(repo, l).catch(() => {});
	}
}

/** Release every lease held by a session (on shutdown). */
export async function releaseSession(session: string, repo: string): Promise<void> {
	for (const l of await leasesFor(repo, LEASE_TTL_MS * 8)) {
		if (l.session === session) await reg.remove(repo, l.id);
	}
}

/**
 * Mirror a peer's lease into the LOCAL registry for `targetRepo`, preserving the
 * remote operator/host/session/heartbeat so `leasesFor`/`holdersOf` (and the
 * lease-hook + command center) surface cross-host holders. Keyed in a distinct id
 * space (host+session+file) so two machines with the same pid never collide, and
 * never touched by the local heartbeat/release loops. The TTL prunes it on its
 * own once the peer stops gossiping.
 */
export async function mirrorLease(targetRepo: string, entry: LeaseEntry): Promise<void> {
	const id = createHash("sha1").update(`mirror\0${entry.host}\0${entry.session}\0${entry.file}`).digest("hex").slice(0, 24);
	const mirrored: LeaseEntry = { ...entry, id, repo: path.resolve(targetRepo) };
	await reg.write(targetRepo, mirrored).catch(() => {});
}
