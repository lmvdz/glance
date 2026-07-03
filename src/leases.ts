/**
 * File leases — soft, advisory "I'm editing this file" claims so two agents
 * don't unknowingly edit the same file (the exact hazard that bit squad-manager.ts).
 *
 * A lease is keyed by (repo, repo-relative file) and held by a session. It is
 * NEVER a hard lock: the lease-hook records leases on edit and surfaces a ⚠ when
 * another holder already has the file; humans see contended files in the command
 * center. Collision-safe storage: one JSON file per lease under
 * ~/.omp/squad/leases/<repo-hash>/<lease-id>.json, heartbeat-TTL for staleness.
 *
 * The on-disk repo bucket is keyed on the repo's CROSS-HOST identity (the
 * normalized git origin — see repo-identity.ts), NOT its host-local path. Two
 * checkouts of the same GitHub repo at different absolute paths therefore share
 * one lease bucket, so a mirrored peer lease (mirrorLease) lands in the same
 * registry the local lease-hook reads, and `holdersOf`/`leasesFor` surface
 * cross-host contention. The lease's own `repo` field stays the host-local path
 * for display; only the storage KEY is identity-based.
 */

import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { repoIdentity } from "./repo-identity.ts";
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

/**
 * The registry bucket key for a repo: its cross-host identity, not its path.
 * `repoIdentity` collapses every checkout of one origin to a single id, so the
 * underlying `repoKey(path.resolve(...))` hash is identical for the same logical
 * repo on a given host regardless of where it's checked out — and matches the key
 * a mirrored peer lease is stored under. Non-git / local-only repos fall back to
 * the per-path `name:<basename>` identity, which preserves the old per-path bucketing.
 */
function leaseKey(repo: string): string {
	return repoIdentity(repo);
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
	const key = leaseKey(input.repo);
	const now = Date.now();
	const prev = await reg.readOne(key, id);
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
	await reg.write(key, entry);
	return id;
}

/** Live leases on a repo (bucketed by cross-host identity). */
export async function leasesFor(repo: string, ttlMs = LEASE_TTL_MS): Promise<LeaseEntry[]> {
	return (await reg.readAll(leaseKey(repo), ttlMs)).sort((a, b) => a.file.localeCompare(b.file));
}

/** Other sessions currently leasing a specific file. */
export async function holdersOf(repo: string, file: string, session: string, ttlMs = LEASE_TTL_MS): Promise<LeaseEntry[]> {
	return (await leasesFor(repo, ttlMs)).filter((l) => l.file === file && l.session !== session);
}

export async function heartbeatSession(session: string, repo: string): Promise<void> {
	const key = leaseKey(repo);
	const now = Date.now();
	for (const l of await leasesFor(repo, LEASE_TTL_MS * 4)) {
		if (l.session !== session) continue;
		l.heartbeat = now;
		await reg.write(key, l).catch(() => {});
	}
}

/** Release every lease held by a session (on shutdown). */
export async function releaseSession(session: string, repo: string): Promise<void> {
	const key = leaseKey(repo);
	for (const l of await leasesFor(repo, LEASE_TTL_MS * 8)) {
		if (l.session === session) await reg.remove(key, l.id);
	}
}

/**
 * Mirror a peer's lease into the LOCAL registry for `targetRepo`, preserving the
 * remote operator/host/session/heartbeat so `leasesFor`/`holdersOf` (and the
 * lease-hook + command center) surface cross-host holders. The bucket is keyed on
 * `targetRepo`'s cross-host identity (same as `claimLease`), so the mirrored lease
 * lands in the very registry the local lease-hook reads for that repo — the whole
 * point of cross-host advisory leasing. Keyed in a distinct id space
 * (host+session+file) so two machines with the same pid never collide, and never
 * touched by the local heartbeat/release loops. The TTL prunes it on its own once
 * the peer stops gossiping.
 */
export async function mirrorLease(targetRepo: string, entry: LeaseEntry): Promise<void> {
	const id = createHash("sha1").update(`mirror\0${entry.host}\0${entry.session}\0${entry.file}`).digest("hex").slice(0, 24);
	const mirrored: LeaseEntry = { ...entry, id, repo: path.resolve(targetRepo) };
	await reg.write(leaseKey(targetRepo), mirrored).catch(() => {});
}
