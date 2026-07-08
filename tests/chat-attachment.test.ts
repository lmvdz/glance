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
	chatAttachmentPath,
	chatAttachmentPromptRef,
	decodeChatAttachmentDataUrl,
	isPngBuffer,
	isValidChatAttachmentId,
	MAX_CHAT_ATTACHMENT_BYTES,
	readChatAttachment,
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
