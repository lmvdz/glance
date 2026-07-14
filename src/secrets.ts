/**
 * AES-256-GCM crypto for per-org provider secrets (the `org_secret` table — plans/voice-db-mode/
 * 02-secret-store.md, DESIGN.md's Security model). Every row gets its own random nonce; the
 * master key never appears in a database row.
 *
 * Master key handling: `OMP_SQUAD_SECRETS_KEY` (a 32-byte value, hex or base64) is read ONCE —
 * at module load, into a private module-local — and BOTH prefix twins (`OMP_SQUAD_SECRETS_KEY`
 * and env-compat.ts's `GLANCE_SECRETS_KEY` mirror) are deleted from the source env immediately,
 * synchronously, before any other module runs. This is deliberately not a lazy first-use read:
 * any window where the raw key sits in `process.env` is a window a future spawn site could leak
 * it into a tenant agent process even if concern 01's scrub is bypassed — two independent
 * defenses, not one relied on twice. `initMasterKey` is the mechanism (called once for real boot
 * at the bottom of this file, against the live `process.env`), exported so tests can re-invoke it
 * against a synthetic env to exercise different boot states without a fresh module instance.
 *
 * Boot posture (operator decision 2026-07-14: operator-supplied only, no generate-on-boot — see
 * DESIGN.md "Boot-secret provisioning"): a missing or malformed master key is a NORMAL boot state
 * for a tenant who hasn't configured voice — `hasMasterKey()` reads false, and every function
 * below degrades to "no key" rather than throwing. Concern 03's resolver keys the voice lane's
 * `enabled:false` / mint-501 posture on `hasMasterKey()`; never a 500 at call time, never a dead
 * daemon for tenants who don't use voice.
 *
 * Decrypt is FAIL-CLOSED everywhere: a decrypt error (missing key, wrong/rotated master key,
 * corrupted ciphertext/nonce, tampered auth tag) returns `undefined` — never throws into a
 * request, never falls back to any other key. A wrong master key degrades the whole org to
 * "voice unavailable", honestly reported, not a crash.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12; // standard GCM nonce size
const TAG_BYTES = 16; // standard GCM auth tag size

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/** Decode a hex or base64 master-key string to exactly 32 bytes, or `undefined` if it's neither
 *  shape — malformed input degrades to "no key", it never throws. */
function decodeKey(raw: string): Buffer | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (HEX_KEY.test(trimmed)) return Buffer.from(trimmed, "hex");
	try {
		const decoded = Buffer.from(trimmed, "base64");
		if (decoded.length === KEY_BYTES) return decoded;
	} catch {
		// fall through to undefined
	}
	return undefined;
}

let masterKey: Buffer | undefined;

/**
 * Read the master key from `source` (default `process.env`), decode it, and delete BOTH prefix
 * twins from `source` — the real boot mechanism (called unconditionally below against the live
 * process env) and a reusable test seam (tests pass a synthetic env object so the real
 * `process.env` is never touched by test setup). Returns the decoded key, or `undefined` when
 * absent/malformed — callers never see a throw here.
 *
 * Precedence: `GLANCE_SECRETS_KEY` wins when both are set, matching env-compat.ts's documented
 * "GLANCE_ wins on conflict" rule (env-compat.ts:16) — src/index.ts loads env-compat.ts first and
 * mirrors the twins to identical values before this module's boot call, so the two normally agree,
 * but any other entrypoint that imports this module first must see the same precedence contract.
 *
 * @substrate test seam + boot mechanism — exported so tests can drive different boot states
 * against a synthetic env without a fresh module instance; production must call this at most once
 * (the unconditional call at the bottom of this file), never again from request-handling code.
 */
export function initMasterKey(source: NodeJS.ProcessEnv = process.env): Buffer | undefined {
	const raw = source.GLANCE_SECRETS_KEY ?? source.OMP_SQUAD_SECRETS_KEY;
	delete source.OMP_SQUAD_SECRETS_KEY;
	delete source.GLANCE_SECRETS_KEY;
	masterKey = raw === undefined ? undefined : decodeKey(raw);
	return masterKey;
}

/** True once boot has established a usable 32-byte master key. Concern 03's resolver (and the
 *  voice config probe / mint gate) key the whole lane's `enabled:false` / 501 posture on this.
 *  @substrate consumed by the org-aware voice resolver, concern 03 (not yet landed) */
export function hasMasterKey(): boolean {
	return masterKey !== undefined;
}

export interface EncryptedSecret {
	/** base64: AES-GCM ciphertext with the auth tag appended. */
	ciphertext: string;
	/** base64: the per-row random nonce. */
	nonce: string;
}

/** Encrypt `plaintext` under the boot master key with a fresh random nonce. Returns `undefined`
 *  (never throws) when no master key is available — callers must treat that identically to a
 *  decrypt failure: "no key", not an error. */
export function encryptSecret(plaintext: string): EncryptedSecret | undefined {
	if (!masterKey) return undefined;
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv(ALGO, masterKey, nonce);
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return { ciphertext: Buffer.concat([body, tag]).toString("base64"), nonce: nonce.toString("base64") };
}

/** Decrypt a stored secret. FAILS CLOSED: a missing master key, a wrong/rotated master key, a
 *  corrupted ciphertext/nonce, or a tampered auth tag all return `undefined` — never throws into
 *  a request, never falls back to any other key. See module doc comment / DESIGN.md's Security
 *  model. */
export function decryptSecret(enc: EncryptedSecret): string | undefined {
	if (!masterKey) return undefined;
	try {
		const nonce = Buffer.from(enc.nonce, "base64");
		const raw = Buffer.from(enc.ciphertext, "base64");
		if (nonce.length !== NONCE_BYTES || raw.length <= TAG_BYTES) return undefined;
		const tag = raw.subarray(raw.length - TAG_BYTES);
		const body = raw.subarray(0, raw.length - TAG_BYTES);
		const decipher = createDecipheriv(ALGO, masterKey, nonce);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
	} catch {
		// Corrupted ciphertext/nonce or a mismatched auth tag (wrong master key) throws from
		// node:crypto — caught here so it never propagates into a request. "No key", honestly.
		return undefined;
	}
}

/** Last 4 characters of a raw secret, for the admin UI's rotation-check display (DESIGN.md:
 *  "not an identifier: OpenAI keys share long prefixes"). Never persist or log more than this. */
export function last4(plaintext: string): string {
	return plaintext.slice(-4);
}

// Real boot: run once, at import time, against the live process.env — see module doc comment for
// why this isn't a lazy first-use read.
initMasterKey();
