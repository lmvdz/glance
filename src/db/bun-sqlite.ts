/**
 * bun:sqlite → Kysely adapter.
 *
 * Kysely's built-in `SqliteDialect` speaks the better-sqlite3 `Database` shape
 * (a `prepare(sql)` returning a statement with `reader`/`all`/`run`/`iterate`).
 * Bun ships its own native SQLite (`bun:sqlite`) with a slightly different
 * statement surface, so this is the ~15-line shim that lets us reuse the
 * official dialect on Bun with zero native build deps. Self-host runs on this;
 * the org-scoping DAL tests run on an in-memory instance.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqliteDatabase, SqliteStatement } from "kysely";

/** Wrap a `bun:sqlite` Database in the subset of better-sqlite3's API Kysely needs. */
export function bunSqliteDatabase(filename: string): SqliteDatabase {
	// SQLite won't create a db file inside a missing directory — it fails with the
	// opaque "unable to open database file". A DATABASE_URL like `sqlite:$HOME/.glance/glance.db`
	// on a fresh box (or after a state-dir rename) has no parent dir yet, which would wedge
	// the daemon at boot. Create the parent for real file paths so first-run just works.
	if (filename && filename !== ":memory:" && !filename.startsWith("file::memory:")) {
		mkdirSync(dirname(filename), { recursive: true });
	}
	const db = new Database(filename);
	// FK constraints (org_id → organization.id) are off by default in SQLite.
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA journal_mode = WAL");
	return {
		close: () => db.close(),
		prepare: (sql: string): SqliteStatement => {
			const stmt = db.prepare(sql);
			return {
				// A statement that returns columns is a read; bun exposes that as columnNames.
				get reader() {
					return stmt.columnNames.length > 0;
				},
				all: (parameters) => stmt.all(...(parameters as SQLQueryBindings[])) as unknown[],
				run: (parameters) => {
					const r = stmt.run(...(parameters as SQLQueryBindings[]));
					return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
				},
				iterate: (parameters) => stmt.iterate(...(parameters as SQLQueryBindings[])) as IterableIterator<unknown>,
			};
		},
	};
}
