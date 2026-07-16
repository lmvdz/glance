/**
 * push — web-push crypto correctness (RFC vectors + round-trip) and dispatch wiring.
 */

import { afterEach, expect, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { completionPayload, encryptPayload, hkdf, PushService, type PushSend, type PushSubscription, vapidAuthHeader } from "../src/push.ts";
import type { AgentDTO, AgentStatus } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

test("hkdf matches RFC 5869 test case 1", () => {
	const ikm = Buffer.alloc(22, 0x0b);
	const salt = Buffer.from("000102030405060708090a0b0c", "hex");
	const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
	const okm = hkdf(salt, ikm, info, 42).toString("hex");
	expect(okm).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
});

// A browser subscription is a UA keypair; we hold only its public half. Build one we can decrypt with.
async function makeSubscription(): Promise<{ sub: PushSubscription; uaPrivate: CryptoKey; uaPublic: Buffer; auth: Buffer }> {
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const uaPublic = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
	return { sub: { endpoint: "https://push.example.com/x", keys: { p256dh: uaPublic.toString("base64url"), auth: auth.toString("base64url") } }, uaPrivate: kp.privateKey, uaPublic, auth };
}

// Reverse RFC 8291 to prove encryptPayload produced a decryptable message.
async function decrypt(body: Buffer, uaPrivate: CryptoKey, uaPublic: Buffer, auth: Buffer): Promise<string> {
	const salt = body.subarray(0, 16);
	const idlen = body.readUInt8(20);
	const asPublic = body.subarray(21, 21 + idlen);
	const ciphertext = body.subarray(21 + idlen);
	const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = Buffer.from(new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256)));
	const ikm = hkdf(auth, ecdhSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
	const tag = ciphertext.subarray(ciphertext.length - 16);
	const data = ciphertext.subarray(0, ciphertext.length - 16);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(tag);
	const record = Buffer.concat([decipher.update(data), decipher.final()]);
	return record.subarray(0, record.length - 1).toString("utf8"); // strip the 0x02 delimiter
}

test("encryptPayload produces an RFC 8291 message the recipient can decrypt", async () => {
	const { sub, uaPrivate, uaPublic, auth } = await makeSubscription();
	const plaintext = JSON.stringify({ title: "⛔ alpha needs you", body: "approve deploy?" });
	const body = await encryptPayload(sub, Buffer.from(plaintext));
	expect(body.length).toBeGreaterThan(21 + 65); // header + ciphertext
	expect(await decrypt(body, uaPrivate, uaPublic, auth)).toBe(plaintext);
});

test("vapidAuthHeader signs a verifiable ES256 JWT with the right audience", async () => {
	const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const rawPub = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
	const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
	const header = await vapidAuthHeader("https://push.example.com/abc/def", rawPub.toString("base64url"), jwk, "mailto:me@x.dev");

	const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
	expect(m).not.toBeNull();
	const [, jwt, k] = m as RegExpMatchArray;
	expect(k).toBe(rawPub.toString("base64url"));
	const [h, p, s] = jwt.split(".");
	const verifyKey = await crypto.subtle.importKey("raw", rawPub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, Buffer.from(s, "base64url"), Buffer.from(`${h}.${p}`));
	expect(ok).toBe(true);
	const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { aud: string; exp: number; sub: string };
	expect(claims.aud).toBe("https://push.example.com");
	expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test("PushService dispatches encrypted+authed posts and prunes gone endpoints", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const calls: Array<{ endpoint: string; headers: Record<string, string>; len: number }> = [];
	const gone = new Set<string>();
	const send: PushSend = async (endpoint, headers, body) => {
		calls.push({ endpoint, headers, len: body.length });
		return { status: gone.has(endpoint) ? 410 : 201 };
	};
	const svc = new PushService(dir, { send });
	await svc.init();
	expect(Buffer.from(svc.publicKey, "base64url").length).toBe(65); // valid VAPID public point

	const a = await makeSubscription();
	const b = await makeSubscription();
	await svc.subscribe({ ...a.sub, endpoint: "https://push.example.com/a" });
	await svc.subscribe({ ...b.sub, endpoint: "https://push.example.com/b" });

	const sent = await svc.notify({ title: "t", body: "x", url: "/#/queue", tag: "alpha" });
	expect(sent).toBe(2);
	expect(calls).toHaveLength(2);
	expect(calls[0].headers["content-encoding"]).toBe("aes128gcm");
	expect(calls[0].headers.authorization.startsWith("vapid t=")).toBe(true);
	expect(calls[0].len).toBeGreaterThan(80);

	// endpoint /b now gone → pruned after the next notify
	gone.add("https://push.example.com/b");
	calls.length = 0;
	await svc.notify({ title: "t", body: "x" });
	expect(svc.subscriptionCount).toBe(1);
	calls.length = 0;
	await svc.notify({ title: "t", body: "x" });
	expect(calls).toHaveLength(1);
	expect(calls[0].endpoint).toBe("https://push.example.com/a");
});

test("notify prunes a subscription whose keys can never be encrypted (no infinite retry)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushbad-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const calls: string[] = [];
	const send: PushSend = async (endpoint) => {
		calls.push(endpoint);
		return { status: 201 };
	};
	const svc = new PushService(dir, { send });
	await svc.init();

	const good = await makeSubscription();
	await svc.subscribe({ ...good.sub, endpoint: "https://push.example.com/good" });
	// Valid base64url, but not a P-256 point — passes subscribe(), throws in encryptPayload's importKey.
	await svc.subscribe({ endpoint: "https://push.example.com/bad", keys: { p256dh: "AAAA", auth: "AAAAAAAAAAAAAAAAAAAAAA" } });
	expect(svc.subscriptionCount).toBe(2);

	const sent = await svc.notify({ title: "t", body: "x" });
	expect(sent).toBe(1); // only the good one delivered
	expect(calls).toEqual(["https://push.example.com/good"]); // bad never reached the network
	expect(svc.subscriptionCount).toBe(1); // permanently-broken sub pruned, not retried

	// A second round never re-touches the pruned endpoint.
	calls.length = 0;
	await svc.notify({ title: "t", body: "x" });
	expect(calls).toEqual(["https://push.example.com/good"]);
});

test("subscriptions + VAPID key persist across instances", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushp-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const one = new PushService(dir, { send: async () => ({ status: 201 }) });
	await one.init();
	const key = one.publicKey;
	const a = await makeSubscription();
	await one.subscribe({ ...a.sub, endpoint: "https://push.example.com/keep" });

	const two = new PushService(dir, { send: async () => ({ status: 201 }) });
	await two.init();
	expect(two.publicKey).toBe(key); // same VAPID keypair
	expect(two.subscriptionCount).toBe(1);
	expect(await two.notify({ title: "t", body: "x" })).toBe(1);
});

test("real HTTP dispatch reaches the endpoint with the right wire shape", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushw-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	let received: { method: string; enc: string | null; auth: string | null; bytes: number } | undefined;
	const mock = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const buf = Buffer.from(await req.arrayBuffer());
			received = { method: req.method, enc: req.headers.get("content-encoding"), auth: req.headers.get("authorization"), bytes: buf.length };
			return new Response(null, { status: 201 });
		},
	});
	cleanups.push(() => mock.stop(true));

	const svc = new PushService(dir); // real fetch transport
	await svc.init();
	const a = await makeSubscription();
	await svc.subscribe({ ...a.sub, endpoint: `http://127.0.0.1:${mock.port}/push` });
	const sent = await svc.notify({ title: "⛔ alpha", body: "needs you", url: "/#/agent/alpha", tag: "alpha" });

	expect(sent).toBe(1);
	expect(received?.method).toBe("POST");
	expect(received?.enc).toBe("aes128gcm");
	expect(received?.auth?.startsWith("vapid t=")).toBe(true);
	expect(received?.bytes).toBeGreaterThan(80);
});

// ── completionPayload (plans/voice-loop concern 01, generalized by daily-attention-w0 01) ──

function doneAgent(status: AgentStatus, over: Partial<AgentDTO> = {}): AgentDTO {
	return { id: "a1", name: "alpha", status, kind: "omp-operator", repo: "/r", worktree: "/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

test("completionPayload fires on a seeded, armed working→idle transition with a name-only body and the done: tag", () => {
	const p = completionPayload("working", doneAgent("idle", { completionPushArmed: true, completionPushKind: "voice" }), true);
	expect(p).not.toBeNull();
	expect(p?.title).toBe("✅ alpha finished");
	// Pinned EXACTLY — no transcript/summary content ever rides the lock-screen body (DESIGN.md: "lock
	// screens are not viewer-tier"). Any agent-specific text here would be a privacy regression.
	expect(p?.body).toBe("Tap to open glance — call back for the spoken debrief.");
	expect(p?.body).not.toContain("alpha");
	expect(p?.url).toBe("/#/agent/a1");
	// done: namespace — load-bearing so this can never replace, or share a debounce slot with, an
	// unactioned "needs you" escalation (which tags bare `a.id`, see escalationPayload above).
	expect(p?.tag).toBe("done:a1");
});

test("completionPayload copy branches on WHY the latch armed: voice keeps the spoken-debrief callback, a category arm gets the generic body", () => {
	const voice = completionPayload("working", doneAgent("idle", { completionPushArmed: true, completionPushKind: "voice" }), true);
	expect(voice?.body).toBe("Tap to open glance — call back for the spoken debrief.");
	const category = completionPayload("working", doneAgent("idle", { completionPushArmed: true, completionPushKind: "category" }), true);
	expect(category?.body).toBe("Ready when you are — tap to pick up where you left off.");
	// Both copies are content-free (no transcript/summary text) and share the same tag namespace.
	expect(category?.body).not.toContain("alpha");
	expect(category?.tag).toBe("done:a1");
	expect(category?.title).toBe("✅ alpha finished");
	// An armed DTO without a kind (a legacy in-flight event) falls back to the generic body — the
	// voice-specific callback line must never fire for a dispatch we can't prove was voice.
	const kindless = completionPayload("working", doneAgent("idle", { completionPushArmed: true }), true);
	expect(kindless?.body).toBe("Ready when you are — tap to pick up where you left off.");
});

test("completionPayload is null when the agent is not armed", () => {
	expect(completionPayload("working", doneAgent("idle"), true)).toBeNull();
	expect(completionPayload("working", doneAgent("idle", { completionPushArmed: false }), true)).toBeNull();
});

test("completionPayload is null before the roster is seeded (never alerts in bulk on reconnect/replay)", () => {
	expect(completionPayload("working", doneAgent("idle", { completionPushArmed: true }), false)).toBeNull();
});

test("completionPayload is null with no prior status (first-seen, not a transition)", () => {
	expect(completionPayload(undefined, doneAgent("idle", { completionPushArmed: true }), true)).toBeNull();
});

test("completionPayload is null on a same-state event (no transition)", () => {
	expect(completionPayload("idle", doneAgent("idle", { completionPushArmed: true }), true)).toBeNull();
});

test("completionPayload is null for any non-idle destination, even armed+seeded", () => {
	for (const status of ["working", "starting", "input", "error", "stopped"] as AgentStatus[]) {
		expect(completionPayload("working", doneAgent(status, { completionPushArmed: true }), true)).toBeNull();
	}
});
