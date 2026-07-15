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

// webapp-voice-lane: connect-src names the keyed provider ONLY while the lane is armed — the SDP
// offer is a browser-origin fetch, so 'self' alone kills every call silently after a good mint
// (live-found). Both directions pinned: flag+key widens; flag-off or keyless stays tight.
test("CSP connect-src widens to the voice provider origin only when flag AND key are both present", () => {
	const stash = { flag: process.env.OMP_SQUAD_VOICE_ENABLED, key: process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY };
	try {
		process.env.OMP_SQUAD_VOICE_ENABLED = "1";
		process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
		expect(securityHeaders()["Content-Security-Policy"]).toContain("connect-src 'self' https://api.openai.com;");

		process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "";
		expect(securityHeaders()["Content-Security-Policy"]).toContain("connect-src 'self';"); // keyless: tight

		process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
		process.env.OMP_SQUAD_VOICE_ENABLED = "0";
		expect(securityHeaders()["Content-Security-Policy"]).toContain("connect-src 'self';"); // flag-off: tight
	} finally {
		if (stash.flag === undefined) delete process.env.OMP_SQUAD_VOICE_ENABLED;
		else process.env.OMP_SQUAD_VOICE_ENABLED = stash.flag;
		if (stash.key === undefined) delete process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY;
		else process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = stash.key;
	}
});

// plans/voice-db-mode/07-csp-and-org-switch.md: DB mode has no per-org key to check at this
// (nullary, response-header-path) call site, so it widens on the flag ALONE — unlike file mode
// above, which still needs the env key too. Matrix over both modes x both flag states.
test("CSP connect-src: DB mode widens on the flag alone; file mode still needs the env key too", () => {
	const stash = {
		flag: process.env.OMP_SQUAD_VOICE_ENABLED,
		key: process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY,
		dbUrl: process.env.DATABASE_URL,
	};
	try {
		delete process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY; // DB mode never reads this — file-mode-only lane

		// DB mode + flag on ⇒ widened, with NO env key configured at all.
		process.env.DATABASE_URL = "sqlite::memory:";
		process.env.OMP_SQUAD_VOICE_ENABLED = "1";
		expect(securityHeaders()["Content-Security-Policy"]).toContain("connect-src 'self' https://api.openai.com;");

		// DB mode + flag off ⇒ tight, same as file mode.
		process.env.OMP_SQUAD_VOICE_ENABLED = "0";
		expect(securityHeaders()["Content-Security-Policy"]).toContain("connect-src 'self';");

		// File mode (no DATABASE_URL) + flag on + no env key ⇒ still tight — the file-mode condition
		// above is untouched by this concern.
		delete process.env.DATABASE_URL;
		process.env.OMP_SQUAD_VOICE_ENABLED = "1";
		expect(securityHeaders()["Content-Security-Policy"]).toContain("connect-src 'self';");
	} finally {
		if (stash.flag === undefined) delete process.env.OMP_SQUAD_VOICE_ENABLED;
		else process.env.OMP_SQUAD_VOICE_ENABLED = stash.flag;
		if (stash.key === undefined) delete process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY;
		else process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = stash.key;
		if (stash.dbUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = stash.dbUrl;
	}
});
