/**
 * auth.ts — bearer-token gate for the squad daemon's HTTP + WS surface.
 *
 * The control plane can spawn agents, land code, and re-exec the daemon
 * (`/api/upgrade`), so the moment it binds anywhere but loopback it MUST require
 * a secret. The token persists in the state dir (mode 0600) and is printed once
 * on boot. A request carries it as `Authorization: Bearer <t>` (REST/CLI) or, for
 * the WebSocket handshake (browsers can't set custom WS headers), as a
 * `Sec-WebSocket-Protocol: ompsq-token, <t>` subprotocol pair.
 * Comparison is constant-time. Auth is enforced only when a token is configured,
 * so unit tests that construct a tokenless server stay unauthenticated.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Actor, ClientCommand, Role } from "./types.ts";

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

/** Pull the presented token from the Authorization header (REST/CLI) or, for the WS handshake, the `Sec-WebSocket-Protocol` subprotocol (the offered entry that is not the `ompsq-token` sentinel). */
export function requestToken(req: Request): string | undefined {
	const auth = req.headers.get("authorization");
	if (auth && auth.startsWith("Bearer ")) {
		const t = auth.slice("Bearer ".length).trim();
		if (t) return t;
	}
	const proto = req.headers.get("sec-websocket-protocol");
	if (proto) {
		for (const p of proto.split(",")) {
			const t = p.trim();
			if (t && t !== "ompsq-token") return t;
		}
	}
	return undefined;
}

/** Constant-time token check. Unequal lengths short-circuit (token length is not secret). */
export function tokenOk(provided: string | undefined, expected: string): boolean {
	if (!provided) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// ── RBAC ─────────────────────────────────────────────────────────────────────
// Three capability tiers gate every mutation. The single bearer token used to be
// all-or-nothing; it now maps to `admin`, and optional operator/viewer tokens grant
// the lower tiers. Enforcement happens twice — at the REST/WS surface (this module's
// `requiredRole`) and at the manager's single `applyCommand` chokepoint (`commandRole`)
// — so no surface, present or future (federation peers), can bypass it.

/** Ascending capability rank; a higher tier subsumes every lower one. */
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

/** True if `have` satisfies the `need` tier (equal or higher). */
export function roleAtLeast(have: Role, need: Role): boolean {
	return RANK[have] >= RANK[need];
}

/** Token → role map. The legacy `admin` token is the daemon's primary token; the
 *  operator/viewer tokens are optional. Auth is OFF (every request is admin) only when
 *  none are set, preserving the loopback unit-test mode. */
export type AuthPolicy = Partial<Record<Role, string>>;

/** Whether any token is configured. When false, the gate is open (unit-test / loopback mode). */
export function authEnabled(policy: AuthPolicy): boolean {
	return Boolean(policy.admin || policy.operator || policy.viewer);
}

/** Resolve the tier a request's token grants. `null` ⇒ unauthenticated (caller returns 401).
 *  With no tokens configured, auth is off and every request resolves to `admin`. Highest
 *  matching tier wins; the compare is constant-time per `tokenOk`. */
export function resolveRole(req: Request, policy: AuthPolicy): Role | null {
	if (!authEnabled(policy)) return "admin";
	const provided = requestToken(req);
	for (const role of ["admin", "operator", "viewer"] as const) {
		const expected = policy[role];
		if (expected && tokenOk(provided, expected)) return role;
	}
	return null;
}

/** The effective tier an actor commands. Explicit role wins; otherwise local surfaces are
 *  trusted (admin) and remote peers default to read-only (viewer). */
export function effectiveRole(actor: Actor): Role {
	return actor.role ?? (actor.origin === "local" ? "admin" : "viewer");
}

/** Minimum tier a `ClientCommand` requires. Reads (`snapshot`/`subscribe`) need `viewer`;
 *  every state mutation needs `operator`. (No command re-execs the daemon — that is the
 *  admin-only `/api/upgrade` REST route.) */
export function commandRole(cmd: ClientCommand): Role {
	return cmd.type === "snapshot" || cmd.type === "subscribe" ? "viewer" : "operator";
}

/** Minimum tier a REST route requires. `/api/upgrade` re-execs the daemon (admin); reads are
 *  `viewer`; auth/check + push registration are any-authenticated (`viewer`); all other
 *  methods mutate (`operator`). */
export function requiredRole(method: string, pathname: string): Role {
	if (pathname === "/api/upgrade") return "admin";
	if (pathname === "/api/auth/check" || pathname.startsWith("/api/push/")) return "viewer";
	return method === "GET" ? "viewer" : "operator";
}

/** Synthesize the actor for a token-authenticated surface request, carrying its resolved tier. */
export function actorForRole(role: Role): Actor {
	return { id: `web:${role}`, origin: "local", role };
}

/** Thrown by `applyCommand` when an actor's tier is below the command's requirement. */
export class RbacDenied extends Error {
	constructor(
		readonly need: Role,
		readonly have: Role,
		what: string,
	) {
		super(`forbidden: "${what}" requires ${need}, actor has ${have}`);
		this.name = "RbacDenied";
	}
}
