/**
 * Secret-shape redaction — verifies the high-value vendor formats and the
 * KEY=value env-line rule collapse to [REDACTED], while ordinary prose is left
 * byte-for-byte intact (no false positives that would corrupt a digest).
 */

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
