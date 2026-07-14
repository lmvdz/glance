/**
 * AES-256-GCM crypto for org_secret (plans/voice-db-mode/02-secret-store.md). Every test
 * establishes its own master-key state via `initMasterKey(...)` against a SYNTHETIC env object
 * (never the real `process.env`) so tests can exercise different boot states (valid key, no key,
 * malformed key) without needing a fresh module instance per scenario — see src/secrets.ts's own
 * doc comment for why `initMasterKey` is exported as a reusable seam rather than a lazy read.
 */

import { expect, test } from "bun:test";
import { decryptSecret, encryptSecret, hasMasterKey, initMasterKey, last4 } from "../src/secrets.ts";

const KEY_HEX = "7329787df726d0637e8e4678d098b779fccc8ba32d6efcc962b66208620d599e".slice(0, 64);
const KEY_HEX_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function withKey(hex: string = KEY_HEX): void {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: hex });
}

function withNoKey(): void {
	initMasterKey({});
}

test("round-trip: encrypt -> persist -> decrypt yields the original plaintext; ciphertext != plaintext", () => {
	withKey();
	const plaintext = "sk-real-openai-key-1234567890";
	const enc = encryptSecret(plaintext);
	expect(enc).toBeDefined();
	expect(enc!.ciphertext).not.toBe(plaintext);
	expect(enc!.ciphertext.includes(plaintext)).toBe(false);
	const decrypted = decryptSecret(enc!);
	expect(decrypted).toBe(plaintext);
});

test("round-trip: each encryption uses a fresh random nonce (two encryptions of the same plaintext differ)", () => {
	withKey();
	const a = encryptSecret("same-plaintext")!;
	const b = encryptSecret("same-plaintext")!;
	expect(a.nonce).not.toBe(b.nonce);
	expect(a.ciphertext).not.toBe(b.ciphertext);
	expect(decryptSecret(a)).toBe("same-plaintext");
	expect(decryptSecret(b)).toBe("same-plaintext");
});

test("decrypt fails closed: corrupted ciphertext returns undefined, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key")!;
	const corrupted = { ciphertext: enc.ciphertext.slice(0, -4) + "XXXX", nonce: enc.nonce };
	expect(() => decryptSecret(corrupted)).not.toThrow();
	expect(decryptSecret(corrupted)).toBeUndefined();
});

test("decrypt fails closed: tampered auth tag returns undefined, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key")!;
	// Flip the last base64 char of the ciphertext (which carries the appended 16-byte auth tag).
	const flipped = enc.ciphertext.slice(0, -1) + (enc.ciphertext.endsWith("A") ? "B" : "A");
	expect(decryptSecret({ ciphertext: flipped, nonce: enc.nonce })).toBeUndefined();
});

test("decrypt fails closed: corrupted nonce returns undefined, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key")!;
	expect(decryptSecret({ ciphertext: enc.ciphertext, nonce: "not-valid-nonce-length" })).toBeUndefined();
});

test("decrypt fails closed: a wrong/rotated master key returns undefined, never throws, never falls back", () => {
	withKey(KEY_HEX);
	const enc = encryptSecret("sk-a-real-key")!;
	withKey(KEY_HEX_B); // rotate to a DIFFERENT valid 32-byte key
	expect(() => decryptSecret(enc)).not.toThrow();
	expect(decryptSecret(enc)).toBeUndefined();
});

test("decrypt fails closed: no master key at all returns undefined for both encrypt and decrypt, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key")!;
	withNoKey();
	expect(hasMasterKey()).toBe(false);
	expect(encryptSecret("anything")).toBeUndefined();
	expect(() => decryptSecret(enc)).not.toThrow();
	expect(decryptSecret(enc)).toBeUndefined();
});

test("hasMasterKey reflects the current boot state", () => {
	withKey();
	expect(hasMasterKey()).toBe(true);
	withNoKey();
	expect(hasMasterKey()).toBe(false);
});

test("a malformed master key (wrong length, garbage) degrades to no-key, never throws at init", () => {
	expect(() => initMasterKey({ OMP_SQUAD_SECRETS_KEY: "too-short" })).not.toThrow();
	expect(hasMasterKey()).toBe(false);

	expect(() => initMasterKey({ OMP_SQUAD_SECRETS_KEY: "zz".repeat(32) })).not.toThrow(); // not valid hex
	expect(hasMasterKey()).toBe(false);

	expect(() => initMasterKey({ OMP_SQUAD_SECRETS_KEY: "" })).not.toThrow();
	expect(hasMasterKey()).toBe(false);
});

test("a base64-encoded 32-byte key is accepted (not just hex)", () => {
	const b64 = Buffer.alloc(32, 7).toString("base64");
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: b64 });
	expect(hasMasterKey()).toBe(true);
	const enc = encryptSecret("sk-b64-key-test")!;
	expect(decryptSecret(enc)).toBe("sk-b64-key-test");
});

test("the GLANCE_ twin is honored when OMP_SQUAD_SECRETS_KEY is absent", () => {
	initMasterKey({ GLANCE_SECRETS_KEY: KEY_HEX });
	expect(hasMasterKey()).toBe(true);
});

test("OMP_SQUAD_SECRETS_KEY wins over the GLANCE_ twin when both are set", () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX, GLANCE_SECRETS_KEY: KEY_HEX_B });
	const enc = encryptSecret("probe")!;
	// If GLANCE_ had won, decrypting under KEY_HEX (OMP_SQUAD_'s value) would fail.
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	expect(decryptSecret(enc)).toBe("probe");
});

test("initMasterKey deletes BOTH prefix twins from the source env object (the module-local + delete defense)", () => {
	const env: Record<string, string | undefined> = { OMP_SQUAD_SECRETS_KEY: KEY_HEX, GLANCE_SECRETS_KEY: KEY_HEX, PATH: "/usr/bin" };
	initMasterKey(env as NodeJS.ProcessEnv);
	expect("OMP_SQUAD_SECRETS_KEY" in env).toBe(false);
	expect("GLANCE_SECRETS_KEY" in env).toBe(false);
	expect(env.PATH).toBe("/usr/bin"); // unrelated vars untouched
	expect(hasMasterKey()).toBe(true); // the value survived into the module-local before deletion
});

test("initMasterKey against the REAL process.env deletes both twins there too (real boot mechanism)", () => {
	const priorSquad = process.env.OMP_SQUAD_SECRETS_KEY;
	const priorGlance = process.env.GLANCE_SECRETS_KEY;
	process.env.OMP_SQUAD_SECRETS_KEY = KEY_HEX;
	process.env.GLANCE_SECRETS_KEY = KEY_HEX;
	try {
		initMasterKey(process.env);
		expect(process.env.OMP_SQUAD_SECRETS_KEY).toBeUndefined();
		expect(process.env.GLANCE_SECRETS_KEY).toBeUndefined();
		expect(hasMasterKey()).toBe(true);
	} finally {
		if (priorSquad === undefined) delete process.env.OMP_SQUAD_SECRETS_KEY;
		else process.env.OMP_SQUAD_SECRETS_KEY = priorSquad;
		if (priorGlance === undefined) delete process.env.GLANCE_SECRETS_KEY;
		else process.env.GLANCE_SECRETS_KEY = priorGlance;
	}
});

test("last4 returns exactly the last 4 characters", () => {
	expect(last4("sk-openai-abcd1234")).toBe("1234");
	expect(last4("abcd")).toBe("abcd");
});
