import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db/index.ts";
import { migrateAll } from "../src/db/migrate.ts";

/**
 * `channels` and `channel_entries` were introduced by editing the ALREADY-APPLIED
 * `0001_app_tables` migration rather than by adding a new one. Kysely records 0001 as applied and
 * never re-runs it, so every database that existed before that edit permanently lacked both
 * tables — and `0009_channel_memberships` then calls `alterTable("channels")` and the daemon dies
 * on boot with `no such table: channels`, unable to restart at all.
 *
 * These tests pin the repair from both directions. The pre-edit database is simulated by applying
 * the real migration chain and then dropping the two tables while LEAVING the migration ledger
 * intact — which is exactly the state a pre-edit database is in.
 */
async function scratchDb(name: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), name));
	return { file: path.join(dir, "glance.db"), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function tables(file: string): Promise<Set<string>> {
	const h = openDb(`sqlite:${file}`);
	const rows = await h.db.selectFrom("sqlite_master" as never).select("name" as never).where("type" as never, "=", "table" as never).execute();
	await h.close();
	return new Set(rows.map((r) => (r as { name: string }).name));
}

test("a database that predates the channels tables migrates instead of dying on boot", async () => {
	const { file, cleanup } = await scratchDb("chan-backfill-old-");
	try {
		const first = openDb(`sqlite:${file}`);
		await migrateAll(first.db, first.dialect, first.type);
		// Simulate the pre-edit database faithfully: the tables 0001 now creates were never created
		// there, AND the ledger has only reached 0008 — nothing at or after 0008b has run. Dropping
		// the tables alone is not enough; the first pass above already recorded the backfill, so it
		// would be skipped and the test would pass for the wrong reason.
		for (const t of ["delegation_grants", "node_records", "nodes", "channel_read_cursors", "channel_memberships", "channel_entries", "channels"]) {
			await first.db.schema.dropTable(t).ifExists().execute();
		}
		await first.db.deleteFrom("kysely_migration" as never).where("name" as never, ">=", "0008b" as never).execute();
		await first.close();
		expect((await tables(file)).has("channels")).toBe(false);

		const second = openDb(`sqlite:${file}`);
		await migrateAll(second.db, second.dialect, second.type); // this is the boot that used to throw
		await second.close();

		const after = await tables(file);
		expect(after.has("channels")).toBe(true);
		expect(after.has("channel_entries")).toBe(true);
		expect(after.has("node_records")).toBe(true);
	} finally {
		await cleanup();
	}
});

test("the backfill is a no-op on a fresh database and on a repeat run", async () => {
	const { file, cleanup } = await scratchDb("chan-backfill-fresh-");
	try {
		for (let i = 0; i < 2; i++) {
			const h = openDb(`sqlite:${file}`);
			await migrateAll(h.db, h.dialect, h.type); // must not throw on either pass
			await h.close();
		}
		const after = await tables(file);
		expect(after.has("channels")).toBe(true);
		expect(after.has("channel_entries")).toBe(true);
	} finally {
		await cleanup();
	}
});
