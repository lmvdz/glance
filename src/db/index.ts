/**
 * DB foundation entrypoint (MT-SaaS P0).
 *
 * Boot-time mode select: no `DATABASE_URL` ⇒ file/single-tenant mode (today's
 * behavior, untouched); `DATABASE_URL` set ⇒ DB mode — open a Kysely instance
 * over the right dialect, run migrations (BetterAuth schema then app tables +
 * RLS), and hand back a `DbHandle`.
 *
 * One dialect instance is built and shared between BetterAuth's internal Kysely
 * and the app's Kysely so they target the SAME database — critical for in-memory
 * SQLite, where each connection is otherwise its own private database.
 */

import { Kysely } from "kysely";
import { PostgresDialect, SqliteDialect, type Dialect } from "kysely";
import { Pool } from "pg";
import { bunSqliteDatabase } from "./bun-sqlite.ts";
import { migrateAll } from "./migrate.ts";
import type { AppDatabase } from "./schema.ts";

export type DbKind = "postgres" | "sqlite";
export type DbMode = "file" | "db";

export interface ResolvedDialect {
	dialect: Dialect;
	type: DbKind;
	/** Release the underlying pg Pool / SQLite handle. */
	close: () => Promise<void>;
}

export interface DbHandle {
	db: Kysely<AppDatabase>;
	dialect: Dialect;
	type: DbKind;
	close: () => Promise<void>;
}

const PG_RE = /^postgres(ql)?:\/\//i;

/** `DATABASE_URL` scheme → Kysely dialect. `postgres(ql)://…` ⇒ Postgres, anything else ⇒ SQLite file/`:memory:`. */
export function resolveDialect(url: string): ResolvedDialect {
	if (PG_RE.test(url)) {
		const pool = new Pool({ connectionString: url });
		return { dialect: new PostgresDialect({ pool }), type: "postgres", close: () => pool.end() };
	}
	const file = url.replace(/^(sqlite|file):(\/\/)?/i, "") || ":memory:";
	const database = bunSqliteDatabase(file);
	return { dialect: new SqliteDialect({ database }), type: "sqlite", close: async () => database.close() };
}

/** Open a Kysely instance over `url`'s dialect. Does NOT migrate — see {@link openDatabase}. */
export function openDb(url: string): DbHandle {
	const resolved = resolveDialect(url);
	const db = new Kysely<AppDatabase>({ dialect: resolved.dialect });
	return { db, dialect: resolved.dialect, type: resolved.type, close: () => resolved.close() };
}

/** Boot mode is purely a function of `DATABASE_URL` presence. */
export function dbMode(env: NodeJS.ProcessEnv = process.env): DbMode {
	return env.DATABASE_URL ? "db" : "file";
}

/**
 * Boot helper: in file mode return `null` (caller keeps today's file-backed
 * path, zero behavior change); in DB mode open + migrate and return the handle.
 */
export async function openDatabase(env: NodeJS.ProcessEnv = process.env): Promise<DbHandle | null> {
	const url = env.DATABASE_URL;
	if (!url) return null;
	const handle = openDb(url);
	await migrateAll(handle.db, handle.dialect, handle.type);
	return handle;
}
