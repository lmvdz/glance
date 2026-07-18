/**
 * ws-auth — F-2 (WS token rides the Sec-WebSocket-Protocol subprotocol, never the
 * URL query) and F-3 (the security response-header set).
 */

import { describe, expect, test } from "bun:test";
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

// D0 (glance-desktop dashboard embedding prerequisite): OMP_SQUAD_FRAME_ANCESTORS opt-in.
// Default-unset behavior must stay byte-identical to the pinned assertions above — this block
// only adds NEW coverage for the opt-in path, it never loosens the default-off case.
describe("OMP_SQUAD_FRAME_ANCESTORS opt-in (D0 desktop-embed prerequisite)", () => {
	const KEY = "OMP_SQUAD_FRAME_ANCESTORS";

	function withEnv(value: string | undefined, fn: () => void) {
		const stash = process.env[KEY];
		try {
			if (value === undefined) delete process.env[KEY];
			else process.env[KEY] = value;
			fn();
		} finally {
			if (stash === undefined) delete process.env[KEY];
			else process.env[KEY] = stash;
		}
	}

	test("unset: headers are exactly the default-deny set (frame-ancestors 'none' + XFO DENY) — provably unchanged", () => {
		withEnv(undefined, () => {
			const h = securityHeaders();
			expect(h["X-Frame-Options"]).toBe("DENY");
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
			expect(h["Content-Security-Policy"]).not.toContain("frame-ancestors tauri:");
		});
	});

	test("blank/whitespace-only: treated exactly like unset (default-deny, XFO present)", () => {
		withEnv("   ", () => {
			const h = securityHeaders();
			expect(h["X-Frame-Options"]).toBe("DENY");
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
		});
	});

	test("valid single origin: frame-ancestors names it, X-Frame-Options is OMITTED (not merely DENY)", () => {
		withEnv("tauri://localhost", () => {
			const h = securityHeaders();
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors tauri://localhost");
			expect(h["Content-Security-Policy"]).not.toContain("frame-ancestors 'none'");
			expect("X-Frame-Options" in h).toBe(false);
		});
	});

	test("valid multi-origin allowlist (the desktop shell's two webview origins): both appear, space-separated, in order", () => {
		withEnv("tauri://localhost http://tauri.localhost", () => {
			const h = securityHeaders();
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors tauri://localhost http://tauri.localhost");
			expect("X-Frame-Options" in h).toBe(false);
		});
	});

	test("the exact CSP string, opted in: every other directive is untouched, only frame-ancestors changes", () => {
		withEnv("tauri://localhost", () => {
			const h = securityHeaders();
			expect(h["Content-Security-Policy"]).toBe(
				"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors tauri://localhost",
			);
			expect(h["X-Content-Type-Options"]).toBe("nosniff");
			expect(h["Referrer-Policy"]).toBe("no-referrer");
		});
	});

	test.each([
		"*",
		"http:",
		"https:",
		"null",
		"* tauri://localhost",
		"tauri://localhost *",
		// non-web schemes must never become a frame-ancestors source (adversarial review):
		"javascript://a",
		"data://a",
		"blob://null",
		"file://localhost",
		"ftp://evil.com",
		"ws://localhost",
		// bad host / port / IPv4-games that a syntax-only regex let through (adversarial review):
		"https://evil.com:99999",
		"https://evil.com:65536",
		"http://evil..com",
		"http://0x7f000001",
		"http://2130706433",
		// non-canonical forms must not round-trip: uppercase scheme, trailing slash/dot, userinfo:
		"HTTP://tauri.localhost",
		"http://tauri.localhost/",
		"http://tauri.localhost.",
		"http://user:pass@tauri.localhost",
		// one junk token voids an otherwise-valid neighbor:
		"tauri://localhost ftp://evil.com",
	])("rejected outright, falls back to default-deny: %s", (bad) => {
		withEnv(bad, () => {
			const h = securityHeaders();
			expect(h["X-Frame-Options"]).toBe("DENY");
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
			expect(h["Content-Security-Policy"]).not.toContain("frame-ancestors tauri:");
			expect(h["Content-Security-Policy"]).not.toContain("frame-ancestors http");
		});
	});

	test("unset path is byte-identical to pre-D0: exact header keys AND insertion order", () => {
		withEnv(undefined, () => {
			const h = securityHeaders();
			// The wire header order (X-Frame-Options BEFORE Referrer-Policy) is the pre-D0 order;
			// a drift here is the "byte-identical when unset" regression the adversarial review found.
			expect(Object.keys(h)).toEqual([
				"Content-Security-Policy",
				"X-Content-Type-Options",
				"X-Frame-Options",
				"Referrer-Policy",
			]);
		});
	});

	test("garbage / unparseable tokens fail the WHOLE value closed, even alongside an otherwise-valid origin", () => {
		withEnv("tauri://localhost not-an-origin", () => {
			const h = securityHeaders();
			expect(h["X-Frame-Options"]).toBe("DENY");
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
			expect(h["Content-Security-Policy"]).not.toContain("tauri://localhost");
		});
	});

	test("a path/query/fragment on an otherwise-valid origin is rejected (not a bare origin)", () => {
		withEnv("tauri://localhost/some/path", () => {
			const h = securityHeaders();
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
		});
	});

	test("extra whitespace between origins is tolerated (split on runs of whitespace)", () => {
		withEnv("tauri://localhost   http://tauri.localhost", () => {
			const h = securityHeaders();
			expect(h["Content-Security-Policy"]).toContain("frame-ancestors tauri://localhost http://tauri.localhost");
		});
	});
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
