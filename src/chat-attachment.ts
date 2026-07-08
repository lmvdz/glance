/**
 * Chat-message image attachments (Feature 2 D2, plans/orchestration/CANVAS-AND-PAGE-CHAT.md —
 * paste/drop/capture/annotate images into the agent conversation).
 *
 * Transport decision (D2/D5, investigated live): neither `/api/console`'s `ConsoleBodySchema` nor
 * the interactive prompt path (`{type:"prompt", message}` in client-command.ts) carries an image
 * channel — a chat turn is, and stays, plain text. Rather than widen that wire schema for a binary
 * payload (bloat + no harness on the other end actually consumes an inline image today — the
 * daemon's own vision path, src/vision.ts, is a SEPARATE opt-in browser-driven capture, out of
 * scope here), an annotated PNG is persisted as a chat ARTIFACT under
 * `<stateDir>/chat-attachments/<uuid>.png` and referenced BY PATH in the outgoing prompt text,
 * fenced as untrusted data (mirrors digest.ts's `fenceUntrusted` convention — reused here, not
 * reimplemented). Same pattern P3's spawn-artifact plan reaches for independently (D3); this file
 * is the shared persistence primitive both call into via `SquadManager.saveChatAttachment`.
 *
 * Deliberately bypasses the `StorageBackend` seam (dal/storage.ts): that interface is UTF-8-string
 * durable *state* (roster, transcripts, receipts, digests) — not binary blobs — and
 * `ArchilStorageBackend` isn't provisioned yet regardless (see its own doc comment). Widening that
 * interface for one binary use case is a bigger, separate decision; this module's own small
 * atomic-write helper (mirroring `LocalStorageBackend.writeDurable`'s temp+rename+fsync shape)
 * covers today's only active backend without forcing that call.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { envBool, envInt } from "./config.ts";
import { fenceUntrusted } from "./digest.ts";

/** Server-side re-enforcement of the client's downscale ceiling (Composer.tsx /
 *  imageAttachment.ts): a modified or malicious client must not be able to smuggle an oversized
 *  blob onto state-dir disk just because it skipped the browser-side canvas re-encode. */
export const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4MB — Feature 2 D5

/** MEDIUM 1 (cross-lineage security review, post-merge follow-up): a per-file byte cap alone is an
 *  unbounded authenticated disk-fill — an operator can loop MAX_CHAT_ATTACHMENT_BYTES POSTs
 *  forever with no ceiling on the org's total chat-attachments footprint. This is the hard
 *  write-time cap: total on-disk bytes for one org's `<stateDir>/chat-attachments/`, checked
 *  BEFORE persisting a new file (never after) in `writeChatAttachment`. `envInt` so an operator
 *  can tune it per deployment without a code change; re-read on every call (not module-level) so
 *  it's live-adjustable and trivially testable. */
export function chatAttachmentQuotaBytes(): number {
	return envInt("OMP_SQUAD_CHAT_ATTACH_MAX_BYTES", 256 * 1024 * 1024); // 256MB/org default
}

/** MEDIUM 2 (cross-lineage security review, post-merge follow-up): the client
 *  (webapp/src/lib/imageAttachment.ts, `MAX_IMAGE_DIMENSION`) already downscales to this before
 *  ever POSTing — but that's a client-side courtesy, not a security boundary. A modified/malicious
 *  client can skip the canvas re-encode and hand us a small-BYTE, huge-DIMENSION PNG (e.g. a
 *  1x1-visible-area IHDR lying about a 50000x50000 canvas) — a decode/memory bomb the moment
 *  anything downstream (a browser `<img>`, a future vision pipeline) actually rasterizes it. The
 *  server must parse the real IHDR and enforce this itself; it must never trust the client's
 *  claim that it already downscaled. */
export function chatAttachmentMaxDimensionPx(): number {
	return envInt("OMP_SQUAD_CHAT_ATTACH_MAX_DIMENSION_PX", 2048);
}

/** Thrown when persisting a new attachment would push this org's chat-attachments dir over
 *  `chatAttachmentQuotaBytes()` (MEDIUM 1). `server.ts` maps this to a 413. */
export class ChatAttachmentQuotaExceededError extends Error {}

/** Thrown when a PNG's IHDR-declared dimensions exceed `chatAttachmentMaxDimensionPx()`, or its
 *  IHDR can't be parsed at all (MEDIUM 2). `server.ts` maps this to a 413 too — an unreadable or
 *  oversized IHDR is the same "reject before it costs us anything downstream" shape as the quota. */
export class ChatAttachmentDimensionError extends Error {}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_TYPE = Buffer.from("IHDR", "ascii");

/** Attachment ids are always server-minted (`randomUUID()`) — a client never supplies one, so the
 *  only place an attacker-controlled id reaches a filesystem path is the GET-by-id read route.
 *  This allowlist keeps that read from ever escaping `chatAttachmentDir` (traversal via `..` or an
 *  encoded separator). */
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export function isValidChatAttachmentId(id: string): boolean {
	return ID_RE.test(id) && !id.includes("..");
}

function chatAttachmentDir(stateDir: string): string {
	return path.join(stateDir, "chat-attachments");
}

export function chatAttachmentPath(stateDir: string, id: string): string {
	return path.join(chatAttachmentDir(stateDir), `${id}.png`);
}

export function isPngBuffer(buf: Buffer): boolean {
	return buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/** Parse the IHDR chunk's declared width/height straight off the bytes — never trust the client's
 *  claim that it already downscaled (MEDIUM 2). PNG layout: 8-byte signature, then the first
 *  chunk — 4-byte big-endian length, 4-byte type (must be "IHDR" in a well-formed PNG), then chunk
 *  data. IHDR's data starts at byte 16: a 4-byte big-endian width, then a 4-byte big-endian
 *  height. Returns `null` (never throws) for anything too short to hold an IHDR or whose first
 *  chunk isn't actually IHDR — the caller treats `null` the same as an oversized image: reject. */
export function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 24) return null;
	if (!buf.subarray(12, 16).equals(IHDR_TYPE)) return null;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return { width, height };
}

/** Sum of on-disk bytes (and file count) for one org's chat-attachments dir — the input to the
 *  write-time quota check (MEDIUM 1). Missing dir reads as empty (a fresh org has never uploaded
 *  anything yet), never as an error. Only counts `*.png` — `writeDurableBinary`'s `.tmp` siblings
 *  are transient and never left behind on the success path, but are excluded defensively either
 *  way so a crash mid-write can't inflate the count against the org. */
async function chatAttachmentDirUsage(dir: string): Promise<{ bytes: number; count: number }> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { bytes: 0, count: 0 };
		throw err;
	}
	let bytes = 0;
	let count = 0;
	await Promise.all(
		entries
			.filter((name) => name.endsWith(".png"))
			.map(async (name) => {
				const stat = await fs.stat(path.join(dir, name)).catch(() => undefined);
				if (stat) {
					bytes += stat.size;
					count += 1;
				}
			}),
	);
	return { bytes, count };
}

/**
 * Strict `data:image/png;base64,...` parse. Returns `null` (never throws) on any other mime,
 * malformed base64, an empty/oversized decoded buffer, or bytes that don't start with the PNG
 * magic number — the caller turns that into a single bounded 4xx, never a stack trace.
 */
export function decodeChatAttachmentDataUrl(dataUrl: string): Buffer | null {
	const m = /^data:image\/png;base64,([a-zA-Z0-9+/]+=*)$/.exec(dataUrl.trim());
	if (!m) return null;
	let buf: Buffer;
	try {
		buf = Buffer.from(m[1], "base64");
	} catch {
		return null;
	}
	if (buf.length === 0 || buf.length > MAX_CHAT_ATTACHMENT_BYTES) return null;
	if (!isPngBuffer(buf)) return null;
	return buf;
}

/** Atomic durable write (temp + rename + fsync) — the binary sibling of
 *  `LocalStorageBackend.writeDurable` (dal/storage.ts), which is UTF-8-string-only. Tolerates the
 *  same directory-fsync-unsupported codes that backend already tolerates (some FUSE mounts reject
 *  opening a dir for fsync; the file-bytes fsync above it still holds). */
async function writeDurableBinary(file: string, data: Buffer): Promise<void> {
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${file}.tmp`;
	try {
		const fh = await fs.open(tmp, "w");
		try {
			await fh.writeFile(data);
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
	try {
		const dfh = await fs.open(dir, "r");
		try {
			await dfh.sync();
		} finally {
			await dfh.close();
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code && !["EISDIR", "EINVAL", "EBADF", "EPERM", "ENOTSUP"].includes(code)) throw err;
	}
}

export interface SavedChatAttachment {
	id: string;
	/** Absolute path on the daemon's own filesystem — this is what gets fenced into the outgoing
	 *  prompt text (see `chatAttachmentPromptRef`); it is NOT a URL. */
	path: string;
}

/** Persist a validated `data:image/png;base64,...` payload under `stateDir`; throws a short,
 *  user-facing message (never a raw stack) when the payload fails validation, exceeds the
 *  server-side dimension cap (`ChatAttachmentDimensionError`, MEDIUM 2), or would push this org's
 *  chat-attachments dir over its total-bytes quota (`ChatAttachmentQuotaExceededError`, MEDIUM 1).
 *  Both new checks run BEFORE anything touches disk — a rejected upload writes nothing. */
export async function writeChatAttachment(stateDir: string, dataUrl: string): Promise<SavedChatAttachment> {
	const buf = decodeChatAttachmentDataUrl(dataUrl);
	if (!buf) throw new Error(`invalid chat attachment: expected a data:image/png;base64,... payload under ${MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)}MB`);

	// MEDIUM 2: reject a decode bomb (small bytes, huge IHDR-declared dimensions) before it ever
	// reaches disk or anything downstream that would rasterize it.
	const maxDim = chatAttachmentMaxDimensionPx();
	const dims = readPngDimensions(buf);
	if (!dims) throw new ChatAttachmentDimensionError("invalid chat attachment: could not read PNG dimensions (malformed IHDR)");
	if (dims.width > maxDim || dims.height > maxDim) {
		throw new ChatAttachmentDimensionError(`invalid chat attachment: ${dims.width}x${dims.height} exceeds the ${maxDim}px server-side dimension cap`);
	}

	// MEDIUM 1: reject once this org's chat-attachments dir would exceed its total-bytes quota.
	// Checked against the CURRENT on-disk total, not a cached counter, so it stays correct across
	// daemon restarts and concurrent managers without any extra bookkeeping to keep in sync.
	const dir = chatAttachmentDir(stateDir);
	const usage = await chatAttachmentDirUsage(dir);
	const capBytes = chatAttachmentQuotaBytes();
	if (usage.bytes + buf.length > capBytes) {
		throw new ChatAttachmentQuotaExceededError(
			`chat attachment quota exceeded: this org's chat-attachments dir is already ${usage.bytes} of ${capBytes} bytes (${usage.count} file(s)); rejecting a further ${buf.length}-byte upload`,
		);
	}

	const id = randomUUID();
	const file = chatAttachmentPath(stateDir, id);
	await writeDurableBinary(file, buf);
	return { id, path: file };
}

/** Read a previously-saved attachment back, or `undefined` if missing / the id fails the
 *  allowlist (see `isValidChatAttachmentId`) — the GET route 404s on either, never leaking the
 *  distinction between "bad id" and "no such attachment". */
export async function readChatAttachment(stateDir: string, id: string): Promise<Buffer | undefined> {
	if (!isValidChatAttachmentId(id)) return undefined;
	try {
		return await fs.readFile(chatAttachmentPath(stateDir, id));
	} catch {
		return undefined;
	}
}

/** The fenced-untrusted-data reference line folded into the outgoing prompt text (Feature 2 D2/D5):
 *  the image rides the message as a PATH, never inline bytes — reuses `digest.ts`'s
 *  `fenceUntrusted` wrapper so every injected artifact in this codebase reads the same way. */
export function chatAttachmentPromptRef(filePath: string): string {
	return fenceUntrusted("attached image", `Image artifact saved at: ${filePath}`);
}

/** MEDIUM 1 follow-up (bonus hygiene, security review): age-based sweep of the chat-attachments
 *  dir, mirroring how `SquadManager`'s janitor reaps stale worktrees (`reapDeadWorktrees` —
 *  env-disable switch, `envInt` TTL, tolerant of a missing dir). This is NOT the hard ceiling —
 *  `chatAttachmentQuotaBytes()`'s write-time check in `writeChatAttachment` is the required bound
 *  and holds even with the sweep disabled — this is opportunistic cleanup of attachments old
 *  enough that no live conversation should still reference them (the fenced prompt-path reference
 *  is only ever read by the harness immediately after send; nothing re-reads an old attachment by
 *  path days later). Returns the ids it removed, for the caller's log line. */
export async function reapStaleChatAttachments(stateDir: string): Promise<string[]> {
	if (!envBool("OMP_SQUAD_CHAT_ATTACH_REAP", true)) return [];
	const ttlMs = envInt("OMP_SQUAD_CHAT_ATTACH_TTL_MS", 30 * 24 * 60 * 60 * 1000); // 30 days
	const dir = chatAttachmentDir(stateDir);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		throw err;
	}
	const now = Date.now();
	const reaped: string[] = [];
	await Promise.all(
		entries
			.filter((name) => name.endsWith(".png"))
			.map(async (name) => {
				const file = path.join(dir, name);
				const stat = await fs.stat(file).catch(() => undefined);
				if (stat && now - stat.mtimeMs > ttlMs) {
					await fs.rm(file, { force: true }).catch(() => {});
					reaped.push(name.slice(0, -".png".length));
				}
			}),
	);
	return reaped;
}
