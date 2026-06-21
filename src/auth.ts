/**
 * auth.ts — bearer-token gate for the squad daemon's HTTP + WS surface.
 *
 * The control plane can spawn agents, land code, and re-exec the daemon
 * (`/api/upgrade`), so the moment it binds anywhere but loopback it MUST require
 * a secret. The token persists in the state dir (mode 0600) and is printed once
 * on boot. A request carries it as `Authorization: Bearer <t>` (fetch) or
 * `?token=<t>` (WebSocket — browsers can't set custom headers on a WS handshake).
 * Comparison is constant-time. Auth is enforced only when a token is configured,
 * so unit tests that construct a tokenless server stay unauthenticated.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const TOKEN_FILE = "access-token";

/** Read the persisted access token, generating + persisting one on first run. */
export async function loadOrCreateToken(stateDir: string): Promise<string> {
	const file = path.join(stateDir, TOKEN_FILE);
	try {
		const existing = (await fs.readFile(file, "utf8")).trim();
		if (existing) return existing;
	} catch {
		// missing → create below
	}
	const token = randomBytes(24).toString("base64url");
	await fs.mkdir(stateDir, { recursive: true });
	await fs.writeFile(file, `${token}\n`, { mode: 0o600 });
	return token;
}

/** Pull the presented token from the Authorization header (preferred) or the `token` query param (WS). */
export function requestToken(req: Request): string | undefined {
	const auth = req.headers.get("authorization");
	if (auth && auth.startsWith("Bearer ")) {
		const t = auth.slice("Bearer ".length).trim();
		if (t) return t;
	}
	const q = new URL(req.url).searchParams.get("token");
	return q ?? undefined;
}

/** Constant-time token check. Unequal lengths short-circuit (token length is not secret). */
export function tokenOk(provided: string | undefined, expected: string): boolean {
	if (!provided) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
