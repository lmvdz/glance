/**
 * `org_secret` isolation (plans/voice-db-mode/02-secret-store.md) — the load-bearing RLS proof.
 *
 * Two layers, per the concern's own Verify bullet ("assert at the DAL layer, and on Postgres
 * assert the policy exists — a where-clause-only test would pass even with RLS missing, which is
 * precisely the hole"):
 *
 *  1. DAL layer, real SQLite (in-memory-grade, via `openDatabase` — mirrors dal-store.test.ts):
 *     org A's secret is invisible to org B through the store accessors, and cascade-deletes with
 *     its org. This proves the PRIMARY guard (the explicit `where org_id` predicate) — SQLite has
 *     no RLS, so this is the only guard there, matching dal/context.ts's own "defense in depth"
 *     doc comment.
 *  2. Postgres SQL shape, no live server required: `appMigrations("postgres")`'s org_secret RLS
 *     step is invoked directly against a Kysely instance wired to a FAKE `pg` pool that records
 *     the exact SQL text sent to it. This runs the REAL production migration code through
 *     Kysely's real Postgres query compiler (not a hand-written guess at the SQL), proving the
 *     policy-creation statements actually name `org_secret` and the `app.current_org` GUC —
 *     without needing a reachable Postgres server (none is available in this sandbox; see the
 *     unit's report for the environment check). A `where`-clause-only guard would leave this
 *     assertion with nothing to find, which is exactly the gap this proves closed.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Kysely } from "kysely";
import { PostgresDialect } from "kysely";
import { type OrgContext } from "../src/dal/context.ts";
import { deleteOrgSecret, getOrgSecret, putOrgSecret, setOrgSecretEnabled } from "../src/dal/store.ts";
import { appMigrations } from "../src/db/migrations.ts";
import { type DbHandle, openDatabase } from "../src/db/index.ts";
import { initMasterKey } from "../src/secrets.ts";

const KEY_HEX = "7329787df726d0637e8e4678d098b779fccc8ba32d6efcc962b66208620d599e";

// ── Layer 1: DAL-layer isolation on real SQLite ──────────────────────────────────────────────

let dir: string;
let handle: DbHandle;
let ctx: OrgContext;
const prevUrl = process.env.DATABASE_URL;

async function setup() {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-org-secret-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const h = await openDatabase();
	if (!h) throw new Error("openDatabase returned null in DB mode");
	handle = h;
	ctx = { db: handle.db, type: handle.type };
	for (const id of ["A", "B"]) {
		await handle.db.insertInto("organization").values({ id, name: `Org ${id}`, slug: `org-${id.toLowerCase()}`, createdAt: new Date().toISOString() }).execute();
	}
}
async function teardown() {
	await handle.close();
	await fs.rm(dir, { recursive: true, force: true });
	if (prevUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = prevUrl;
}

test("DAL: org A's secret is invisible to org B (explicit org_id predicate)", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		const written = await putOrgSecret(ctx, "A", "openai", "sk-org-a-secret", "db:user-a");
		// putOrgSecret returns OrgSecretSummary — no `plaintext` field, so an admin PUT handler that
		// echoes this response body can never leak the credential over the wire.
		expect(written).not.toHaveProperty("plaintext");
		expect(JSON.stringify(written)).not.toContain("sk-org-a-secret");
		expect(written?.last4).toBe("cret");

		const fromB = await getOrgSecret(ctx, "B", "openai");
		expect(fromB).toBeUndefined();

		const fromA = await getOrgSecret(ctx, "A", "openai");
		expect(fromA?.plaintext).toBe("sk-org-a-secret");
		expect(fromA?.last4).toBe("cret");
		expect(fromA?.enabled).toBe(true);

		// Row-level: B's own row for the same provider is independent of A's.
		await putOrgSecret(ctx, "B", "openai", "sk-org-b-secret", "db:user-b");
		expect((await getOrgSecret(ctx, "A", "openai"))?.plaintext).toBe("sk-org-a-secret");
		expect((await getOrgSecret(ctx, "B", "openai"))?.plaintext).toBe("sk-org-b-secret");
	} finally {
		await teardown();
	}
});

test("DAL: ciphertext at rest differs from the plaintext (round-trip through real storage)", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		await putOrgSecret(ctx, "A", "openai", "sk-plaintext-marker", "db:user-a");
		const row = await handle.db.selectFrom("org_secret").selectAll().where("org_id", "=", "A").executeTakeFirst();
		expect(row).toBeDefined();
		expect(row!.ciphertext).not.toContain("sk-plaintext-marker");
		expect(row!.ciphertext).not.toBe("sk-plaintext-marker");
	} finally {
		await teardown();
	}
});

test("DAL: setOrgSecretEnabled flips the kill switch without touching the stored key", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		await putOrgSecret(ctx, "A", "openai", "sk-kill-switch", "db:user-a");
		expect((await getOrgSecret(ctx, "A", "openai"))?.enabled).toBe(true);

		await setOrgSecretEnabled(ctx, "A", "openai", false, "db:admin-a");
		const disabled = await getOrgSecret(ctx, "A", "openai");
		expect(disabled?.enabled).toBe(false);
		expect(disabled?.plaintext).toBe("sk-kill-switch"); // key itself untouched

		await setOrgSecretEnabled(ctx, "A", "openai", true, "db:admin-a");
		expect((await getOrgSecret(ctx, "A", "openai"))?.enabled).toBe(true);
	} finally {
		await teardown();
	}
});

test("DAL: deleteOrgSecret removes exactly the (org, provider) row, B unaffected", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		await putOrgSecret(ctx, "A", "openai", "sk-org-a", "db:user-a");
		await putOrgSecret(ctx, "B", "openai", "sk-org-b", "db:user-b");
		await deleteOrgSecret(ctx, "A", "openai");
		expect(await getOrgSecret(ctx, "A", "openai")).toBeUndefined();
		expect((await getOrgSecret(ctx, "B", "openai"))?.plaintext).toBe("sk-org-b");
	} finally {
		await teardown();
	}
});

test("DAL: cascade — deleting an org removes its org_secret row", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		await putOrgSecret(ctx, "A", "openai", "sk-cascade-me", "db:user-a");
		expect(await handle.db.selectFrom("org_secret").selectAll().where("org_id", "=", "A").executeTakeFirst()).toBeDefined();

		await handle.db.deleteFrom("organization").where("id", "=", "A").execute();
		expect(await handle.db.selectFrom("org_secret").selectAll().where("org_id", "=", "A").executeTakeFirst()).toBeUndefined();
	} finally {
		await teardown();
	}
});

test("DAL: decrypt-fails-closed propagates through the store — a corrupted row reads as no secret, never throws", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		await putOrgSecret(ctx, "A", "openai", "sk-will-be-corrupted", "db:user-a");
		await handle.db.updateTable("org_secret").set({ ciphertext: "not-valid-base64-ciphertext!!" }).where("org_id", "=", "A").execute();
		await expect(getOrgSecret(ctx, "A", "openai")).resolves.toBeUndefined();
	} finally {
		await teardown();
	}
});

test("DAL: decrypt-fails-closed — a rotated master key reads every existing row as no secret, never throws", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		await putOrgSecret(ctx, "A", "openai", "sk-pre-rotation", "db:user-a");
		initMasterKey({ OMP_SQUAD_SECRETS_KEY: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
		await expect(getOrgSecret(ctx, "A", "openai")).resolves.toBeUndefined();
	} finally {
		await teardown();
	}
});

test("DAL accessors guard an empty org id BEFORE calling the org-scoping helper (which throws on one)", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	await setup();
	try {
		await expect(getOrgSecret(ctx, "", "openai")).resolves.toBeUndefined();
		await expect(putOrgSecret(ctx, "", "openai", "sk-x", "db:user")).resolves.toBeUndefined();
		await expect(deleteOrgSecret(ctx, "", "openai")).resolves.toBeUndefined();
		await expect(setOrgSecretEnabled(ctx, "", "openai", true, "db:user")).resolves.toBeUndefined();
	} finally {
		await teardown();
	}
});

test("DAL: putOrgSecret persists nothing when no master key is configured (fail-closed on write, not just read)", async () => {
	initMasterKey({}); // no key
	await setup();
	try {
		const result = await putOrgSecret(ctx, "A", "openai", "sk-should-not-persist", "db:user-a");
		expect(result).toBeUndefined();
		expect(await handle.db.selectFrom("org_secret").selectAll().where("org_id", "=", "A").executeTakeFirst()).toBeUndefined();
	} finally {
		await teardown();
		initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX }); // leave a sane state for later tests in the run
	}
});

// ── Layer 2: Postgres RLS policy SQL shape (no live server required) ────────────────────────

/** A `pg`-shaped fake pool: `PostgresDriver.acquireConnection` calls `pool.connect()` and gets
 *  back an object with `query(sql, params)`/`release()`. Wiring this into a REAL `PostgresDialect`
 *  routes the production migration code through Kysely's real Postgres query compiler — the
 *  captured SQL text is what a real Postgres server would actually receive, not a hand-written
 *  guess at the shape. */
function fakePostgresDb(): { db: Kysely<any>; queries: string[] } {
	const queries: string[] = [];
	const client = {
		query: async (sql: string) => {
			queries.push(sql);
			return { command: "SELECT", rowCount: 0, rows: [] };
		},
		release: () => {},
	};
	const pool = { connect: async () => client, end: async () => {} };
	const db = new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as any }) });
	return { db, queries };
}

test("Postgres: the org_secret RLS migration is wired into the provider map under type=postgres", () => {
	const migrations = appMigrations("postgres");
	expect(migrations["0008_org_secret_rls"]).toBeDefined();
	expect(migrations["0007_org_secret"]).toBeDefined();
});

test("Postgres: org_secret RLS migration enables + forces RLS and installs the org_id isolation policy (real SQL, captured)", async () => {
	const { db, queries } = fakePostgresDb();
	const migrations = appMigrations("postgres");
	await migrations["0008_org_secret_rls"].up(db as any);

	const all = queries.join("\n");
	expect(all).toContain("org_secret");
	expect(/enable row level security/i.test(all)).toBe(true);
	expect(/force row level security/i.test(all)).toBe(true);
	expect(/create policy org_isolation on/i.test(all)).toBe(true);
	expect(all).toContain("app.current_org");
	// The policy predicate scopes on org_id, per dal/context.ts's GUC — not some other column.
	expect(/org_id\s*=\s*current_setting/i.test(all)).toBe(true);
});

test("Postgres: the org_secret RLS migration is a no-op under type=sqlite (SQLite has no RLS)", async () => {
	const { db, queries } = fakePostgresDb(); // dialect is irrelevant here — up() short-circuits on `type`
	const migrations = appMigrations("sqlite");
	await migrations["0008_org_secret_rls"].up(db as any);
	expect(queries).toEqual([]);
});

test("Postgres: down() drops the org_secret policy and disables RLS (real SQL, captured)", async () => {
	const { db, queries } = fakePostgresDb();
	const migrations = appMigrations("postgres");
	await migrations["0008_org_secret_rls"].down!(db as any);
	const all = queries.join("\n");
	expect(all).toContain("org_secret");
	expect(/drop policy if exists org_isolation/i.test(all)).toBe(true);
	expect(/disable row level security/i.test(all)).toBe(true);
});
