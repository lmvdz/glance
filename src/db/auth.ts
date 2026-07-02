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
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Dialect } from "kysely";
import type { DbKind } from "./index.ts";
import { workosConfig, workosDiscoveryUrl } from "../workos.ts";

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

/** GitHub OAuth is wired ONLY when BOTH client id and secret are present; otherwise the fleet stays
 *  email+password only. Callback URL better-auth expects on the GitHub app: <baseURL>/api/auth/callback/github. */
function githubProvider(): { clientId: string; clientSecret: string } | undefined {
	const clientId = process.env.GITHUB_CLIENT_ID;
	const clientSecret = process.env.GITHUB_CLIENT_SECRET;
	return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Social providers with credentials configured — advertised at /api/auth/mode so the login UI only
 *  renders a button the server can actually service (no dead "Login with GitHub" when unconfigured). */
export function configuredSocialProviders(): string[] {
	return githubProvider() ? ["github"] : [];
}

/** Whether self-service email sign-up is open. Mirrors the disableSignUp gate below so the UI can hide
 *  the "Sign up" affordance on a closed (invite/bootstrap-only) fleet. */
export function signupOpen(): boolean {
	return process.env.OMP_SQUAD_ALLOW_SIGNUP === "1";
}

/** BetterAuth options over the shared dialect. Used both to migrate now and to instantiate auth in P1. */
export function authOptions({ dialect, type, trustedOrigins, baseURL }: AuthConfig) {
	const resolvedBase = baseURL || process.env.BETTER_AUTH_URL || "http://localhost:7878";
	const github = githubProvider();
	const workos = workosConfig();
	// Enterprise SSO via WorkOS AuthKit as a single OIDC upstream: one client multiplexes every customer's
	// SAML/OIDC/social connection, and better-auth mints the local session in /api/auth/oauth2/callback/workos.
	// New SSO users bridge to viewer (no org) until mapped to an org — org auto-mapping is the documented
	// follow-up (docs/workos-sso.md), so this stays a safe, additive sign-in path.
	const ssoPlugins = workos
		? [genericOAuth({
			config: [{
				providerId: "workos",
				clientId: workos.clientId,
				clientSecret: workos.apiKey,
				discoveryUrl: workosDiscoveryUrl(workos.clientId),
				scopes: ["openid", "profile", "email"],
				pkce: true,
				// WorkOS's /authorize requires an IdP selector. provider=authkit routes to AuthKit's hosted
				// screen (email-first detection across every connection + social) — the "one button, all IdPs"
				// UX. Per-tenant pinning later swaps this for organization_id/connection_id (can be a fn of ctx).
				authorizationUrlParams: { provider: "authkit" },
				mapProfileToUser: (profile: Record<string, unknown>) => {
					const name =
						(typeof profile.name === "string" && profile.name) ||
						[profile.given_name, profile.family_name].filter((p) => typeof p === "string").join(" ").trim() ||
						(typeof profile.email === "string" ? profile.email : "");
					return {
						email: typeof profile.email === "string" ? profile.email : undefined,
						name: name || undefined,
						image: typeof profile.picture === "string" ? profile.picture : undefined,
					};
				},
			}],
		})]
		: [];
	return {
		database: { dialect, type },
		secret: process.env.BETTER_AUTH_SECRET || DEV_INSECURE_SECRET,
		baseURL: resolvedBase,
		// Sign-up is CLOSED by default (no open registration on a shared fleet); set OMP_SQUAD_ALLOW_SIGNUP=1
		// to open it. New/no-org users bridge to `viewer` (read-only) until an admin adds them to an org.
		emailAndPassword: { enabled: true, disableSignUp: process.env.OMP_SQUAD_ALLOW_SIGNUP !== "1" },
		// allowUserToCreateOrganization:false ⇒ org ownership (→ admin tier) can't be self-minted;
		// the loopback bootstrap admin provisions the first org/members out-of-band.
		plugins: [organization({ allowUserToCreateOrganization: false }), ...ssoPlugins],
		// Throttle sign-in/up regardless of NODE_ENV (better-auth only rate-limits in production by default).
		rateLimit: { enabled: true, window: 60, max: 30 },
		// Secure cookies when the public origin is https (e.g. behind a TLS tunnel); plain http for loopback dev.
		advanced: { useSecureCookies: resolvedBase.startsWith("https://") },
		// Social login: GitHub only when credentials are present (see githubProvider). New social users land
		// with no org ⇒ bridge to viewer (read-only) until an admin adds them, same as a fresh email user.
		...(github ? { socialProviders: { github } } : {}),
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
