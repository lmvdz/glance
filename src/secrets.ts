/**
 * AES-256-GCM crypto for per-org provider secrets (the `org_secret` table — plans/voice-db-mode/
 * 02-secret-store.md, DESIGN.md's Security model). Every row gets its own random nonce; the
 * master key never appears in a database row.
 *
 * Master key handling — TWO ingestion paths, one isolation-safe, one back-compat only:
 *
 *  - **`OMP_SQUAD_SECRETS_KEY_FILE` / `GLANCE_SECRETS_KEY_FILE` (RECOMMENDED)**: a path to a file
 *    holding the 32-byte key (hex or base64). Read synchronously at boot; the key bytes never
 *    enter `process.env` at all, so they never enter the kernel exec-time environ and are never
 *    visible via `/proc/<pid>/environ` to another same-uid reader — a hole that survives even a
 *    same-process `delete process.env.X`, because the kernel's own copy of the environ block was
 *    populated at exec time and a userspace delete never touches it. This is the isolation-safe
 *    path; prefer it in any environment where `/proc` is reachable by other tenants/processes on
 *    the host.
 *  - **`OMP_SQUAD_SECRETS_KEY` / `GLANCE_SECRETS_KEY` (back-compat)**: the 32-byte value directly
 *    in the env var. Read ONCE at module load into a private module-local, and BOTH prefix twins
 *    are deleted from the source env immediately, synchronously, before any other module runs —
 *    this narrows the in-process `process.env` exposure window (a future spawn site can't read it
 *    off `process.env` even if concern 01's scrub is bypassed) but does NOT close the
 *    `/proc/self/environ` hole above, since the kernel's copy predates the delete. Kept working for
 *    deployments that already set it; the FILE path above is the one that actually closes the leak.
 *
 * When both are set for a given prefix, the FILE path wins (it's the documented safe one). Either
 * prefix's FILE var beats either prefix's plain var; `GLANCE_` wins over `OMP_SQUAD_` within each
 * kind, matching env-compat.ts's documented "GLANCE_ wins on conflict" rule. All four vars are
 * deleted from the source env on every call, whether or not they were consulted.
 *
 * `initMasterKey` is the mechanism (called once for real boot at the bottom of this file, against
 * the live `process.env`), exported so tests can re-invoke it against a synthetic env to exercise
 * different boot states without a fresh module instance.
 *
 * Boot posture (operator decision 2026-07-14: operator-supplied only, no generate-on-boot — see
 * DESIGN.md "Boot-secret provisioning"): a missing or malformed master key, OR a `_FILE` path that
 * can't be read (missing file, permission denied), is a NORMAL boot state for a tenant who hasn't
 * configured voice — `hasMasterKey()` reads false, and every function below degrades to "no key"
 * rather than throwing. Concern 03's resolver keys the voice lane's `enabled:false` / mint-501
 * posture on `hasMasterKey()`; never a 500 at call time, never a dead daemon for tenants who don't
 * use voice.
 *
 * Decrypt is FAIL-CLOSED everywhere: a decrypt error (missing key, wrong/rotated master key,
 * corrupted ciphertext/nonce, tampered auth tag, or an AAD mismatch — e.g. ciphertext copied into
 * a different org's/provider's row) returns `undefined` — never throws into a request, never falls
 * back to any other key. A wrong master key degrades the whole org to "voice unavailable",
 * honestly reported, not a crash.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

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
 * Read a `_FILE`-suffixed path var's content, trimmed. `undefined` when the path itself is unset;
 * also `undefined` (never throws) when the path is set but the file can't be read — a missing or
 * unreadable file degrades to "no key" exactly like a malformed inline value, per this module's
 * fail-closed boot posture.
 */
function readKeyFile(filePath: string | undefined): string | undefined {
	if (filePath === undefined) return undefined;
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Read the master key from `source` (default `process.env`), decode it, and delete all four
 * prefix/kind twins from `source` — the real boot mechanism (called unconditionally below against
 * the live process env) and a reusable test seam (tests pass a synthetic env object so the real
 * `process.env` is never touched by test setup). Returns the decoded key, or `undefined` when
 * absent/malformed/unreadable — callers never see a throw here.
 *
 * Precedence (see module doc comment for the full rationale): the `_FILE` path wins over the
 * plain env var for a given prefix (it's the isolation-safe one — a `_FILE` var set but unreadable
 * does NOT fall back to a plain var of either prefix, since that would silently defeat an
 * operator's explicit choice to isolate the key from the environ); `GLANCE_` wins over
 * `OMP_SQUAD_` within each kind (FILE vs plain), matching env-compat.ts's documented "GLANCE_
 * wins on conflict" rule (env-compat.ts:16) — src/index.ts loads env-compat.ts first and mirrors
 * every twin to identical values before this module's boot call, so the two normally agree, but
 * any other entrypoint that imports this module first must see the same precedence contract.
 *
 * @substrate test seam + boot mechanism — exported so tests can drive different boot states
 * against a synthetic env without a fresh module instance; production must call this at most once
 * (the unconditional call at the bottom of this file), never again from request-handling code.
 */
export function initMasterKey(source: NodeJS.ProcessEnv = process.env): Buffer | undefined {
	const filePath = source.GLANCE_SECRETS_KEY_FILE ?? source.OMP_SQUAD_SECRETS_KEY_FILE;
	const inline = source.GLANCE_SECRETS_KEY ?? source.OMP_SQUAD_SECRETS_KEY;
	const usingFile = filePath !== undefined;
	const raw = usingFile ? readKeyFile(filePath) : inline;
	delete source.OMP_SQUAD_SECRETS_KEY;
	delete source.GLANCE_SECRETS_KEY;
	delete source.OMP_SQUAD_SECRETS_KEY_FILE;
	delete source.GLANCE_SECRETS_KEY_FILE;
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

/** Minimum plaintext length before `last4` echoes real characters — below this, a "last 4"
 *  display would echo the WHOLE secret (or most of it), defeating the point of truncating at all.
 *  Provider verification rejects credentials this short before they ever reach `putOrgSecret`, so
 *  this is defense-in-depth, not the primary guard. */
const LAST4_MIN_LENGTH = 8;

/** Encrypt `plaintext` under the boot master key with a fresh random nonce, binding the
 *  ciphertext to `aad` (Additional Authenticated Data — pass `${orgId}:${provider}`) so it can
 *  only ever decrypt successfully under the SAME org+provider pairing it was written for. SQLite
 *  self-host has no RLS — only the DAL's `where org_id` predicate — so this is the second,
 *  independent guard: a raw-row write that copies one org's `(ciphertext, nonce)` into another
 *  org's row (or a different provider's row within the same org) fails to decrypt even though
 *  both rows share the same master key. Returns `undefined` (never throws) when no master key is
 *  available — callers must treat that identically to a decrypt failure: "no key", not an error. */
export function encryptSecret(plaintext: string, aad: string): EncryptedSecret | undefined {
	if (!masterKey) return undefined;
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv(ALGO, masterKey, nonce);
	cipher.setAAD(Buffer.from(aad, "utf8"));
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return { ciphertext: Buffer.concat([body, tag]).toString("base64"), nonce: nonce.toString("base64") };
}

/** Decrypt a stored secret, verifying it against the SAME `aad` (`${orgId}:${provider}`) it was
 *  encrypted under — see `encryptSecret`'s doc comment. FAILS CLOSED: a missing master key, a
 *  wrong/rotated master key, a corrupted ciphertext/nonce, a tampered auth tag, or an AAD mismatch
 *  (row copied to/read under the wrong org or provider) all return `undefined` — never throws into
 *  a request, never falls back to any other key. See module doc comment / DESIGN.md's Security
 *  model. */
export function decryptSecret(enc: EncryptedSecret, aad: string): string | undefined {
	if (!masterKey) return undefined;
	try {
		const nonce = Buffer.from(enc.nonce, "base64");
		const raw = Buffer.from(enc.ciphertext, "base64");
		if (nonce.length !== NONCE_BYTES || raw.length <= TAG_BYTES) return undefined;
		const tag = raw.subarray(raw.length - TAG_BYTES);
		const body = raw.subarray(0, raw.length - TAG_BYTES);
		const decipher = createDecipheriv(ALGO, masterKey, nonce);
		decipher.setAAD(Buffer.from(aad, "utf8"));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
	} catch {
		// Corrupted ciphertext/nonce, a mismatched auth tag (wrong master key), or a mismatched AAD
		// (wrong org/provider) all throw from node:crypto — caught here so it never propagates into
		// a request. "No key", honestly.
		return undefined;
	}
}

/** Last 4 characters of a raw secret, for the admin UI's rotation-check display (DESIGN.md:
 *  "not an identifier: OpenAI keys share long prefixes"). Never persist or log more than this. A
 *  secret shorter than `LAST4_MIN_LENGTH` returns an empty string instead of echoing most/all of
 *  it — provider verification already rejects credentials this short, but a truncation display
 *  must never become a near-complete disclosure for a value that slips through anyway. */
export function last4(plaintext: string): string {
	if (plaintext.length < LAST4_MIN_LENGTH) return "";
	return plaintext.slice(-4);
}

// Real boot: run once, at import time, against the live process.env — see module doc comment for
// why this isn't a lazy first-use read.
initMasterKey();
