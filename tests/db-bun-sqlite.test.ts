/**
 * bun:sqlite → Kysely adapter: query parameters must actually bind.
 *
 * Guards the variadic-spread in bun-sqlite.ts (stmt.all/run take spread args,
 * not an array) — if params were dropped/mis-bound, the WHERE filter would not
 * discriminate and these assertions fail.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, SqliteDialect, sql } from "kysely";
import { bunSqliteDatabase } from "../src/db/bun-sqlite.ts";

test("bun:sqlite adapter binds query parameters (run + all)", async () => {
	const db = new Kysely<Record<string, never>>({
		dialect: new SqliteDialect({ database: bunSqliteDatabase(":memory:") }),
	});
	try {
		// run() with no params (DDL) + run() with bound params (DML inserts)
		await sql`create table t (id integer primary key, org_id text not null, name text not null)`.execute(db);
		await sql`insert into t (org_id, name) values (${"org1"}, ${"alice"})`.execute(db);
		await sql`insert into t (org_id, name) values (${"org2"}, ${"bob"})`.execute(db);

		// all() with a bound param: the WHERE must filter by the bound value, proving binding works.
		const hit = await sql<{ name: string }>`select name from t where org_id = ${"org1"}`.execute(db);
		expect(hit.rows.map((r) => r.name)).toEqual(["alice"]);

		// a param matching nothing → empty (a dropped/ignored param would wrongly return rows).
		const miss = await sql`select 1 as one from t where org_id = ${"nope"}`.execute(db);
		expect(miss.rows.length).toBe(0);
	} finally {
		await db.destroy();
	}
});

test("bun:sqlite adapter creates missing parent directories", () => {
	// Regression: a DATABASE_URL like `sqlite:$HOME/.glance/glance.db` on a fresh box has no
	// parent dir; SQLite fails such opens with the opaque "unable to open database file" and
	// wedges the daemon at boot. The adapter must mkdir -p the parent first.
	const root = mkdtempSync(join(tmpdir(), "glance-mkdir-"));
	try {
		const file = join(root, "a", "b", "c", "glance.db");
		expect(existsSync(join(root, "a"))).toBe(false);
		const db = bunSqliteDatabase(file);
		expect(existsSync(file)).toBe(true);
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bun:sqlite adapter leaves :memory: untouched (no mkdir attempt)", () => {
	// The mkdir guard must skip the in-memory sentinels, else it would try to create a
	// directory literally named ":memory:" in cwd.
	const db = bunSqliteDatabase(":memory:");
	expect(existsSync(":memory:")).toBe(false);
	db.close();
});
