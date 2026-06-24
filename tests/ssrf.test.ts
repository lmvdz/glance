/**
 * SSRF guard (OMPSQ-152) — checkVisionUrl must reject anything that lets the daemon's browser
 * reach a private/loopback/link-local/metadata target, while allowing public http(s) hosts and
 * the operator-allowlisted OMP_SQUAD_APP_URL origin.
 *
 * Hostnames here resolve without a network: literal IPs short-circuit DNS, and `localhost`
 * resolves to loopback locally. No external lookups are made.
 */

import { afterEach, expect, test } from "bun:test";
import { allowlistOrigins, checkVisionUrl, isBlockedIp } from "../src/ssrf.ts";

const savedApp = process.env.OMP_SQUAD_APP_URL;
afterEach(() => {
	if (savedApp === undefined) delete process.env.OMP_SQUAD_APP_URL;
	else process.env.OMP_SQUAD_APP_URL = savedApp;
});

test("isBlockedIp: private/loopback/link-local/reserved blocked; public allowed", () => {
	for (const ip of ["169.254.169.254", "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.5.5", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
		expect(isBlockedIp(ip)).toBe(true);
	}
	for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
		expect(isBlockedIp(ip)).toBe(false);
	}
});

test("checkVisionUrl: blocks the cloud-metadata IP", async () => {
	delete process.env.OMP_SQUAD_APP_URL;
	const r = await checkVisionUrl("http://169.254.169.254/latest/meta-data/");
	expect(r.ok).toBe(false);
});

test("checkVisionUrl: blocks loopback by hostname (localhost) and literal", async () => {
	delete process.env.OMP_SQUAD_APP_URL;
	expect((await checkVisionUrl("http://localhost:3000/")).ok).toBe(false);
	expect((await checkVisionUrl("http://127.0.0.1:8080/")).ok).toBe(false);
	expect((await checkVisionUrl("http://[::1]/")).ok).toBe(false);
});

test("checkVisionUrl: rejects non-http(s) schemes", async () => {
	delete process.env.OMP_SQUAD_APP_URL;
	for (const u of ["file:///etc/passwd", "gopher://x/", "ftp://host/x", "data:text/html,x"]) {
		const r = await checkVisionUrl(u);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("http(s) only");
	}
});

test("checkVisionUrl: rejects a malformed URL", async () => {
	const r = await checkVisionUrl("not a url");
	expect(r.ok).toBe(false);
});

test("checkVisionUrl: allowlists the OMP_SQUAD_APP_URL origin even on loopback", async () => {
	process.env.OMP_SQUAD_APP_URL = "http://localhost:3000";
	// Same origin (any path) passes despite resolving to loopback.
	const ok = await checkVisionUrl("http://localhost:3000/dashboard");
	expect(ok.ok).toBe(true);
	// A different loopback port is NOT the allowlisted origin — still blocked.
	const blocked = await checkVisionUrl("http://localhost:9999/");
	expect(blocked.ok).toBe(false);
	expect(allowlistOrigins().has("http://localhost:3000")).toBe(true);
});

test("checkVisionUrl: allows a public host (IP literal, no external DNS)", async () => {
	delete process.env.OMP_SQUAD_APP_URL;
	const r = await checkVisionUrl("https://8.8.8.8/");
	expect(r.ok).toBe(true);
});
