/**
 * ws-auth — F-2 (WS token rides the Sec-WebSocket-Protocol subprotocol, never the
 * URL query) and F-3 (the security response-header set).
 */

import { expect, test } from "bun:test";
import { requestToken } from "../src/auth.ts";
import { securityHeaders } from "../src/server.ts";

test("requestToken reads the non-sentinel WS subprotocol, ignores ?token=, and honors Bearer", () => {
	// F-2: the token is the Sec-WebSocket-Protocol entry that is not the `ompsq-token` sentinel.
	expect(
		requestToken(new Request("http://x/ws", { headers: { "sec-websocket-protocol": "ompsq-token, ABC-123_xy" } })),
	).toBe("ABC-123_xy");
	// The query-param fallback is gone entirely — a token in the URL is never honored.
	expect(requestToken(new Request("http://x/ws?token=SHOULD_IGNORE"))).toBeUndefined();
	// REST + CLI still authenticate via the Authorization header.
	expect(requestToken(new Request("http://x/api", { headers: { authorization: "Bearer XYZ" } }))).toBe("XYZ");
});

test("securityHeaders sets the hardening set with an inline-safe, exfil-blocking CSP", () => {
	const h = securityHeaders();
	expect(h["X-Content-Type-Options"]).toBe("nosniff");
	expect(h["X-Frame-Options"]).toBe("DENY");
	const csp = h["Content-Security-Policy"];
	expect(csp).toContain("connect-src 'self'"); // compensating control: no cross-origin exfil
	expect(csp).toContain("frame-ancestors 'none'");
});
