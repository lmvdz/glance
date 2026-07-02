import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseWorkosEvent, ssoEnabled, verifyWorkosSignature, workosConfig, workosDiscoveryUrl } from "../src/workos.ts";

const KEYS = ["WORKOS_CLIENT_ID", "WORKOS_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

test("WorkOS SSO is gated on BOTH client id and api key", () => {
	delete process.env.WORKOS_CLIENT_ID;
	delete process.env.WORKOS_API_KEY;
	expect(ssoEnabled()).toBe(false);
	expect(workosConfig()).toBeUndefined();

	process.env.WORKOS_CLIENT_ID = "client_123";
	expect(ssoEnabled()).toBe(false); // key still missing
	process.env.WORKOS_API_KEY = "sk_abc";
	expect(ssoEnabled()).toBe(true);
	expect(workosConfig()).toEqual({ clientId: "client_123", apiKey: "sk_abc" });
});

test("AuthKit OIDC discovery URL is built from the client id", () => {
	expect(workosDiscoveryUrl("client_01KC")).toBe(
		"https://api.workos.com/user_management/client_01KC/.well-known/openid-configuration",
	);
});

// --- Webhook signature verification (the security boundary) ---

const SECRET = "whsec_test_secret";
function sign(body: string, ts: number, secret = SECRET): string {
	const v1 = createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
	return `t=${ts}, v1=${v1}`;
}

test("verifyWorkosSignature accepts a correctly signed, in-window payload", () => {
	const now = 1_700_000_000_000;
	const body = JSON.stringify({ event: "dsync.user.created", id: "event_1", data: { id: "u1" } });
	const res = verifyWorkosSignature({ rawBody: body, sigHeader: sign(body, now), secret: SECRET, now });
	expect(res.ok).toBe(true);
});

test("verifyWorkosSignature rejects a tampered body", () => {
	const now = 1_700_000_000_000;
	const body = JSON.stringify({ event: "dsync.user.created", id: "event_1", data: {} });
	const header = sign(body, now);
	const res = verifyWorkosSignature({ rawBody: body + "x", sigHeader: header, secret: SECRET, now });
	expect(res).toEqual({ ok: false, reason: "signature mismatch" });
});

test("verifyWorkosSignature rejects the wrong secret", () => {
	const now = 1_700_000_000_000;
	const body = "{}";
	const res = verifyWorkosSignature({ rawBody: body, sigHeader: sign(body, now, "whsec_other"), secret: SECRET, now });
	expect(res).toEqual({ ok: false, reason: "signature mismatch" });
});

test("verifyWorkosSignature rejects a stale timestamp (replay)", () => {
	const signedAt = 1_700_000_000_000;
	const body = "{}";
	const header = sign(body, signedAt);
	const now = signedAt + 6 * 60 * 1000; // 6 min later, beyond the 5 min tolerance
	const res = verifyWorkosSignature({ rawBody: body, sigHeader: header, secret: SECRET, now });
	expect(res).toEqual({ ok: false, reason: "timestamp outside tolerance" });
});

test("verifyWorkosSignature rejects a missing or malformed header", () => {
	const now = 1_700_000_000_000;
	expect(verifyWorkosSignature({ rawBody: "{}", sigHeader: null, secret: SECRET, now })).toEqual({
		ok: false,
		reason: "missing signature header",
	});
	expect(verifyWorkosSignature({ rawBody: "{}", sigHeader: "garbage", secret: SECRET, now })).toEqual({
		ok: false,
		reason: "malformed signature header",
	});
});

test("parseWorkosEvent extracts the envelope and rejects junk", () => {
	const evt = parseWorkosEvent(JSON.stringify({ event: "dsync.user.deleted", id: "event_9", data: { id: "u9" }, created_at: "2026-07-02" }));
	expect(evt).toEqual({ event: "dsync.user.deleted", id: "event_9", data: { id: "u9" }, createdAt: "2026-07-02" });
	expect(parseWorkosEvent("not json")).toBeNull();
	expect(parseWorkosEvent(JSON.stringify({ id: "x" }))).toBeNull(); // no event
	expect(parseWorkosEvent(JSON.stringify(["a"]))).toBeNull();
});
