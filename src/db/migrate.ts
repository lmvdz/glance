/**
 * Migration orchestrator: BetterAuth schema first (creates `organization`),
 * then app tables + the RLS backstop (which FK to it). Idempotent — safe to run
 * on every boot in DB mode.
 */

import type { Kysely, Dialect } from "kysely";
import { migrateAuth } from "./auth.ts";
import type { DbKind } from "./index.ts";
import { migrateApp } from "./migrations.ts";
import type { AppDatabase } from "./schema.ts";

export async function migrateAll(db: Kysely<AppDatabase>, dialect: Dialect, type: DbKind): Promise<void> {
	await migrateAuth({ dialect, type });
	await migrateApp(db, type);
}
