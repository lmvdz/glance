/**
 * Golden coverage for the wedge's App-JWT minting (glance#337, rail T9, src/rail/wedge/jwt.ts). No
 * network involved — a real RSA keypair is generated locally and the minted JWT is verified against
 * it with `node:crypto`'s `createVerify`, so this exercises the whole sign/verify round trip rather
 * than trusting the shape of the output.
 */
import { expect, test } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mintAppJwt } from "../src/rail/index.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function decodeSegment(seg: string): unknown {
	return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

test("mintAppJwt: three dot-separated base64url segments, RS256 header", () => {
	const jwt = mintAppJwt("12345", privateKey, Date.parse("2026-08-04T12:00:00Z"));
	const parts = jwt.split(".");
	expect(parts).toHaveLength(3);
	expect(parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))).toBe(true);
	const header = decodeSegment(parts[0]) as { alg: string; typ: string };
	expect(header).toEqual({ alg: "RS256", typ: "JWT" });
});

test("mintAppJwt: payload carries iss=appId, iat backdated 60s, exp exactly 600s after iat", () => {
	const nowMs = Date.parse("2026-08-04T12:00:00Z");
	const jwt = mintAppJwt("987654", privateKey, nowMs);
	const [, payloadSeg] = jwt.split(".");
	const payload = decodeSegment(payloadSeg) as { iat: number; exp: number; iss: string };
	expect(payload.iss).toBe("987654");
	expect(payload.iat).toBe(Math.floor(nowMs / 1000) - 60);
	expect(payload.exp - payload.iat).toBe(600);
	// exp must never exceed GitHub's 10-minute cap past "now" even after the 60s backdate.
	expect(payload.exp).toBeLessThanOrEqual(Math.floor(nowMs / 1000) + 600);
});

test("mintAppJwt: signature verifies against the matching public key", () => {
	const jwt = mintAppJwt("1", privateKey, Date.now());
	const [headerSeg, payloadSeg, sigSeg] = jwt.split(".");
	const signingInput = `${headerSeg}.${payloadSeg}`;
	const signature = Buffer.from(sigSeg, "base64url");
	const ok = createVerify("RSA-SHA256").update(signingInput).verify(publicKey, signature);
	expect(ok).toBe(true);
});

test("mintAppJwt: signature does NOT verify against a different key (not a rubber stamp)", () => {
	const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
	const jwt = mintAppJwt("1", privateKey, Date.now());
	const [headerSeg, payloadSeg, sigSeg] = jwt.split(".");
	const signingInput = `${headerSeg}.${payloadSeg}`;
	const signature = Buffer.from(sigSeg, "base64url");
	const ok = createVerify("RSA-SHA256").update(signingInput).verify(other.publicKey, signature);
	expect(ok).toBe(false);
});

test("mintAppJwt: throws on a malformed private key, never returns an unsigned token", () => {
	expect(() => mintAppJwt("1", "not a pem key")).toThrow(/invalid RSA private key/);
});

test("mintAppJwt: is deterministic for a fixed nowMs (no hidden randomness / real-clock leakage)", () => {
	const nowMs = Date.parse("2026-01-01T00:00:00Z");
	const a = mintAppJwt("42", privateKey, nowMs);
	const b = mintAppJwt("42", privateKey, nowMs);
	expect(a).toBe(b);
});
