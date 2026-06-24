/**
 * SSRF guard for the browser-vision pass (OMPSQ-152).
 *
 * `POST /api/agents/:id/vision` drives the daemon's browser to load a caller-supplied URL and
 * screenshot it. Unconstrained, that is server-side request forgery: the daemon often sits on a
 * trusted host/tailnet and can reach cloud-metadata endpoints (169.254.169.254), loopback
 * services, and RFC1918 admin panels the remote caller cannot — and the screenshots return that
 * internal content to the caller.
 *
 * `checkVisionUrl` rejects anything that isn't a public http(s) target: non-http(s) schemes are
 * out, and the hostname is DNS-resolved with every resolved address checked against the private /
 * loopback / link-local / reserved ranges. The operator's configured app origin
 * (`OMP_SQUAD_APP_URL`) is the one allowlisted exception, so legitimately screenshotting the app
 * under test (commonly on localhost) still works once the operator opts in by setting it.
 *
 * ponytail: DNS is resolved once here, but the browser re-resolves when it actually loads the URL
 * — a DNS-rebinding window (TOCTOU) remains. Closing it requires pinning the resolved IP into the
 * browser fetch, which the omp/browser producer does not expose. Upgrade path: pin the IP (or run
 * the vision agent with `--network` restricted to the allowlist) when the producer supports it.
 */

import { lookup } from "node:dns/promises";

/** Outcome of an SSRF check: the parsed URL when allowed, or a human-readable reason it was blocked. */
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Origins exempt from the private-range block — the operator-configured app URL's origin. */
export function allowlistOrigins(): Set<string> {
	const out = new Set<string>();
	const app = process.env.OMP_SQUAD_APP_URL;
	if (app) {
		try {
			out.add(new URL(app).origin);
		} catch {
			/* a malformed OMP_SQUAD_APP_URL simply allowlists nothing */
		}
	}
	return out;
}

/** Dotted-quad → unsigned 32-bit int, or null if not a well-formed IPv4 literal. */
function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let n = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const v = Number(part);
		if (v > 255) return null;
		n = n * 256 + v;
	}
	return n >>> 0;
}

/** True if an IPv4 literal falls in a range we must never fetch (loopback, RFC1918, link-local, …). */
function v4Blocked(ip: string): boolean {
	const n = ipv4ToInt(ip);
	if (n === null) return false;
	const inRange = (base: string, bits: number): boolean => {
		const b = ipv4ToInt(base);
		if (b === null) return false;
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return (n & mask) === (b & mask);
	};
	return (
		inRange("0.0.0.0", 8) || // "this" network / unspecified
		inRange("10.0.0.0", 8) || // RFC1918
		inRange("100.64.0.0", 10) || // CGNAT
		inRange("127.0.0.0", 8) || // loopback
		inRange("169.254.0.0", 16) || // link-local incl. 169.254.169.254 metadata
		inRange("172.16.0.0", 12) || // RFC1918
		inRange("192.0.0.0", 24) || // IETF protocol assignments
		inRange("192.168.0.0", 16) || // RFC1918
		inRange("198.18.0.0", 15) || // benchmarking
		inRange("224.0.0.0", 4) || // multicast
		inRange("240.0.0.0", 4) // reserved / broadcast
	);
}

/** Parse an IPv6 literal (incl. `::` compression and embedded IPv4) to 16 bytes, or null. */
function parseV6(ip: string): number[] | null {
	const halves = ip.split("::");
	if (halves.length > 2) return null;
	const expand = (s: string): number[] | null => {
		if (s === "") return [];
		const out: number[] = [];
		for (const w of s.split(":")) {
			if (w.includes(".")) {
				const n = ipv4ToInt(w);
				if (n === null) return null;
				out.push((n >>> 16) & 0xffff, n & 0xffff);
			} else {
				if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null;
				out.push(parseInt(w, 16));
			}
		}
		return out;
	};
	const head = expand(halves[0]);
	if (!head) return null;
	let words: number[];
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		words = head;
	} else {
		const tail = expand(halves[1]);
		if (!tail) return null;
		const fill = 8 - (head.length + tail.length);
		if (fill < 0) return null;
		words = [...head, ...Array<number>(fill).fill(0), ...tail];
	}
	const bytes: number[] = [];
	for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
	return bytes;
}

/** True if an IPv6 literal is loopback/unspecified/ULA/link-local/multicast (or a blocked IPv4-mapped addr). */
function v6Blocked(ip: string): boolean {
	const b = parseV6(ip);
	if (!b) return false;
	if (b.every((x) => x === 0)) return true; // ::
	if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
	if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
		return v4Blocked(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`); // ::ffff:0:0/96 IPv4-mapped
	}
	if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
	if (b[0] === 0xff) return true; // ff00::/8 multicast
	return false;
}

/** True if a resolved IP literal (v4 or v6) is in a range the vision pass must not fetch. */
export function isBlockedIp(ip: string): boolean {
	return ip.includes(":") ? v6Blocked(ip) : v4Blocked(ip);
}

/**
 * Validate a vision target URL against SSRF. Allows only http(s); allowlisted origins
 * (`OMP_SQUAD_APP_URL`) pass without a range check; everything else is DNS-resolved and rejected
 * if ANY resolved address is private/loopback/link-local/reserved.
 */
export async function checkVisionUrl(raw: string, allow: Set<string> = allowlistOrigins()): Promise<UrlCheck> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: "invalid URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, reason: `scheme "${url.protocol}" not allowed — http(s) only` };
	}
	if (allow.has(url.origin)) return { ok: true, url };
	const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 literal brackets for the resolver
	let addrs: { address: string }[];
	try {
		addrs = await lookup(host, { all: true });
	} catch {
		return { ok: false, reason: `cannot resolve host "${host}"` };
	}
	if (addrs.length === 0) return { ok: false, reason: `cannot resolve host "${host}"` };
	for (const { address } of addrs) {
		if (isBlockedIp(address)) {
			return { ok: false, reason: `host "${host}" resolves to a private/loopback/link-local address (${address}) — set OMP_SQUAD_APP_URL to allowlist a trusted origin` };
		}
	}
	return { ok: true, url };
}
