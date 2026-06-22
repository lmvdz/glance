/**
 * Kysely table types for the multi-tenant DB foundation (MT-SaaS P0).
 *
 * Two ownership domains:
 *  - `organization` is BetterAuth-owned (organization plugin); we only reference
 *    its `id` for FK typing. BetterAuth's own tables (user/session/account/…)
 *    are created by `better-auth migrate` and are not modelled here — the DAL
 *    never touches them.
 *  - The `app_*`-shaped tables below are app-owned, created by the Kysely
 *    migrations in `migrations.ts`. EVERY app table carries an `org_id` FK to
 *    `organization.id`; that column is the tenancy axis the DAL scopes on and
 *    the Postgres RLS backstop keys on.
 *
 * Timestamps are epoch-millis `bigint` (uniform across Postgres + SQLite, no
 * timezone/parse divergence). Booleans are `0|1` integers for the same reason.
 * Free-form snapshots ride a JSON `data` text column.
 */

import type { Generated, Selectable } from "kysely";

/** BetterAuth-owned. Only the columns the app FKs/joins against are typed. */
export interface OrganizationTable {
	id: string;
	name: string;
	slug: string | null;
	createdAt: Date | string;
}

/** Per-org roster mirror — one row per agent the org owns. */
export interface RosterIndexTable {
	org_id: string;
	id: string;
	name: string;
	repo: string;
	branch: string | null;
	worktree: string;
	model: string | null;
	kind: string | null;
	parent_id: string | null;
	issue: string | null;
	feature_id: string | null;
	/** Full PersistedAgent JSON. */
	data: string;
	created_at: number;
	updated_at: number;
}

/** Per-org feature envelopes. */
export interface FeaturesTable {
	org_id: string;
	id: string;
	repo: string;
	title: string;
	archived: number;
	/** Full PersistedFeature JSON. */
	data: string;
	created_at: number;
	updated_at: number;
}

/** Append-only per-org audit trail (auto-supervise answers, lands, mode changes…). */
export interface AuditTable {
	id: Generated<number>;
	org_id: string;
	actor: string;
	action: string;
	target: string | null;
	/** Optional structured detail JSON. */
	detail: string | null;
	at: number;
}

/** Per-org run usage ledger (cost/tokens/tool-calls per completed run). */
export interface UsageTable {
	org_id: string;
	run_id: string;
	agent_id: string;
	repo: string;
	model: string | null;
	started_at: number;
	ended_at: number | null;
	tool_calls: number;
	cost_usd: number | null;
	tokens_total: number | null;
	/** Full RunReceipt JSON. */
	data: string;
}

/** Per-org federation peer presence snapshots. */
export interface FederationPeersTable {
	org_id: string;
	operator_id: string;
	last_seen: number;
	agents: number;
	/** Full OperatorPresence JSON. */
	data: string;
}

export interface AppDatabase {
	organization: OrganizationTable;
	roster_index: RosterIndexTable;
	features: FeaturesTable;
	audit: AuditTable;
	usage: UsageTable;
	federation_peers: FederationPeersTable;
}

export type RosterRow = Selectable<RosterIndexTable>;
export type FeatureRow = Selectable<FeaturesTable>;
export type AuditRow = Selectable<AuditTable>;
export type UsageRow = Selectable<UsageTable>;
export type FederationPeerRow = Selectable<FederationPeersTable>;
