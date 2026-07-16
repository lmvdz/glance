/**
 * push.ts — background Web Push for escalation alerts, dependency-free.
 *
 * When an agent transitions to a state that needs a human (input / error), the
 * server pushes an encrypted notification to every subscribed device. The phone
 * buzzes even with the app closed; tapping it deep-links to the agent.
 *
 * Standards implemented directly (no library, matching the repo's zero-bloat
 * stance): RFC 8291 message encryption (`aes128gcm`) + RFC 8188 content coding +
 * RFC 8292 VAPID (ES256 JWT). EC operations use WebCrypto; HKDF/HMAC + AES-GCM
 * use node:crypto. Keys + subscriptions persist in the state dir.
 */

import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";
import type { AgentDTO, AgentStatus } from "./types.ts";

export interface PushSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface PushPayload {
	title: string;
	body: string;
	/** in-app deep link the notification opens, e.g. "/#/agent/<id>" */
	url?: string;
	/** collapse key so repeated alerts for one agent replace rather than stack */
	tag?: string;
}

/** Pure: does this status transition warrant a human-attention push, and with what payload?
 *  Shared by the web-push lane (server) and the terminal OSC lane (tui) so they never drift. */
export function escalationPayload(prev: AgentStatus | undefined, a: AgentDTO, seeded: boolean): PushPayload | null {
	if (!seeded || prev === undefined || prev === a.status) return null;
	if (a.status !== "input" && a.status !== "error") return null;
	const title = a.status === "input" ? `⛔ ${a.name} needs you` : `⚠ ${a.name} errored`;
	const body = a.status === "input" ? a.pending[0]?.title ?? "waiting for input" : a.error ?? "agent error";
	// `?push=1` marks an open that ARRIVED via a notification tap — the only thing distinguishing it
	// from a typed/clicked URL, since both land on the same hash. The webapp beacons it once to
	// POST /api/push-tap and strips the marker (push-taps/day adoption counter,
	// plans/daily-dogfood-engine/02).
	return { title, body, url: `/#/agent/${a.id}?push=1`, tag: a.id };
}

/** Pure: does this status transition warrant a voice-loop COMPLETION push, and with what payload?
 *  Fires once per voice dispatch — squad-manager.ts's `voicePushArmed` latch arms on a voice-sourced
 *  prompt/spawn and disarms on push-sent or a voice-sourced interrupt; the DTO only ever carries
 *  `voicePushArmed: true` on the emitted event that is the dispatch's genuine TERMINAL signal (never
 *  an intermediate workflow-node idle — see squad-manager.ts's `onAgentEvent`), so this function needs
 *  no workflow-awareness of its own. The body carries NO transcript/summary content — lock screens are
 *  not viewer-tier; the spoken debrief (webapp, at the next call's start) is the content channel.
 *  `tag`/debounce key use the `done:` namespace (never bare `a.id`, unlike `escalationPayload` above)
 *  so a "finished" toast can never REPLACE (sw.js renotify) or debounce-eat an unactioned "needs you"
 *  escalation for the same agent. */
export function voiceDonePayload(prev: AgentStatus | undefined, a: AgentDTO, seeded: boolean): PushPayload | null {
	if (!seeded || prev === undefined || prev === a.status) return null;
	if (a.status !== "idle" || a.voicePushArmed !== true) return null;
	// Same `?push=1` tap marker as escalationPayload above — see the comment there.
	return { title: `✅ ${a.name} finished`, body: "Tap to open glance — call back for the spoken debrief.", url: `/#/agent/${a.id}?push=1`, tag: `done:${a.id}` };
}

/** Injectable transport (default = real fetch) so tests assert dispatch without a push service. */
export type PushSend = (endpoint: string, headers: Record<string, string>, body: Buffer) => Promise<{ status: number }>;

interface VapidKeys {
	publicKey: string; // base64url uncompressed P-256 point (65 bytes)
	privateKeyJwk: JsonWebKey;
}

const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");
/** Copy into a fresh ArrayBuffer-backed view — WebCrypto + fetch reject Buffer's wider ArrayBufferLike backing. */
const ab = (b: Buffer | Uint8Array): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(b.length);
	out.set(b);
	return out;
};

/** HKDF-SHA256 (RFC 5869): extract then expand to `length` bytes.
 *  @substrate exported for tests only — the RFC 5869 vectors assert the KDF directly; weakening
 *  that to an end-to-end encrypt round-trip would stop pinning the exact expand/extract shape. */
export function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
	const prk = createHmac("sha256", salt).update(ikm).digest();
	let out = Buffer.alloc(0);
	let t = Buffer.alloc(0);
	let counter = 0;
	while (out.length < length) {
		counter++;
		t = createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([counter])])).digest();
		out = Buffer.concat([out, t]);
	}
	return out.subarray(0, length);
}

/** Encrypt `plaintext` for a subscription using RFC 8291 `aes128gcm`. Salt/ephemeral key are injectable for test vectors. */
export async function encryptPayload(
	sub: PushSubscription,
	plaintext: Buffer,
	opts?: { salt?: Buffer; ephemeral?: CryptoKeyPair },
): Promise<Buffer> {
	const uaPublic = fromB64url(sub.keys.p256dh); // 65 bytes
	const authSecret = fromB64url(sub.keys.auth); // 16 bytes
	const ephemeral = opts?.ephemeral ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
	const asPublic = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))); // 65 bytes
	const uaKey = await crypto.subtle.importKey("raw", ab(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = Buffer.from(new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256)));

	// RFC 8291 §3.4: combine the ECDH secret + auth secret into the input keying material.
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
	const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);

	// RFC 8188: derive content-encryption key + nonce from the random salt.
	const salt = opts?.salt ?? randomBytes(16);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const record = Buffer.concat([plaintext, Buffer.from([0x02])]); // single, final record delimiter
	const encrypted = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

	// aes128gcm header: salt(16) | rs(uint32) | idlen(1) | keyid(as_public)
	const header = Buffer.alloc(21 + asPublic.length);
	salt.copy(header, 0);
	header.writeUInt32BE(4096, 16);
	header.writeUInt8(asPublic.length, 20);
	asPublic.copy(header, 21);
	return Buffer.concat([header, encrypted]);
}

/** Build the `Authorization: vapid …` header (RFC 8292) for one push endpoint. */
export async function vapidAuthHeader(endpoint: string, publicKey: string, privateKeyJwk: JsonWebKey, subject: string): Promise<string> {
	const aud = new URL(endpoint).origin;
	const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const payload = b64url(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
	const signingInput = `${header}.${payload}`;
	const key = await crypto.subtle.importKey("jwk", privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, ab(Buffer.from(signingInput))));
	return `vapid t=${signingInput}.${b64url(sig)}, k=${publicKey}`;
}

const defaultSend: PushSend = async (endpoint, headers, body) => {
	const res = await fetch(endpoint, { method: "POST", headers, body: ab(body) });
	return { status: res.status };
};

/** Per-daemon push registry: persists VAPID keypair + device subscriptions, dispatches encrypted alerts. */
export class PushService {
	private subs: PushSubscription[] = [];
	private vapid?: VapidKeys;
	private readonly subsFile: string;
	private readonly vapidFile: string;
	private readonly subject: string;
	private readonly send: PushSend;

	constructor(stateDir: string, opts?: { send?: PushSend; subject?: string }) {
		this.subsFile = path.join(stateDir, "push-subs.json");
		this.vapidFile = path.join(stateDir, "vapid.json");
		this.subject = opts?.subject ?? process.env.OMP_SQUAD_PUSH_SUBJECT ?? "mailto:squad@localhost";
		this.send = opts?.send ?? defaultSend;
	}

	/** Load (or generate + persist) the VAPID keypair and any saved subscriptions. */
	async init(): Promise<void> {
		const b = getStorageBackend();
		const vapidRaw = await b.readText(this.vapidFile);
		try {
			if (vapidRaw === undefined) throw new Error("missing");
			this.vapid = JSON.parse(vapidRaw) as VapidKeys;
		} catch {
			const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
			const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
			const privateKeyJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
			this.vapid = { publicKey: b64url(raw), privateKeyJwk };
			await b.writeDurable(this.vapidFile, JSON.stringify(this.vapid), { mode: 0o600 });
		}
		const subsRaw = await b.readText(this.subsFile);
		try {
			this.subs = subsRaw === undefined ? [] : (JSON.parse(subsRaw) as PushSubscription[]);
		} catch {
			this.subs = [];
		}
	}

	/** base64url VAPID public key the browser needs as `applicationServerKey`. */
	get publicKey(): string {
		return this.vapid?.publicKey ?? "";
	}

	get subscriptionCount(): number {
		return this.subs.length;
	}

	/** Register a device subscription (deduped by endpoint) and persist. */
	async subscribe(sub: PushSubscription): Promise<void> {
		if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("invalid subscription");
		this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), sub];
		await this.persist();
	}

	/** Encrypt + dispatch `payload` to every subscription. Prunes endpoints the push service has
	 *  dropped (404/410) and subscriptions whose keys can no longer be encrypted to (a permanent
	 *  failure — bad/garbage p256dh|auth — would otherwise be retried forever). Returns count accepted. */
	async notify(payload: PushPayload): Promise<number> {
		if (!this.vapid || this.subs.length === 0) return 0;
		const body = Buffer.from(JSON.stringify(payload));
		const dead: string[] = [];
		let sent = 0;
		for (const sub of this.subs) {
			// Phase 1: encrypt + sign. Deterministic over the subscription's keys, so a throw here is
			// permanent (malformed/corrupt keys) — prune, don't retry.
			let encrypted: Buffer;
			let authorization: string;
			try {
				encrypted = await encryptPayload(sub, body);
				authorization = await vapidAuthHeader(sub.endpoint, this.vapid.publicKey, this.vapid.privateKeyJwk, this.subject);
			} catch {
				dead.push(sub.endpoint);
				continue;
			}
			// Phase 2: network send. Failures here are transient — keep the subscription, retry next time.
			try {
				const { status } = await this.send(sub.endpoint, { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "2419200", authorization }, encrypted);
				if (status === 404 || status === 410) dead.push(sub.endpoint);
				else if (status >= 200 && status < 300) sent++;
			} catch {
				// transient endpoint failure — keep the subscription, try again next time
			}
		}
		if (dead.length) {
			this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
			await this.persist();
		}
		return sent;
	}

	private async persist(): Promise<void> {
		await getStorageBackend().writeDurable(this.subsFile, JSON.stringify(this.subs), { mode: 0o600 });
	}
}
