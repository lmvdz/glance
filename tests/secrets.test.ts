/**
 * AES-256-GCM crypto for org_secret (plans/voice-db-mode/02-secret-store.md). Every test
 * establishes its own master-key state via `initMasterKey(...)` against a SYNTHETIC env object
 * (never the real `process.env`) so tests can exercise different boot states (valid key, no key,
 * malformed key, file-sourced key) without needing a fresh module instance per scenario — see
 * src/secrets.ts's own doc comment for why `initMasterKey` is exported as a reusable seam rather
 * than a lazy read.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decryptSecret, encryptSecret, hasMasterKey, initMasterKey, last4 } from "../src/secrets.ts";

const KEY_HEX = "7329787df726d0637e8e4678d098b779fccc8ba32d6efcc962b66208620d599e".slice(0, 64);
const KEY_HEX_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AAD = "org-a:openai";

function withKey(hex: string = KEY_HEX): void {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: hex });
}

function withNoKey(): void {
	initMasterKey({});
}

async function withTempKeyFile(content: string, fn: (filePath: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-key-"));
	const filePath = path.join(dir, "master.key");
	try {
		await fs.writeFile(filePath, content, "utf8");
		await fn(filePath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("round-trip: encrypt -> persist -> decrypt yields the original plaintext; ciphertext != plaintext", () => {
	withKey();
	const plaintext = "sk-real-openai-key-1234567890";
	const enc = encryptSecret(plaintext, AAD);
	expect(enc).toBeDefined();
	expect(enc!.ciphertext).not.toBe(plaintext);
	expect(enc!.ciphertext.includes(plaintext)).toBe(false);
	const decrypted = decryptSecret(enc!, AAD);
	expect(decrypted).toBe(plaintext);
});

test("round-trip: each encryption uses a fresh random nonce (two encryptions of the same plaintext differ)", () => {
	withKey();
	const a = encryptSecret("same-plaintext", AAD)!;
	const b = encryptSecret("same-plaintext", AAD)!;
	expect(a.nonce).not.toBe(b.nonce);
	expect(a.ciphertext).not.toBe(b.ciphertext);
	expect(decryptSecret(a, AAD)).toBe("same-plaintext");
	expect(decryptSecret(b, AAD)).toBe("same-plaintext");
});

test("decrypt fails closed: corrupted ciphertext returns undefined, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key", AAD)!;
	const corrupted = { ciphertext: enc.ciphertext.slice(0, -4) + "XXXX", nonce: enc.nonce };
	expect(() => decryptSecret(corrupted, AAD)).not.toThrow();
	expect(decryptSecret(corrupted, AAD)).toBeUndefined();
});

test("decrypt fails closed: tampered auth tag returns undefined, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key", AAD)!;
	// Flip the last base64 char of the ciphertext (which carries the appended 16-byte auth tag).
	const flipped = enc.ciphertext.slice(0, -1) + (enc.ciphertext.endsWith("A") ? "B" : "A");
	expect(decryptSecret({ ciphertext: flipped, nonce: enc.nonce }, AAD)).toBeUndefined();
});

test("decrypt fails closed: corrupted nonce returns undefined, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key", AAD)!;
	expect(decryptSecret({ ciphertext: enc.ciphertext, nonce: "not-valid-nonce-length" }, AAD)).toBeUndefined();
});

test("decrypt fails closed: a wrong/rotated master key returns undefined, never throws, never falls back", () => {
	withKey(KEY_HEX);
	const enc = encryptSecret("sk-a-real-key", AAD)!;
	withKey(KEY_HEX_B); // rotate to a DIFFERENT valid 32-byte key
	expect(() => decryptSecret(enc, AAD)).not.toThrow();
	expect(decryptSecret(enc, AAD)).toBeUndefined();
});

test("decrypt fails closed: no master key at all returns undefined for both encrypt and decrypt, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-a-real-key", AAD)!;
	withNoKey();
	expect(hasMasterKey()).toBe(false);
	expect(encryptSecret("anything", AAD)).toBeUndefined();
	expect(() => decryptSecret(enc, AAD)).not.toThrow();
	expect(decryptSecret(enc, AAD)).toBeUndefined();
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
	const enc = encryptSecret("sk-b64-key-test", AAD)!;
	expect(decryptSecret(enc, AAD)).toBe("sk-b64-key-test");
});

test("the GLANCE_ twin is honored when OMP_SQUAD_SECRETS_KEY is absent", () => {
	initMasterKey({ GLANCE_SECRETS_KEY: KEY_HEX });
	expect(hasMasterKey()).toBe(true);
});

test("GLANCE_SECRETS_KEY wins over the OMP_SQUAD_ twin when both are set (matches env-compat.ts's documented precedence)", () => {
	// GLANCE_SECRETS_KEY=KEY_HEX_B, OMP_SQUAD_SECRETS_KEY=KEY_HEX — GLANCE_ must be the effective key.
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX, GLANCE_SECRETS_KEY: KEY_HEX_B });
	const enc = encryptSecret("probe", AAD)!;
	// RED proof: if OMP_SQUAD_ had won (the pre-fix behavior), decrypting under KEY_HEX would succeed.
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	expect(decryptSecret(enc, AAD)).toBeUndefined();
	// GREEN proof: decrypting under KEY_HEX_B (the GLANCE_ value) succeeds — GLANCE_ actually won.
	initMasterKey({ GLANCE_SECRETS_KEY: KEY_HEX_B });
	expect(decryptSecret(enc, AAD)).toBe("probe");
});

test("initMasterKey deletes all four prefix/kind twins from the source env object (the module-local + delete defense)", () => {
	const env: Record<string, string | undefined> = {
		OMP_SQUAD_SECRETS_KEY: KEY_HEX,
		GLANCE_SECRETS_KEY: KEY_HEX,
		OMP_SQUAD_SECRETS_KEY_FILE: "/tmp/does-not-matter",
		GLANCE_SECRETS_KEY_FILE: "/tmp/does-not-matter",
		PATH: "/usr/bin",
	};
	initMasterKey(env as NodeJS.ProcessEnv);
	expect("OMP_SQUAD_SECRETS_KEY" in env).toBe(false);
	expect("GLANCE_SECRETS_KEY" in env).toBe(false);
	expect("OMP_SQUAD_SECRETS_KEY_FILE" in env).toBe(false);
	expect("GLANCE_SECRETS_KEY_FILE" in env).toBe(false);
	expect(env.PATH).toBe("/usr/bin"); // unrelated vars untouched
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

test("last4 returns exactly the last 4 characters for a plausibly-real (long) secret", () => {
	expect(last4("sk-openai-abcd1234")).toBe("1234");
	expect(last4("a-reasonably-long-secret-value-xyz9")).toBe("xyz9");
});

test("last4 fails closed on short secrets: never echoes most/all of a <8-char value (RED without the guard: 'abcd'.slice(-4) === 'abcd', the whole secret)", () => {
	expect(last4("abcd")).toBe("");
	expect(last4("a")).toBe("");
	expect(last4("")).toBe("");
	expect(last4("1234567")).toBe(""); // 7 chars: still under the minimum
});

test("last4 starts returning real characters once the minimum length is met", () => {
	expect(last4("12345678")).toBe("5678"); // exactly at the minimum
	expect(last4("123456789")).toBe("6789");
});

// ── AAD binding (crypto layer) — plans/voice-db-mode's cross-lineage audit finding: GCM with no
// AAD leaves ciphertext unbound to its org, so a raw-row copy across orgs decrypts fine under the
// shared master key. The store-level "moved ciphertext between org rows" proof lives in
// org-secret-rls.test.ts (it needs the DAL); these are the crypto-primitive-level proofs. ──

test("AAD binding: a ciphertext decrypts only under the SAME aad it was encrypted with", () => {
	withKey();
	const enc = encryptSecret("sk-bound-to-org-a", "org-a:openai")!;
	expect(decryptSecret(enc, "org-a:openai")).toBe("sk-bound-to-org-a");
});

test("AAD binding: decrypting under a DIFFERENT org id (same provider) fails closed, never throws (RED without AAD: any aad would decrypt fine)", () => {
	withKey();
	const enc = encryptSecret("sk-bound-to-org-a", "org-a:openai")!;
	expect(() => decryptSecret(enc, "org-b:openai")).not.toThrow();
	expect(decryptSecret(enc, "org-b:openai")).toBeUndefined();
});

test("AAD binding: decrypting under a DIFFERENT provider (same org) fails closed, never throws", () => {
	withKey();
	const enc = encryptSecret("sk-bound-to-openai", "org-a:openai")!;
	expect(decryptSecret(enc, "org-a:anthropic")).toBeUndefined();
});

test("AAD binding: an empty-string aad is not treated as a wildcard — still fails closed against the real aad", () => {
	withKey();
	const enc = encryptSecret("sk-x", "org-a:openai")!;
	expect(decryptSecret(enc, "")).toBeUndefined();
});

// ── Master key from a FILE (isolation-safe ingestion path) ──────────────────────────────────

test("initMasterKey reads the key from OMP_SQUAD_SECRETS_KEY_FILE when set, never touching the inline var", async () => {
	await withTempKeyFile(KEY_HEX, async (filePath) => {
		initMasterKey({ OMP_SQUAD_SECRETS_KEY_FILE: filePath });
		expect(hasMasterKey()).toBe(true);
		const enc = encryptSecret("sk-from-file", AAD)!;
		expect(decryptSecret(enc, AAD)).toBe("sk-from-file");
	});
});

test("initMasterKey trims trailing whitespace/newline from the key file's content (a shell-written file ends in \\n)", async () => {
	await withTempKeyFile(`${KEY_HEX}\n`, async (filePath) => {
		initMasterKey({ OMP_SQUAD_SECRETS_KEY_FILE: filePath });
		expect(hasMasterKey()).toBe(true);
	});
});

test("the GLANCE_ twin FILE var is honored when the OMP_SQUAD_ twin is absent", async () => {
	await withTempKeyFile(KEY_HEX, async (filePath) => {
		initMasterKey({ GLANCE_SECRETS_KEY_FILE: filePath });
		expect(hasMasterKey()).toBe(true);
	});
});

test("GLANCE_SECRETS_KEY_FILE wins over OMP_SQUAD_SECRETS_KEY_FILE when both are set (same precedence rule as the inline vars)", async () => {
	await withTempKeyFile(KEY_HEX, async (fileA) => {
		await withTempKeyFile(KEY_HEX_B, async (fileB) => {
			initMasterKey({ OMP_SQUAD_SECRETS_KEY_FILE: fileA, GLANCE_SECRETS_KEY_FILE: fileB });
			const enc = encryptSecret("probe", AAD)!;
			initMasterKey({ OMP_SQUAD_SECRETS_KEY_FILE: fileA });
			expect(decryptSecret(enc, AAD)).toBeUndefined(); // fileA's key did NOT win
			initMasterKey({ GLANCE_SECRETS_KEY_FILE: fileB });
			expect(decryptSecret(enc, AAD)).toBe("probe"); // fileB's key (GLANCE_) did
		});
	});
});

test("a _FILE var wins over the plain inline var of either prefix when both are set", async () => {
	await withTempKeyFile(KEY_HEX_B, async (filePath) => {
		initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX, OMP_SQUAD_SECRETS_KEY_FILE: filePath });
		const enc = encryptSecret("probe", AAD)!;
		// RED proof: if the inline var had won, decrypting under KEY_HEX would succeed.
		initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
		expect(decryptSecret(enc, AAD)).toBeUndefined();
		// GREEN proof: the file's key (KEY_HEX_B) actually won.
		initMasterKey({ GLANCE_SECRETS_KEY: KEY_HEX_B });
		expect(decryptSecret(enc, AAD)).toBe("probe");
	});
});

test("a _FILE var pointing at a missing file degrades to no-key, never throws, and does NOT fall back to a plain var (isolation intent must not be silently defeated)", () => {
	expect(() =>
		initMasterKey({ OMP_SQUAD_SECRETS_KEY_FILE: "/nonexistent/path/does-not-exist.key", OMP_SQUAD_SECRETS_KEY: KEY_HEX }),
	).not.toThrow();
	expect(hasMasterKey()).toBe(false);
});

test("a _FILE var pointing at a file with malformed content degrades to no-key, never throws", async () => {
	await withTempKeyFile("not-a-valid-key-at-all", async (filePath) => {
		expect(() => initMasterKey({ OMP_SQUAD_SECRETS_KEY_FILE: filePath })).not.toThrow();
		expect(hasMasterKey()).toBe(false);
	});
});

test("no _FILE var set at all falls back to the plain inline var (back-compat path still works)", () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	expect(hasMasterKey()).toBe(true);
});

test("a base64-encoded key file is accepted (not just hex)", async () => {
	const b64 = Buffer.alloc(32, 9).toString("base64");
	await withTempKeyFile(b64, async (filePath) => {
		initMasterKey({ OMP_SQUAD_SECRETS_KEY_FILE: filePath });
		expect(hasMasterKey()).toBe(true);
	});
});
