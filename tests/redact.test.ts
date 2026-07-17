/**
 * Secret-shape redaction — verifies the high-value vendor formats and the
 * KEY=value env-line rule collapse to [REDACTED], while ordinary prose is left
 * byte-for-byte intact (no false positives that would corrupt a digest).
 *
 * Two hardening passes (noisegate-compaction concern 02) live here too:
 *   - the bearer/authorization pattern used to eat legitimate code/prose (a bare `\s*` separator
 *     let it fire with zero real separator, and an over-wide tail charset let it consume property
 *     chains like `req.headers.authorization` or hyphenated English like `middleware-check`) —
 *     the false-positive tests below pin the fix.
 *   - the private-key pattern's lazy `.*?` span was unbounded, so many unmatched BEGIN markers in
 *     one input made each failed END-scan walk the rest of the string (O(n²)) — the perf test below
 *     pins the bounded-span fix.
 */

import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

test("redact: api keys, vcs tokens, and JWTs are replaced", () => {
	expect(redact("sk-abc123ABC456def789ghi0")).toBe("[REDACTED]");
	expect(redact("ghp_0123456789abcdefghijABCDEF")).toBe("[REDACTED]");
	expect(redact("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toBe("[REDACTED]");
});

test("redact: a KEY=value env line keeps the key but drops the value", () => {
	expect(redact("API_KEY=supersecretvalue")).toBe("API_KEY=[REDACTED]");
});

test("redact: ordinary prose passes through unchanged", () => {
	const prose = "The quick brown fox jumps over the lazy dog near the river bank.";
	expect(redact(prose)).toBe(prose);
});

// ── bearer/authorization: hardened false positives (measured on this repo's own source) ───────────

test("redact: a plain code destructure/assignment of `authorization` survives untouched", () => {
	const line = "const authorization = req.headers.authorization;";
	expect(redact(line)).toBe(line);
});

test("redact: a test-name string mentioning `authorization` with no secret survives untouched", () => {
	const line = "(fail) authorization middleware-check fails [0.16ms]";
	expect(redact(line)).toBe(line);
});

test("redact: a test-name string mentioning `bearer` with no secret survives untouched", () => {
	const line = "✗ bearer token-refresh flow";
	expect(redact(line)).toBe(line);
});

test("redact: a doc comment listing `authorization/token/userinfo/jwks` survives untouched", () => {
	const line = "AuthKit's standards-compliant OIDC discovery document. better-auth's genericOAuth reads\n" +
		"authorization/token/userinfo/jwks endpoints from here — we never hardcode them.";
	expect(redact(line)).toBe(line);
});

test("redact: a genuine `Authorization: Bearer <jwt>` header still redacts", () => {
	const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
	const out = redact(`Authorization: Bearer ${jwt}`);
	expect(out).not.toContain(jwt);
	expect(out).toBe("Authorization: Bearer [REDACTED]");
});

test("redact: a genuine `authorization=<value>` header still redacts", () => {
	expect(redact("authorization=SGVsbG8thisislong")).toBe("authorization [REDACTED]");
});

test("redact: a genuine bare `bearer <token>` value still redacts", () => {
	expect(redact("bearer abc123def456ghi789")).toBe("bearer [REDACTED]");
});

test("redact: bearer/authorization never crosses a newline to eat the next line's content", () => {
	const text = "authorization:\nconst nextLineIsCode = someFunctionCallThatIsNotASecretAtAll();";
	expect(redact(text)).toBe(text);
});

test("redact: the timing suffix on a failed-test line can't donate a digit across whitespace", () => {
	// `middleware-check` alone is the AUTH_TAIL candidate (space and `[` aren't in the tail charset,
	// so the charset run ends before `[0.16ms]`) and it has no digit — this must stay safe even though
	// digits exist later in the same line.
	const line = "(fail) authorization middleware-check fails [0.16ms]";
	expect(redact(line)).toBe(line);
});

test("redact: a dotted bearer token (Google OAuth ya29.… shape) still redacts", () => {
	const line = "Authorization: Bearer ya29.a0AfB_byDdE1234567890abc";
	const out = redact(line);
	expect(out).toBe("Authorization [REDACTED]");
	expect(out).not.toContain("ya29");
});

test("redact: a tail whose only digit is past position 12 still redacts", () => {
	expect(redact("authorization=AbCdEfGhIjKlMnOpQrSt99887766")).toBe("authorization [REDACTED]");
});

test("redact: a folded header (authorization:\\n  <value>) still redacts across the one allowed newline", () => {
	const out = redact("authorization:\n  c2VjcmV0dG9rZW4xMjM0NTY=");
	expect(out).toBe("authorization [REDACTED]");
});

test("redact: a folded NON-header (no separator) still never crosses the newline", () => {
	const text = "authorization\n  refreshSessionToken();";
	expect(redact(text)).toBe(text);
});

// ── ENV_LINE: lowercase key alternative (concern 02 regression from dropping the `i` flag) ────────

test("redact: a lowercase env assignment (password=) is redacted", () => {
	expect(redact("password=hunter2")).toBe("password=[REDACTED]");
});

test("redact: a lowercase exported key (export api_key=) is redacted", () => {
	expect(redact("export api_key=abc123")).toBe("export api_key=[REDACTED]");
});

test("redact: a mixed-case camelCase identifier (voiceTokenTtlWarned) is left untouched", () => {
	const line = "voiceTokenTtlWarned = true;";
	expect(redact(line)).toBe(line);
});

test("redact: a mixed-case key (Token=) is left untouched — deliberate false-negative cost of excluding camelCase", () => {
	const line = "Token=xyz";
	expect(redact(line)).toBe(line);
});

// ── private key: bounded span perf regression ───────────────────────────────────────────────────

test("redact: a real private-key block still redacts end to end", () => {
	const block = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----";
	expect(redact(block)).toBe("[REDACTED]");
});

test("redact: 1000 unmatched BEGIN PRIVATE KEY markers (no END) finishes well under 500ms", () => {
	const bomb = "-----BEGIN PRIVATE KEY-----\n".repeat(1000);
	const start = performance.now();
	redact(bomb);
	const elapsed = performance.now() - start;
	expect(elapsed).toBeLessThan(500);
});

// ── corpus regression fence ─────────────────────────────────────────────────────────────────────

/** Files that legitimately contain secret-SHAPED fixtures (mostly `sk-`-prefixed test keys used to
 *  exercise secret-storage/scrubbing paths) and are therefore EXPECTED to change under redact() —
 *  everything else in src/**\/*.ts and tests/**\/*.ts must round-trip byte-for-byte. Discovered by
 *  running the corpus scan below and inspecting every diff; each entry names why it's here. */
const ALLOWLIST = new Set<string>([
	"tests/redact.test.ts", // this file's own `sk-...`/JWT/env-line fixtures above, by design
	"tests/secrets.test.ts", // `sk-real-openai-key-1234567890` — a real secret-shaped fixture for the secret-storage path
	"tests/org-secret-rls.test.ts", // multiple `sk-...` org-secret fixtures exercising RLS-scoped secret storage
	"tests/voice-token.test.ts", // `sk-...` OpenAI-key fixtures for voice-token minting tests
	"tests/voice-spend.test.ts", // `sk-...` OpenAI-key fixtures for voice-spend accounting tests
	"tests/voice-org-admin.test.ts", // `sk-...` OpenAI-key fixtures (PUT/POST bodies + a bare candidate key) for org voice-key admin tests
	"tests/voice-org-role-binding.test.ts", // `sk-cross-tenant-attempt` — a deliberately secret-shaped fixture for a cross-tenant-key rejection test
	"tests/architect-harness-env.test.ts", // multiple `sk-...` provider-key fixtures proving env passthrough to a spawned harness
	"tests/spawn-env.test.ts", // multiple `sk-...` provider-key fixtures proving spawn-env scrubbing/injection
	"tests/transition-history.test.ts", // `sk-abcdefghijklmnopqrstuvwxyz012345` — a secret-shaped fixture for history-redaction coverage
]);

function collectTsFiles(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".git") continue;
		const full = path.join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) collectTsFiles(full, out);
		else if (entry.endsWith(".ts")) out.push(full);
	}
}

test("redact: corpus regression fence — repo source is unchanged by redact() except the allowlist", async () => {
	const repoRoot = path.join(import.meta.dir, "..");
	const files: string[] = [];
	collectTsFiles(path.join(repoRoot, "src"), files);
	collectTsFiles(path.join(repoRoot, "tests"), files);
	expect(files.length).toBeGreaterThan(50); // sanity: the scan actually walked something

	const unexpectedChanges: string[] = [];
	for (const file of files) {
		const rel = path.relative(repoRoot, file).split(path.sep).join("/");
		const content = await Bun.file(file).text();
		const out = redact(content);
		if (out !== content && !ALLOWLIST.has(rel)) unexpectedChanges.push(rel);
	}
	expect(unexpectedChanges).toEqual([]);
});

test("redact: corpus allowlist has no stale entries (every allowlisted file still actually changes)", async () => {
	const repoRoot = path.join(import.meta.dir, "..");
	const stale: string[] = [];
	for (const rel of ALLOWLIST) {
		const content = await Bun.file(path.join(repoRoot, rel)).text();
		if (redact(content) === content) stale.push(rel);
	}
	expect(stale).toEqual([]);
});
