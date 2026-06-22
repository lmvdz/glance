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
}

/** BetterAuth options over the shared dialect. Used both to migrate now and to instantiate auth in P1. */
export function authOptions({ dialect, type }: AuthConfig) {
	return {
		database: { dialect, type },
		secret: process.env.BETTER_AUTH_SECRET || "dev-insecure-secret-set-BETTER_AUTH_SECRET-in-prod",
		baseURL: process.env.BETTER_AUTH_URL || "http://localhost:7878",
		emailAndPassword: { enabled: true },
		plugins: [organization()],
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
