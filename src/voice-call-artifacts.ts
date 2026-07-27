/**
 * voice-call-artifacts.ts — immutable, room-owned artifact snapshots (concern 02).
 *
 * On a `ready` journal artifact record, the coordinator resolves the reported path BENEATH the
 * call's session root, rejects a symlink escape, and copies an immutable snapshot into daemon-owned
 * storage keyed by content hash — so a later worktree mutation, a cleanup, or the source file's
 * outright removal can never rewrite or delete what the room already witnessed. A copy failure
 * becomes a visible `failed` record, never a silently dropped or broken link.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";
import { errText } from "./err-text.ts";

export type ArtifactSnapshotStatus = "ready" | "failed" | "incomplete";

export interface ArtifactSnapshotRecord {
	id: string;
	channelId: string;
	callId: string;
	/** The path the journal reported, verbatim (pre-resolution) — kept for diagnosis even on rejection. */
	sourcePath: string;
	status: ArtifactSnapshotStatus;
	/** sha256 of the copied bytes. Absent when `status !== "ready"`. */
	contentHash?: string;
	/** How many times THIS logical artifact path has produced a new (different-hash) ready snapshot
	 *  for this call — 1 on first success, incremented only when the content actually changed. */
	revision?: number;
	/** Absolute path of the immutable, daemon-owned copy. Absent when `status !== "ready"`. */
	snapshotPath?: string;
	/** Set on `failed`/`incomplete` — a human-readable reason (symlink escape, ENOENT, copy error). */
	error?: string;
	copiedAt: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function narrowRecord(raw: unknown): ArtifactSnapshotRecord | undefined {
	if (!isPlainRecord(raw)) return undefined;
	const { id, channelId, callId, sourcePath, status, copiedAt } = raw;
	if (typeof id !== "string" || typeof channelId !== "string" || typeof callId !== "string") return undefined;
	if (typeof sourcePath !== "string" || typeof copiedAt !== "number") return undefined;
	if (status !== "ready" && status !== "failed" && status !== "incomplete") return undefined;
	const out: ArtifactSnapshotRecord = { id, channelId, callId, sourcePath, status, copiedAt };
	if (typeof raw.contentHash === "string") out.contentHash = raw.contentHash;
	if (typeof raw.revision === "number") out.revision = raw.revision;
	if (typeof raw.snapshotPath === "string") out.snapshotPath = raw.snapshotPath;
	if (typeof raw.error === "string") out.error = raw.error;
	return out;
}

function registryPath(stateDir: string, channelId: string): string {
	return path.join(stateDir, "voice-artifacts", `${channelId}.json`);
}

function loadRegistry(stateDir: string, channelId: string, log: (msg: string) => void): ArtifactSnapshotRecord[] {
	try {
		const raw = getStorageBackend().readTextSync(registryPath(stateDir, channelId));
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.map(narrowRecord).filter((r): r is ArtifactSnapshotRecord => !!r);
	} catch (err) {
		log(`voice-artifacts/${channelId}.json unreadable — starting empty: ${errText(err)}`);
		return [];
	}
}

/**
 * Resolves `candidate` beneath `sessionRoot`, following symlinks (`fs.realpath`), and rejects any
 * resolution that escapes the root. A candidate that does not exist at all is a distinct failure
 * (`enoent`) from a genuine symlink escape (`symlink-escape`) — both fail closed, but the caller (and
 * the record's own `error` text) should say which.
 */
export async function resolveWithinSessionRoot(sessionRoot: string, candidate: string): Promise<{ ok: true; realPath: string } | { ok: false; reason: "symlink-escape" | "enoent" | "error"; detail: string }> {
	const absolute = path.isAbsolute(candidate) ? candidate : path.join(sessionRoot, candidate);
	let realRoot: string;
	let realCandidate: string;
	try {
		realRoot = await fs.realpath(sessionRoot);
	} catch (err) {
		return { ok: false, reason: "error", detail: `session root unresolvable: ${errText(err)}` };
	}
	try {
		realCandidate = await fs.realpath(absolute);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "enoent", detail: `artifact path does not exist: ${absolute}` };
		return { ok: false, reason: "error", detail: errText(err) };
	}
	const relative = path.relative(realRoot, realCandidate);
	// A relative path starting with ".." (or an absolute one — a different drive/root on some
	// platforms) escaped the root. `relative === ""` means the candidate IS the root itself, which is
	// never a legitimate single-file artifact but is not an escape either; the caller's own
	// isFile check below rejects it for a different, more specific reason.
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return { ok: false, reason: "symlink-escape", detail: `${absolute} resolves outside session root ${sessionRoot} (${realCandidate})` };
	}
	return { ok: true, realPath: realCandidate };
}

export interface SnapshotInput {
	channelId: string;
	callId: string;
	sessionRoot: string;
	sourcePath: string;
}

export class ArtifactSnapshotStore {
	private readonly stateDir: string;
	private readonly log: (msg: string) => void;
	private readonly now: () => number;
	private readonly registries = new Map<string, ArtifactSnapshotRecord[]>();
	/** Highest revision seen per `${channelId}\0${callId}\0${sourcePath}` this process has recorded —
	 *  used to detect a content-hash change on a repeat `ready` for the same logical artifact path. */
	private readonly revisionByPath = new Map<string, { hash: string; revision: number }>();
	private idSeq = 0;

	constructor(stateDir: string, opts?: { log?: (msg: string) => void; now?: () => number }) {
		this.stateDir = stateDir;
		this.log = opts?.log ?? (() => {});
		this.now = opts?.now ?? Date.now;
	}

	private registryFor(channelId: string): ArtifactSnapshotRecord[] {
		let list = this.registries.get(channelId);
		if (!list) {
			list = loadRegistry(this.stateDir, channelId, this.log);
			for (const rec of list) {
				if (rec.status === "ready" && rec.contentHash && rec.revision !== undefined) {
					const key = `${rec.channelId}\0${rec.callId}\0${rec.sourcePath}`;
					const existing = this.revisionByPath.get(key);
					if (!existing || existing.revision < rec.revision) this.revisionByPath.set(key, { hash: rec.contentHash, revision: rec.revision });
				}
			}
			this.registries.set(channelId, list);
		}
		return list;
	}

	private persist(channelId: string): void {
		try {
			const list = this.registryFor(channelId);
			getStorageBackend().writeDurableSync(registryPath(this.stateDir, channelId), JSON.stringify(list));
		} catch (err) {
			this.log(`voice-artifacts/${channelId}.json write failed: ${errText(err)}`);
		}
	}

	list(channelId: string): ArtifactSnapshotRecord[] {
		return [...this.registryFor(channelId)];
	}

	/**
	 * Snapshot one `ready` journal artifact record. Never throws — every failure mode (symlink
	 * escape, missing source, a copy that errors mid-write) is recorded as a visible `failed` (or
	 * `incomplete`) row rather than a dropped promise or a broken link.
	 */
	async snapshotReady(input: SnapshotInput): Promise<ArtifactSnapshotRecord> {
		const id = `art-${++this.idSeq}-${this.now().toString(36)}`;
		const base: Pick<ArtifactSnapshotRecord, "id" | "channelId" | "callId" | "sourcePath" | "copiedAt"> = {
			id,
			channelId: input.channelId,
			callId: input.callId,
			sourcePath: input.sourcePath,
			copiedAt: this.now(),
		};
		const resolved = await resolveWithinSessionRoot(input.sessionRoot, input.sourcePath);
		if (!resolved.ok) {
			const record: ArtifactSnapshotRecord = { ...base, status: "failed", error: `${resolved.reason}: ${resolved.detail}` };
			this.record(record);
			return record;
		}
		let stat: import("node:fs").Stats;
		try {
			stat = await fs.stat(resolved.realPath);
		} catch (err) {
			const record: ArtifactSnapshotRecord = { ...base, status: "failed", error: `stat failed: ${errText(err)}` };
			this.record(record);
			return record;
		}
		if (!stat.isFile()) {
			const record: ArtifactSnapshotRecord = { ...base, status: "failed", error: "resolved path is not a regular file" };
			this.record(record);
			return record;
		}
		let bytes: Buffer;
		try {
			bytes = await fs.readFile(resolved.realPath);
		} catch (err) {
			const record: ArtifactSnapshotRecord = { ...base, status: "failed", error: `read failed: ${errText(err)}` };
			this.record(record);
			return record;
		}
		const contentHash = createHash("sha256").update(bytes).digest("hex");
		const key = `${input.channelId}\0${input.callId}\0${input.sourcePath}`;
		const priorRevision = this.revisionByPath.get(key);
		if (priorRevision && priorRevision.hash === contentHash) {
			// Byte-identical to the last recorded revision — the source was re-announced (or re-read)
			// unchanged. Not a new revision; return the existing ready record's shape rather than
			// writing (and hashing a copy of) a duplicate file.
			const revision = priorRevision.revision;
			const snapshotDir = this.snapshotDir(input.channelId, input.callId, contentHash);
			const snapshotPath = path.join(snapshotDir, path.basename(resolved.realPath));
			const record: ArtifactSnapshotRecord = { ...base, status: "ready", contentHash, revision, snapshotPath };
			this.record(record);
			return record;
		}
		const revision = (priorRevision?.revision ?? 0) + 1;
		const snapshotDir = this.snapshotDir(input.channelId, input.callId, contentHash);
		const snapshotPath = path.join(snapshotDir, path.basename(resolved.realPath));
		try {
			await fs.mkdir(snapshotDir, { recursive: true });
			// Hash-addressed destination: a byte-identical re-copy is a harmless overwrite-with-the-
			// same-bytes; a DIFFERENT source now hashing to the same address is cryptographically not
			// going to happen, so this is immutable in practice — the OLD hash's bytes are never
			// rewritten because nothing ever writes to that address with different content.
			await fs.writeFile(snapshotPath, bytes, { mode: 0o444 });
		} catch (err) {
			const record: ArtifactSnapshotRecord = { ...base, status: "failed", error: `snapshot copy failed: ${errText(err)}` };
			this.record(record);
			return record;
		}
		this.revisionByPath.set(key, { hash: contentHash, revision });
		const record: ArtifactSnapshotRecord = { ...base, status: "ready", contentHash, revision, snapshotPath };
		this.record(record);
		return record;
	}

	/** A journal artifact record that itself reported `failed` — recorded verbatim, never silently dropped. */
	recordFailed(input: SnapshotInput, reason: string): ArtifactSnapshotRecord {
		const record: ArtifactSnapshotRecord = {
			id: `art-${++this.idSeq}-${this.now().toString(36)}`,
			channelId: input.channelId,
			callId: input.callId,
			sourcePath: input.sourcePath,
			status: "failed",
			error: reason,
			copiedAt: this.now(),
		};
		this.record(record);
		return record;
	}

	/** Mark every `ready`-pending artifact for a call `incomplete` once the call ends without ever
	 *  confirming readiness — "unfinished artifacts converted to incomplete" (DESIGN.md risk table).
	 *  Only affects records this store never saw resolve to `ready`/`failed` for the given callId;
	 *  there is no such row today (every `snapshotReady`/`recordFailed` call is itself terminal), so
	 *  this is a hook for a future "artifact requested but call ended before its `ready` record
	 *  arrived" case — reserved and exercised by tests via `markPendingIncomplete` directly. */
	markPendingIncomplete(channelId: string, callId: string, sourcePath: string, reason: string): ArtifactSnapshotRecord {
		const record: ArtifactSnapshotRecord = {
			id: `art-${++this.idSeq}-${this.now().toString(36)}`,
			channelId,
			callId,
			sourcePath,
			status: "incomplete",
			error: reason,
			copiedAt: this.now(),
		};
		this.record(record);
		return record;
	}

	private snapshotDir(channelId: string, callId: string, contentHash: string): string {
		return path.join(this.stateDir, "voice-artifacts", channelId, callId, contentHash);
	}

	private record(entry: ArtifactSnapshotRecord): void {
		const list = this.registryFor(entry.channelId);
		list.push(entry);
		this.persist(entry.channelId);
	}
}
