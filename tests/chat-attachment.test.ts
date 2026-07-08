/**
 * Chat-message image attachments (Feature 2 D2, CANVAS-AND-PAGE-CHAT.md) — src/chat-attachment.ts's
 * pure decode/validate helpers, SquadManager's save/read round trip (org-scoped by stateDir), and
 * the REST surface's authz (default gate: POST ⇒ operator, GET ⇒ viewer; see src/authz.ts).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ChatAttachmentDimensionError,
	ChatAttachmentQuotaExceededError,
	chatAttachmentPath,
	chatAttachmentPromptRef,
	decodeChatAttachmentDataUrl,
	isPngBuffer,
	isValidChatAttachmentId,
	MAX_CHAT_ATTACHMENT_BYTES,
	readChatAttachment,
	readPngDimensions,
	reapStaleChatAttachments,
	writeChatAttachment,
} from "../src/chat-attachment.ts";
import { restActionTier } from "../src/authz.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

// 1x1 transparent PNG, base64-encoded — a real, minimal, valid PNG payload for round-trip tests.
const TINY_PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

/** Builds a minimal-BYTE PNG with an attacker-chosen IHDR-declared width/height — a "decode bomb"
 *  fixture (MEDIUM 2): the byte-length cap and the PNG-magic check both pass fine on this, since
 *  neither of them ever looks past the signature + the 8 IHDR-dimension bytes. Only
 *  `readPngDimensions`/`writeChatAttachment`'s new IHDR parse catches it. */
function fakePngWithDimensions(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(13, 0); // IHDR's data is always 13 bytes in a real PNG
	const type = Buffer.from("IHDR", "ascii");
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	// bit depth / color type / compression / filter / interlace bytes (8..12) left as 0 — irrelevant
	// to dimension parsing, which only reads bytes 16..23 (offsets 16 within the whole buffer).
	const crc = Buffer.alloc(4); // bogus CRC — readPngDimensions never checks it
	return Buffer.concat([sig, len, type, data, crc]);
}

function fakePngDataUrl(width: number, height: number): string {
	return `data:image/png;base64,${fakePngWithDimensions(width, height).toString("base64")}`;
}

/** Sets one or more env vars for the duration of a test and restores the prior values afterward —
 *  used for `OMP_SQUAD_CHAT_ATTACH_*` knobs so a test's override never leaks into a sibling test. */
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): () => Promise<void> {
	return async () => {
		const prior: Record<string, string | undefined> = {};
		for (const k of Object.keys(vars)) prior[k] = process.env[k];
		for (const [k, v] of Object.entries(vars)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			await fn();
		} finally {
			for (const [k, v] of Object.entries(prior)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Pure decode/validate helpers
// ---------------------------------------------------------------------------

test("isPngBuffer: true for the PNG magic number, false for anything else", () => {
	expect(isPngBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))).toBe(true);
	expect(isPngBuffer(Buffer.from("not a png"))).toBe(false);
	expect(isPngBuffer(Buffer.alloc(0))).toBe(false);
});

test("decodeChatAttachmentDataUrl: accepts a well-formed PNG data URL", () => {
	const buf = decodeChatAttachmentDataUrl(TINY_PNG_DATA_URL);
	expect(buf).not.toBeNull();
	expect(isPngBuffer(buf!)).toBe(true);
});

test("decodeChatAttachmentDataUrl: rejects a non-PNG mime, malformed base64, and non-PNG bytes", () => {
	expect(decodeChatAttachmentDataUrl("data:image/jpeg;base64,/9j/4AAQ")).toBeNull(); // wrong mime
	expect(decodeChatAttachmentDataUrl("not a data url at all")).toBeNull();
	expect(decodeChatAttachmentDataUrl("data:image/png;base64,not!!valid!!base64")).toBeNull();
	// valid base64, but the decoded bytes aren't a PNG (no magic number) — plain text smuggled in.
	const fakeBuf = Buffer.from("hello world, not a png").toString("base64");
	expect(decodeChatAttachmentDataUrl(`data:image/png;base64,${fakeBuf}`)).toBeNull();
});

test("decodeChatAttachmentDataUrl: rejects a payload over the size cap", () => {
	// A real PNG signature followed by enough padding bytes to blow the cap.
	const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_CHAT_ATTACHMENT_BYTES + 1)]);
	const dataUrl = `data:image/png;base64,${oversized.toString("base64")}`;
	expect(decodeChatAttachmentDataUrl(dataUrl)).toBeNull();
});

test("readPngDimensions: parses a real IHDR, rejects a too-short buffer or a non-IHDR first chunk", () => {
	expect(readPngDimensions(fakePngWithDimensions(1920, 1080))).toEqual({ width: 1920, height: 1080 });
	expect(readPngDimensions(fakePngWithDimensions(50_000, 50_000))).toEqual({ width: 50_000, height: 50_000 });
	expect(readPngDimensions(Buffer.alloc(23))).toBeNull(); // one byte short of IHDR's data even starting
	const notIhdr = fakePngWithDimensions(100, 100);
	notIhdr.write("JUNK", 12, "ascii"); // corrupt the chunk-type field
	expect(readPngDimensions(notIhdr)).toBeNull();
});

test("isValidChatAttachmentId: accepts a UUID shape, rejects traversal / garbage", () => {
	expect(isValidChatAttachmentId("3fa2c1e0-9b1a-4c2d-8e3f-1a2b3c4d5e6f")).toBe(true);
	expect(isValidChatAttachmentId("../../etc/passwd")).toBe(false);
	expect(isValidChatAttachmentId("..")).toBe(false);
	expect(isValidChatAttachmentId("short")).toBe(false);
	expect(isValidChatAttachmentId("has/slash")).toBe(false);
});

test("chatAttachmentPath: joins under a chat-attachments/ subdir, never escapes it for a bad id", () => {
	const p = chatAttachmentPath("/state", "3fa2c1e0-9b1a-4c2d-8e3f-1a2b3c4d5e6f");
	expect(p).toBe(path.join("/state", "chat-attachments", "3fa2c1e0-9b1a-4c2d-8e3f-1a2b3c4d5e6f.png"));
});

test("chatAttachmentPromptRef: fences the path as untrusted data (same convention as digest.ts)", () => {
	const ref = chatAttachmentPromptRef("/state/chat-attachments/abc.png");
	expect(ref).toContain("untrusted data");
	expect(ref).toContain("/state/chat-attachments/abc.png");
	expect(ref).toMatch(/BEGIN attached image/);
	expect(ref).toMatch(/END attached image/);
});

// ---------------------------------------------------------------------------
// Save/read round trip (direct module + through SquadManager)
// ---------------------------------------------------------------------------

test("writeChatAttachment + readChatAttachment: round-trips real PNG bytes durably", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

	const saved = await writeChatAttachment(dir, TINY_PNG_DATA_URL);
	expect(saved.path).toBe(chatAttachmentPath(dir, saved.id));
	const onDisk = await fs.readFile(saved.path);
	expect(isPngBuffer(onDisk)).toBe(true);

	const readBack = await readChatAttachment(dir, saved.id);
	expect(readBack).toEqual(onDisk);
});

test("writeChatAttachment: throws a short message (not a raw stack) on an invalid payload", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-bad-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	await expect(writeChatAttachment(dir, "not a data url")).rejects.toThrow(/invalid chat attachment/);
});

// MEDIUM 2 (security review): a small-bytes/huge-IHDR-dimension PNG is a decode bomb — the
// client's ≤2048px downscale is a courtesy, not a boundary. Red-first: before this fix,
// `writeChatAttachment` only checked magic bytes + total length, so this fixture (well under the
// 4MB cap, and correctly PNG-magic-prefixed) sailed straight through and got persisted to disk.
test("writeChatAttachment: rejects a small-bytes/huge-dimension PNG (decode bomb) — nothing is persisted", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-bomb-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

	await expect(writeChatAttachment(dir, fakePngDataUrl(50_000, 50_000))).rejects.toThrow(ChatAttachmentDimensionError);
	await expect(writeChatAttachment(dir, fakePngDataUrl(50_000, 50_000))).rejects.toThrow(/exceeds the 2048px/);
	// Only one dimension over the cap is enough to reject.
	await expect(writeChatAttachment(dir, fakePngDataUrl(2049, 100))).rejects.toThrow(ChatAttachmentDimensionError);
	// At-the-cap and under-the-cap both still succeed.
	await expect(writeChatAttachment(dir, fakePngDataUrl(2048, 2048))).resolves.toBeDefined();

	// Nothing from the rejected uploads made it to disk — only the one accepted 2048x2048 file.
	const onDisk = await fs.readdir(path.join(dir, "chat-attachments"));
	expect(onDisk.length).toBe(1);
});

test(
	"writeChatAttachment: OMP_SQUAD_CHAT_ATTACH_MAX_DIMENSION_PX is tunable",
	withEnv({ OMP_SQUAD_CHAT_ATTACH_MAX_DIMENSION_PX: "64" }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-dim-env-"));
		cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
		await expect(writeChatAttachment(dir, fakePngDataUrl(65, 65))).rejects.toThrow(/exceeds the 64px/);
		await expect(writeChatAttachment(dir, fakePngDataUrl(64, 64))).resolves.toBeDefined();
	}),
);

// MEDIUM 1 (security review): unbounded authenticated disk-fill. Red-first: before this fix,
// `writeChatAttachment` had no per-org total — a caller could loop uploads forever with only the
// 4MB-per-file cap in the way. This drives the org cap down to a handful of tiny-PNG multiples so
// the test doesn't need megabytes of fixture data, and proves the write-time check fires BEFORE
// the over-cap file ever touches disk (the directory's file count never exceeds what fit).
test("writeChatAttachment: rejects once the org's total on-disk bytes would exceed the quota — disk never written past the cap", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-quota-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

	const first = await writeChatAttachment(dir, TINY_PNG_DATA_URL);
	const oneFileBytes = (await fs.stat(first.path)).size;
	process.env.OMP_SQUAD_CHAT_ATTACH_MAX_BYTES = String(oneFileBytes); // cap = exactly what's already on disk
	cleanups.push(() => {
		delete process.env.OMP_SQUAD_CHAT_ATTACH_MAX_BYTES;
	});

	await expect(writeChatAttachment(dir, TINY_PNG_DATA_URL)).rejects.toThrow(ChatAttachmentQuotaExceededError);
	await expect(writeChatAttachment(dir, TINY_PNG_DATA_URL)).rejects.toThrow(/quota exceeded/);

	const onDisk = await fs.readdir(path.join(dir, "chat-attachments"));
	expect(onDisk.length).toBe(1); // the rejected uploads never made it to disk
});

test("writeChatAttachment: a cap large enough for N files lets exactly N through, then rejects", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-quota-n-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const one = await writeChatAttachment(dir, TINY_PNG_DATA_URL);
	const oneFileBytes = (await fs.stat(one.path)).size;
	process.env.OMP_SQUAD_CHAT_ATTACH_MAX_BYTES = String(oneFileBytes * 3); // room for 2 more
	cleanups.push(() => {
		delete process.env.OMP_SQUAD_CHAT_ATTACH_MAX_BYTES;
	});

	await writeChatAttachment(dir, TINY_PNG_DATA_URL); // #2 — fits
	await writeChatAttachment(dir, TINY_PNG_DATA_URL); // #3 — fits exactly
	await expect(writeChatAttachment(dir, TINY_PNG_DATA_URL)).rejects.toThrow(ChatAttachmentQuotaExceededError); // #4 — over

	const onDisk = await fs.readdir(path.join(dir, "chat-attachments"));
	expect(onDisk.length).toBe(3);
});

test("readChatAttachment: undefined for a missing id or a malformed one (never throws)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-miss-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	expect(await readChatAttachment(dir, "3fa2c1e0-9b1a-4c2d-8e3f-1a2b3c4d5e6f")).toBeUndefined();
	expect(await readChatAttachment(dir, "../../etc/passwd")).toBeUndefined();
});

test("SquadManager.saveChatAttachment/getChatAttachment: org-scoped to this manager's own stateDir", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-mgr-"));
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	cleanups.push(async () => {
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const saved = await mgr.saveChatAttachment(TINY_PNG_DATA_URL);
	expect(saved.path.startsWith(dir)).toBe(true);
	const bytes = await mgr.getChatAttachment(saved.id);
	expect(bytes && isPngBuffer(bytes)).toBe(true);
	expect(await mgr.getChatAttachment("00000000-0000-0000-0000-000000000000")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// REST surface: authz (default gate) + org-scoping through the live server
// ---------------------------------------------------------------------------

test("restActionTier: POST /api/chat-attachments is operator (default mutation tier), GET is viewer (default read tier)", () => {
	expect(restActionTier("POST", "/api/chat-attachments")).toBe("operator");
	expect(restActionTier("GET", "/api/chat-attachments/abc")).toBe("viewer");
});

test("REST /api/chat-attachments: viewer 403 on POST, operator+admin can upload and read their own back", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-srv-"));
	const tokens = { admin: "admin-token-xxxxxxxx", operator: "operator-token-xxxxxx", viewer: "viewer-token-xxxxxxxx" };
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token: tokens.admin, roleTokens: { operator: tokens.operator, viewer: tokens.viewer } });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const headers = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
	const upload = (t: string) =>
		fetch(`${url}/api/chat-attachments`, { method: "POST", headers: headers(t), body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL }) });

	// Viewer is stopped at the single REST gate (mutation ⇒ operator).
	expect((await upload(tokens.viewer)).status).toBe(403);

	// Operator clears the gate, uploads, and can read its own attachment straight back.
	const opRes = await upload(tokens.operator);
	expect(opRes.status).toBe(200);
	const { id } = (await opRes.json()) as { id: string; path: string };
	const readRes = await fetch(`${url}/api/chat-attachments/${id}`, { headers: headers(tokens.viewer) });
	expect(readRes.status).toBe(200);
	expect(readRes.headers.get("content-type")).toBe("image/png");
	expect(isPngBuffer(Buffer.from(await readRes.arrayBuffer()))).toBe(true);

	// Admin can upload too (operator ⊂ admin).
	expect((await upload(tokens.admin)).status).toBe(200);

	// A malformed body 400s (bounded message, not a 500).
	const bad = await fetch(`${url}/api/chat-attachments`, { method: "POST", headers: headers(tokens.operator), body: JSON.stringify({ dataUrl: "garbage" }) });
	expect(bad.status).toBe(400);

	// An unknown id 404s.
	const missing = await fetch(`${url}/api/chat-attachments/00000000-0000-0000-0000-000000000000`, { headers: headers(tokens.viewer) });
	expect(missing.status).toBe(404);
});

// MEDIUM 2 through the real HTTP route (not just the module-level unit test above) — the decode
// bomb has to be rejected wherever the operator/admin token actually posts it.
test("REST POST /api/chat-attachments: a small-bytes/huge-dimension PNG 413s — never reaches disk", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-srv-bomb-"));
	const token = "operator-token-bomb1x";
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token, roleTokens: {} });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const res = await fetch(`${url}/api/chat-attachments`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ dataUrl: fakePngDataUrl(60_000, 60_000) }),
	});
	expect(res.status).toBe(413);
	expect(await res.text()).toMatch(/exceeds the 2048px/);

	// Nothing was persisted — the dir either doesn't exist yet, or is empty.
	const onDisk = await fs.readdir(path.join(dir, "chat-attachments")).catch(() => []);
	expect(onDisk.length).toBe(0);
});

// MEDIUM 1 through the real HTTP route — an over-cap POST must 413, and the rejected bytes must
// never reach disk (the whole point of checking the quota BEFORE the write, not after).
test("REST POST /api/chat-attachments: an over-quota upload 413s — disk not written past the cap", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-srv-quota-"));
	const token = "operator-token-quota1x";
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token, roleTokens: {} });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const post = () =>
		fetch(`${url}/api/chat-attachments`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL }),
		});

	const first = await post();
	expect(first.status).toBe(200);
	const firstSaved = (await first.json()) as { id: string; path: string };
	const oneFileBytes = (await fs.stat(firstSaved.path)).size;
	process.env.OMP_SQUAD_CHAT_ATTACH_MAX_BYTES = String(oneFileBytes); // cap = exactly what's already on disk
	cleanups.push(() => {
		delete process.env.OMP_SQUAD_CHAT_ATTACH_MAX_BYTES;
	});

	const second = await post();
	expect(second.status).toBe(413);
	expect(await second.text()).toMatch(/quota exceeded/);

	const onDisk = await fs.readdir(path.join(dir, "chat-attachments"));
	expect(onDisk.length).toBe(1); // the rejected second upload never landed on disk
});

// ---------------------------------------------------------------------------
// TTL sweep (bonus hygiene) — mirrors squad-manager's worktree/lease janitor shape
// ---------------------------------------------------------------------------

test("reapStaleChatAttachments: removes only attachments older than the TTL", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-ttl-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

	const fresh = await writeChatAttachment(dir, TINY_PNG_DATA_URL);
	const stale = await writeChatAttachment(dir, TINY_PNG_DATA_URL);
	// Backdate only the "stale" file's mtime well past a tiny TTL; leave "fresh" untouched.
	const longAgo = new Date(Date.now() - 60_000);
	await fs.utimes(stale.path, longAgo, longAgo);

	process.env.OMP_SQUAD_CHAT_ATTACH_TTL_MS = "1000"; // 1s — "stale" (60s old) is well past it, "fresh" isn't
	cleanups.push(() => {
		delete process.env.OMP_SQUAD_CHAT_ATTACH_TTL_MS;
	});

	const reaped = await reapStaleChatAttachments(dir);
	expect(reaped).toEqual([stale.id]);

	expect(await readChatAttachment(dir, stale.id)).toBeUndefined();
	expect(await readChatAttachment(dir, fresh.id)).not.toBeUndefined();
});

test("reapStaleChatAttachments: OMP_SQUAD_CHAT_ATTACH_REAP=0 disables the sweep entirely", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-ttl-off-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

	const saved = await writeChatAttachment(dir, TINY_PNG_DATA_URL);
	const longAgo = new Date(Date.now() - 60_000);
	await fs.utimes(saved.path, longAgo, longAgo);

	process.env.OMP_SQUAD_CHAT_ATTACH_TTL_MS = "1000";
	process.env.OMP_SQUAD_CHAT_ATTACH_REAP = "0";
	cleanups.push(() => {
		delete process.env.OMP_SQUAD_CHAT_ATTACH_TTL_MS;
		delete process.env.OMP_SQUAD_CHAT_ATTACH_REAP;
	});

	expect(await reapStaleChatAttachments(dir)).toEqual([]);
	expect(await readChatAttachment(dir, saved.id)).not.toBeUndefined();
});

test("reapStaleChatAttachments: a stateDir with no chat-attachments dir yet is a no-op, not a throw", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-attach-ttl-empty-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	expect(await reapStaleChatAttachments(dir)).toEqual([]);
});
