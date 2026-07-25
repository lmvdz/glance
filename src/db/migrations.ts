/**
 * App-table Kysely migrations + the Postgres RLS backstop.
 *
 * Runs AFTER BetterAuth's own migrations (which create `organization`), so every
 * app table can FK its `org_id` to `organization.id`. The same migration set
 * runs on Postgres and SQLite; the RLS migration is a no-op on SQLite (which has
 * no row-level security) and the primary org-scoping then lives entirely in the
 * DAL's explicit `where org_id = …`.
 *
 * RLS design: each app table gets `ENABLE` + `FORCE` row-level security and one
 * policy whose USING/WITH CHECK predicate is `org_id = current_setting(
 * 'app.current_org', true)`. The DAL sets that GUC transaction-locally per
 * org-scoped unit of work (see dal/context.ts). FORCE makes the policy apply to
 * the table owner too, so the backstop holds even for the role that owns the
 * schema — only a superuser bypasses it.
 */

import { Kysely, sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import type { DbKind } from "./index.ts";

const APP_TABLES = [
	"roster_index",
	"features",
	"audit",
	"channels",
	"channel_entries",
	"usage",
	"federation_peers",
	"capability_records",
	"feedback_campaigns",
	"feedback_items",
	"feedback_validation_responses",
	"feedback_rewards",
	"channel_memberships",
	"channel_read_cursors",
	"nodes",
] as const;
const BASE_APP_TABLES = ["roster_index", "features", "audit", "channels", "channel_entries", "usage", "federation_peers", "capability_records"] as const;
const FEEDBACK_TABLES = ["feedback_campaigns", "feedback_items", "feedback_validation_responses", "feedback_rewards"] as const;

const createAppTables: Migration = {
	async up(db: Kysely<any>) {
		await db.schema
			.createTable("roster_index")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("name", "text", (c) => c.notNull())
			.addColumn("repo", "text", (c) => c.notNull())
			.addColumn("branch", "text")
			.addColumn("worktree", "text", (c) => c.notNull())
			.addColumn("model", "text")
			.addColumn("kind", "text")
			.addColumn("parent_id", "text")
			.addColumn("issue", "text")
			.addColumn("feature_id", "text")
			.addColumn("data", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addColumn("updated_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("roster_index_pk", ["org_id", "id"])
			.execute();

		await db.schema
			.createTable("features")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("repo", "text", (c) => c.notNull())
			.addColumn("title", "text", (c) => c.notNull())
			.addColumn("archived", "integer", (c) => c.notNull().defaultTo(0))
			.addColumn("data", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addColumn("updated_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("features_pk", ["org_id", "id"])
			.execute();

		// Audit id is an app-generated monotonic per-call value (epoch-µs-ish); kept
		// as a plain bigint PK so the same DDL works on SQLite and Postgres without
		// dialect-specific identity/serial syntax.
		await db.schema
			.createTable("audit")
			.addColumn("id", "bigint", (c) => c.primaryKey())
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("actor", "text", (c) => c.notNull())
			.addColumn("action", "text", (c) => c.notNull())
			.addColumn("target", "text")
			.addColumn("detail", "text")
			.addColumn("at", "bigint", (c) => c.notNull())
			.execute();
		await db.schema.createIndex("audit_org_at").on("audit").columns(["org_id", "at"]).execute();

		await db.schema
			.createTable("channels")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("name", "text", (c) => c.notNull())
			.addColumn("kind", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("channels_pk", ["org_id", "id"])
			.execute();

		await db.schema
			.createTable("channel_entries")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("channel_id", "text", (c) => c.notNull())
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("seq", "bigint", (c) => c.notNull())
			.addColumn("author_actor", "text", (c) => c.notNull())
			.addColumn("reply_to_id", "text")
			.addColumn("ts", "bigint", (c) => c.notNull())
			.addColumn("data", "text", (c) => c.notNull())
			.addPrimaryKeyConstraint("channel_entries_pk", ["org_id", "channel_id", "seq"])
			.execute();
		await db.schema.createIndex("channel_entries_org_channel_seq").on("channel_entries").columns(["org_id", "channel_id", "seq"]).execute();


		await db.schema
			.createTable("usage")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("run_id", "text", (c) => c.notNull())
			.addColumn("agent_id", "text", (c) => c.notNull())
			.addColumn("repo", "text", (c) => c.notNull())
			.addColumn("model", "text")
			.addColumn("started_at", "bigint", (c) => c.notNull())
			.addColumn("ended_at", "bigint")
			.addColumn("tool_calls", "integer", (c) => c.notNull().defaultTo(0))
			.addColumn("cost_usd", "double precision")
			.addColumn("tokens_total", "bigint")
			.addColumn("data", "text", (c) => c.notNull())
			.addPrimaryKeyConstraint("usage_pk", ["org_id", "run_id"])
			.execute();

		await db.schema
			.createTable("federation_peers")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("operator_id", "text", (c) => c.notNull())
			.addColumn("last_seen", "bigint", (c) => c.notNull())
			.addColumn("agents", "integer", (c) => c.notNull().defaultTo(0))
			.addColumn("data", "text", (c) => c.notNull())
			.addPrimaryKeyConstraint("federation_peers_pk", ["org_id", "operator_id"])
			.execute();

		await db.schema
			.createTable("capability_records")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("kind", "text", (c) => c.notNull())
			.addColumn("data", "text", (c) => c.notNull())
			.addColumn("updated_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("capability_records_pk", ["org_id", "id"])
			.execute();
	},
	async down(db: Kysely<any>) {
		for (const t of [...BASE_APP_TABLES].reverse()) await db.schema.dropTable(t).ifExists().execute();
	},
};

const createFeedbackTables: Migration = {
	async up(db: Kysely<any>) {
		await db.schema
			.createTable("feedback_campaigns")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("campaign_id", "text", (c) => c.notNull())
			.addColumn("repo", "text", (c) => c.notNull())
			.addColumn("status", "text", (c) => c.notNull())
			.addColumn("data", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("feedback_campaigns_pk", ["org_id", "id"])
			.execute();
		await db.schema.createIndex("feedback_campaigns_org_repo").on("feedback_campaigns").columns(["org_id", "repo"]).execute();

		await db.schema
			.createTable("feedback_items")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("campaign_id", "text", (c) => c.notNull())
			.addColumn("repo", "text", (c) => c.notNull())
			.addColumn("status", "text", (c) => c.notNull())
			.addColumn("data", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("feedback_items_pk", ["org_id", "id"])
			.execute();
		await db.schema.createIndex("feedback_items_org_campaign").on("feedback_items").columns(["org_id", "campaign_id"]).execute();
		await db.schema.createIndex("feedback_items_org_repo_status").on("feedback_items").columns(["org_id", "repo", "status"]).execute();

		await db.schema
			.createTable("feedback_validation_responses")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("campaign_id", "text", (c) => c.notNull())
			.addColumn("repo", "text", (c) => c.notNull())
			.addColumn("status", "text", (c) => c.notNull())
			.addColumn("data", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("feedback_validation_responses_pk", ["org_id", "id"])
			.execute();
		await db.schema.createIndex("feedback_validation_responses_org_campaign").on("feedback_validation_responses").columns(["org_id", "campaign_id"]).execute();

		await db.schema
			.createTable("feedback_rewards")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("campaign_id", "text", (c) => c.notNull())
			.addColumn("repo", "text", (c) => c.notNull())
			.addColumn("status", "text", (c) => c.notNull())
			.addColumn("data", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("feedback_rewards_pk", ["org_id", "id"])
			.execute();
		await db.schema.createIndex("feedback_rewards_org_campaign").on("feedback_rewards").columns(["org_id", "campaign_id"]).execute();
		await db.schema.createIndex("feedback_rewards_org_repo_status").on("feedback_rewards").columns(["org_id", "repo", "status"]).execute();
	},
	async down(db: Kysely<any>) {
		for (const t of [...FEEDBACK_TABLES].reverse()) await db.schema.dropTable(t).ifExists().execute();
	},
};

/** Postgres-only: enable + force RLS and install the per-org isolation policy on every app table. */
function rlsMigration(type: DbKind, tables: readonly string[]): Migration {
	return {
		async up(db: Kysely<any>) {
			if (type !== "postgres") return; // SQLite has no RLS; DAL org-scoping is the only guard there.
			for (const t of tables) {
				await sql`alter table ${sql.ref(t)} enable row level security`.execute(db);
				await sql`alter table ${sql.ref(t)} force row level security`.execute(db);
				await sql`
					create policy org_isolation on ${sql.ref(t)}
					using (org_id = current_setting('app.current_org', true))
					with check (org_id = current_setting('app.current_org', true))
				`.execute(db);
			}
		},
		async down(db: Kysely<any>) {
			if (type !== "postgres") return;
			for (const t of tables) {
				await sql`drop policy if exists org_isolation on ${sql.ref(t)}`.execute(db);
				await sql`alter table ${sql.ref(t)} disable row level security`.execute(db);
			}
		},
	};
}

// One provider credential per org (plans/voice-db-mode/02-secret-store.md) — see schema.ts's
// OrgSecretTable doc comment for the column shapes. This table alone creates nothing without the
// matching RLS entry below: `org_secret` is NOT in BASE_APP_TABLES/FEEDBACK_TABLES (the existing
// RLS backstop's coverage), so it needs its own explicit rlsMigration call in the provider map —
// forgetting it leaves the table protected only by the DAL's `where org_id`, unacceptable for a
// secret table.
const createOrgSecretTable: Migration = {
	async up(db: Kysely<any>) {
		await db.schema
			.createTable("org_secret")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("provider", "text", (c) => c.notNull())
			.addColumn("ciphertext", "text", (c) => c.notNull())
			.addColumn("nonce", "text", (c) => c.notNull())
			.addColumn("last4", "text", (c) => c.notNull())
			.addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
			.addColumn("created_by", "text", (c) => c.notNull())
			.addColumn("updated_by", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addColumn("updated_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("org_secret_pk", ["org_id", "provider"])
			.execute();
	},
	async down(db: Kysely<any>) {
		await db.schema.dropTable("org_secret").ifExists().execute();
	},
};

const usageTraceId: Migration = {
	async up(db: Kysely<any>) {
		await db.schema.alterTable("usage").addColumn("trace_id", "text").execute();
		await db.schema.createIndex("usage_org_trace").on("usage").columns(["org_id", "trace_id"]).execute();
	},
	async down(db: Kysely<any>) {
		await db.schema.dropIndex("usage_org_trace").execute();
		await db.schema.alterTable("usage").dropColumn("trace_id").execute();
	},
};

// Self-serve org join requests (domain-match onboarding, "require approval" policy). Deliberately NOT an
// RLS/FK app table: it's written during onboarding OUTSIDE the org-scoped DAL context (the requester isn't
// a member yet), like the better-auth-owned org/member tables. Admin reads scope by org_id explicitly.

/**
 * Backfill for databases created BEFORE `channels`/`channel_entries` were added to
 * `0001_app_tables`.
 *
 * Those two tables were introduced by editing an ALREADY-APPLIED migration (commit 5d64fb26,
 * "Add durable org channel store") rather than by adding a new one. Kysely records 0001 as
 * applied and never re-runs it, so every database that existed before that commit permanently
 * lacks both tables — and then `0009_channel_memberships` calls `alterTable("channels")` and the
 * daemon dies on boot with `no such table: channels`. It cannot be restarted, ever, without this.
 *
 * Named `0008b_` so it sorts after `0008_org_secret_rls` and before `0009_channel_memberships`,
 * which is the migration that needs the table to exist.
 *
 * Idempotent by necessity: on a fresh database `0001` has already created both tables, so this
 * must be a no-op rather than an error. `ifNotExists()` is what makes the same migration correct
 * on both an old database and a new one.
 *
 * The lesson, recorded because this class of defect is invisible until an upgrade: never edit a
 * migration that has shipped. A new table goes in a new migration, even when the old one is
 * "obviously" the right home for it.
 */
const channelsBackfill: Migration = {
	async up(db: Kysely<any>) {
		await db.schema
			.createTable("channels")
			.ifNotExists()
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("name", "text", (c) => c.notNull())
			.addColumn("kind", "text", (c) => c.notNull())
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("channels_pk", ["org_id", "id"])
			.execute();

		await db.schema
			.createTable("channel_entries")
			.ifNotExists()
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("channel_id", "text", (c) => c.notNull())
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("seq", "bigint", (c) => c.notNull())
			.addColumn("author_actor", "text", (c) => c.notNull())
			.addColumn("reply_to_id", "text")
			.addColumn("ts", "bigint", (c) => c.notNull())
			.addColumn("data", "text", (c) => c.notNull())
			.addPrimaryKeyConstraint("channel_entries_pk", ["org_id", "channel_id", "seq"])
			.execute();

		await db.schema
			.createIndex("channel_entries_org_channel_seq")
			.ifNotExists()
			.on("channel_entries")
			.columns(["org_id", "channel_id", "seq"])
			.execute();
	},
	/** Never drops: on a fresh database these tables belong to 0001 and are not this migration's to remove. */
	async down() {},
};

const channelMemberships: Migration = {
	async up(db: Kysely<any>) {
		await db.schema.alterTable("channels").addColumn("visibility", "text", (c) => c.notNull().defaultTo("org-public")).execute();
		await db.schema.alterTable("channels").addColumn("creator_user_id", "text").execute();
		await db.schema
			.createTable("channel_memberships")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("channel_id", "text", (c) => c.notNull())
			.addColumn("user_id", "text", (c) => c.notNull())
			.addColumn("active", "integer", (c) => c.notNull())
			.addColumn("updated_by", "text", (c) => c.notNull())
			.addColumn("updated_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("channel_memberships_pk", ["org_id", "channel_id", "user_id"])
			.execute();
		await db.schema.createIndex("channel_memberships_org_channel_active").on("channel_memberships").columns(["org_id", "channel_id", "active"]).execute();
	},
	async down(db: Kysely<any>) {
		await db.schema.dropTable("channel_memberships").execute();
		await db.schema.alterTable("channels").dropColumn("creator_user_id").execute();
		await db.schema.alterTable("channels").dropColumn("visibility").execute();
	},
};

const channelReadCursors: Migration = {
	async up(db: Kysely<any>) {
		await db.schema
			.createTable("channel_read_cursors")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("channel_id", "text", (c) => c.notNull())
			.addColumn("user_id", "text", (c) => c.notNull())
			.addColumn("last_read_seq", "bigint", (c) => c.notNull())
			.addColumn("updated_at", "bigint", (c) => c.notNull())
			.addPrimaryKeyConstraint("channel_read_cursors_pk", ["org_id", "channel_id", "user_id"])
			.execute();
		await db.schema.createIndex("channel_read_cursors_org_channel").on("channel_read_cursors").columns(["org_id", "channel_id"]).execute();
	},
	async down(db: Kysely<any>) {
		await db.schema.dropTable("channel_read_cursors").execute();
	},
};

const nodes: Migration = {
	async up(db: Kysely<any>) {
		await db.schema
			.createTable("nodes")
			.addColumn("org_id", "text", (c) => c.notNull().references("organization.id").onDelete("cascade"))
			.addColumn("id", "text", (c) => c.notNull())
			.addColumn("parent_id", "text")
			.addColumn("kind", "text", (c) => c.notNull())
			.addColumn("title", "text", (c) => c.notNull())
			.addColumn("state", "text", (c) => c.notNull())
			.addColumn("owner_id", "text")
			.addColumn("goal", "text")
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.addColumn("settled_at", "bigint")
			.addColumn("channel_id", "text")
			.addPrimaryKeyConstraint("nodes_pk", ["org_id", "id"])
			.execute();
		await db.schema.createIndex("nodes_org_parent").on("nodes").columns(["org_id", "parent_id"]).execute();
	},
	async down(db: Kysely<any>) {
		await db.schema.dropTable("nodes").ifExists().execute();
	},
};

const createJoinRequests: Migration = {
	async up(db: Kysely<any>) {
		await db.schema
			.createTable("org_join_requests")
			.addColumn("id", "text", (c) => c.primaryKey())
			.addColumn("org_id", "text", (c) => c.notNull())
			.addColumn("user_id", "text", (c) => c.notNull())
			.addColumn("email", "text", (c) => c.notNull())
			.addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
			.addColumn("created_at", "bigint", (c) => c.notNull())
			.execute();
		await db.schema.createIndex("org_join_requests_org").on("org_join_requests").columns(["org_id", "status"]).execute();
		await db.schema.createIndex("org_join_requests_user").on("org_join_requests").columns(["user_id"]).execute();
	},
	async down(db: Kysely<any>) {
		await db.schema.dropTable("org_join_requests").execute();
	},
};

/** The full, ordered app migration set. Exported so tests can invoke an individual migration's
 *  `up()` directly (e.g. proving the org_secret RLS policy's exact SQL against a fake Postgres
 *  connection) without needing to simulate the Migrator's advisory-lock bookkeeping end to end —
 *  `migrateApp` below is the only production caller.
 *  @substrate exported so tests/org-secret-rls.test.ts can invoke a single migration's up() directly */
export function appMigrations(type: DbKind): Record<string, Migration> {
	return {
		"0001_app_tables": createAppTables,
		"0002_rls_backstop": rlsMigration(type, BASE_APP_TABLES),
		"0003_usage_trace_id": usageTraceId,
		"0004_feedback_tables": createFeedbackTables,
		"0005_feedback_rls": rlsMigration(type, FEEDBACK_TABLES),
		"0006_join_requests": createJoinRequests,
		"0007_org_secret": createOrgSecretTable,
		"0008_org_secret_rls": rlsMigration(type, ["org_secret"]),
		"0008b_channels_backfill": channelsBackfill,
		"0009_channel_memberships": channelMemberships,
		"0010_channel_memberships_rls": rlsMigration(type, ["channel_memberships"]),
		"0011_channel_read_cursors": channelReadCursors,
		"0012_channel_read_cursors_rls": rlsMigration(type, ["channel_read_cursors"]),
		"0013_nodes": nodes,
		"0014_nodes_rls": rlsMigration(type, ["nodes"]),
	};
}

/** Apply app-table + RLS migrations idempotently via Kysely's Migrator. */
export async function migrateApp(db: Kysely<any>, type: DbKind): Promise<void> {
	const provider: MigrationProvider = {
		async getMigrations(): Promise<Record<string, Migration>> {
			return appMigrations(type);
		},
	};
	const migrator = new Migrator({ db, provider });
	const { error } = await migrator.migrateToLatest();
	if (error) throw error instanceof Error ? error : new Error(`app migration failed: ${String(error)}`);
}
