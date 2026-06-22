/**
 * BetterAuth configuration + programmatic schema migration (MT-SaaS P0).
 *
 * BetterAuth OWNS its tables (user/session/account/verification + the
 * organization plugin's organization/member/invitation). We never hand-roll
 * that schema; we run BetterAuth's own migrator against the shared dialect so
 * the `organization` table exists before the app migrations FK to it.
 *
 * P0 scope is the SCHEMA only — full auth wiring (request handlers, providers,
 * sessions) is P1. So this builds options sufficient to migrate and nothing
 * more; `secret`/`baseURL` come from env when present so the same config later
 * grows into the live auth instance.
 */

import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins/organization";
import type { Dialect } from "kysely";
import type { DbKind } from "./index.ts";

export interface AuthConfig {
	dialect: Dialect;
	type: DbKind;
	/** Same-origin daemon origins the SPA fetches from (loopback/LAN/tailnet). Added to better-auth's origin allowlist. */
	trustedOrigins?: string[];
	/** Public base URL of the auth surface; overrides the BETTER_AUTH_URL/localhost default. */
	baseURL?: string;
}

/** The placeholder session-signing secret. Used ONLY as a loopback-dev fallback when
 *  BETTER_AUTH_SECRET is unset; boot refuses it on a non-loopback bind (see secretBootDecision in index.ts). */
export const DEV_INSECURE_SECRET = "dev-insecure-secret-set-BETTER_AUTH_SECRET-in-prod";

/** BetterAuth options over the shared dialect. Used both to migrate now and to instantiate auth in P1. */
export function authOptions({ dialect, type, trustedOrigins, baseURL }: AuthConfig) {
	const resolvedBase = baseURL || process.env.BETTER_AUTH_URL || "http://localhost:7878";
	return {
		database: { dialect, type },
		secret: process.env.BETTER_AUTH_SECRET || DEV_INSECURE_SECRET,
		baseURL: resolvedBase,
		// Sign-up is CLOSED by default (no open registration on a shared fleet); set OMP_SQUAD_ALLOW_SIGNUP=1
		// to open it. New/no-org users bridge to `viewer` (read-only) until an admin adds them to an org.
		emailAndPassword: { enabled: true, disableSignUp: process.env.OMP_SQUAD_ALLOW_SIGNUP !== "1" },
		// allowUserToCreateOrganization:false ⇒ org ownership (→ admin tier) can't be self-minted;
		// the loopback bootstrap admin provisions the first org/members out-of-band.
		plugins: [organization({ allowUserToCreateOrganization: false })],
		// Throttle sign-in/up regardless of NODE_ENV (better-auth only rate-limits in production by default).
		rateLimit: { enabled: true, window: 60, max: 30 },
		// Secure cookies when the public origin is https (e.g. behind a TLS tunnel); plain http for loopback dev.
		advanced: { useSecureCookies: resolvedBase.startsWith("https://") },
		...(trustedOrigins && trustedOrigins.length ? { trustedOrigins } : {}),
	};
}

/** Build the live BetterAuth instance (P1 will mount its handler; here it validates the config typechecks). */
export function makeAuth(config: AuthConfig) {
	return betterAuth(authOptions(config));
}

/** Run BetterAuth's own migrations against the shared dialect (creates organization + auth tables). */
export async function migrateAuth(config: AuthConfig): Promise<void> {
	const { runMigrations } = await getMigrations(authOptions(config));
	await runMigrations();
}
