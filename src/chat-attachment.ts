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
import { fenceUntrusted } from "./digest.ts";

/** Server-side re-enforcement of the client's downscale ceiling (Composer.tsx /
 *  imageAttachment.ts): a modified or malicious client must not be able to smuggle an oversized
 *  blob onto state-dir disk just because it skipped the browser-side canvas re-encode. */
export const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4MB — Feature 2 D5

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
 *  user-facing message (never a raw stack) when the payload fails validation. */
export async function writeChatAttachment(stateDir: string, dataUrl: string): Promise<SavedChatAttachment> {
	const buf = decodeChatAttachmentDataUrl(dataUrl);
	if (!buf) throw new Error(`invalid chat attachment: expected a data:image/png;base64,... payload under ${MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)}MB`);
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
