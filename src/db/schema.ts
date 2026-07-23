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

/** Org-scoped collaborative channels. */
export interface ChannelsTable {
	org_id: string;
	id: string;
	name: string;
	kind: string;
	created_at: number;
}

/** Durable channel entries. `data` carries the TranscriptEntry-compatible envelope. */
export interface ChannelEntriesTable {
	org_id: string;
	channel_id: string;
	id: string;
	seq: number;
	author_actor: string;
	reply_to_id: string | null;
	ts: number;
	data: string;
}


/** Per-org run usage ledger (cost/tokens/tool-calls per completed run). */
export interface UsageTable {
	org_id: string;
	run_id: string;
	trace_id: string | null;
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


/** Per-org capability pack/source/install snapshot records. */
export interface CapabilityRecordsTable {
	org_id: string;
	id: string;
	kind: "sources" | "packs" | "installs" | "verifications" | "audit";
	data: string;
	updated_at: number;
}
/** Feedback Loop campaigns, one row per widget token/campaign. */
export interface FeedbackCampaignsTable {
	org_id: string;
	id: string;
	campaign_id: string;
	repo: string;
	status: string;
	/** Full FeedbackCampaign JSON. */
	data: string;
	created_at: number;
}

/** Feedback Loop submissions. */
export interface FeedbackItemsTable {
	org_id: string;
	id: string;
	campaign_id: string;
	repo: string;
	status: string;
	/** Full FeedbackItem JSON. */
	data: string;
	created_at: number;
}

/** Validation votes/responses for a feedback item. */
export interface FeedbackValidationResponsesTable {
	org_id: string;
	id: string;
	campaign_id: string;
	repo: string;
	/** Vote value, kept in the common status lookup column. */
	status: string;
	/** Full FeedbackValidationResponse JSON. */
	data: string;
	created_at: number;
}

/** Reward ledger entries for feedback. */
export interface FeedbackRewardsTable {
	org_id: string;
	id: string;
	campaign_id: string;
	repo: string;
	status: string;
	/** Full FeedbackReward JSON. */
	data: string;
	created_at: number;
}

/** One provider credential per org — the voice lane's BYO OpenAI key (plans/voice-db-mode/
 *  02-secret-store.md). `ciphertext`/`nonce` are AES-256-GCM under the boot master key
 *  (src/secrets.ts), per-row nonce. `last4` is PLAINTEXT and exists only for the admin UI's
 *  rotation check — it is not an identifier (OpenAI keys share long prefixes), so it must never
 *  be treated as one. `enabled` is the synchronous kill switch (DESIGN.md "Kill switch" row),
 *  independent of key deletion. `created_by`/`updated_by` are `db:<userId>` actor tags, never
 *  role-derived. Primary key `(org_id, provider)` — one credential per provider per org. */
export interface OrgSecretTable {
	org_id: string;
	provider: string;
	ciphertext: string;
	nonce: string;
	last4: string;
	enabled: number;
	created_by: string;
	updated_by: string;
	created_at: number;
	updated_at: number;
}

export interface AppDatabase {
	organization: OrganizationTable;
	roster_index: RosterIndexTable;
	features: FeaturesTable;
	audit: AuditTable;
	channels: ChannelsTable;
	channel_entries: ChannelEntriesTable;
	usage: UsageTable;
	federation_peers: FederationPeersTable;
	capability_records: CapabilityRecordsTable;
	feedback_campaigns: FeedbackCampaignsTable;
	feedback_items: FeedbackItemsTable;
	feedback_validation_responses: FeedbackValidationResponsesTable;
	feedback_rewards: FeedbackRewardsTable;
	org_secret: OrgSecretTable;
}

export type RosterRow = Selectable<RosterIndexTable>;
export type FeatureRow = Selectable<FeaturesTable>;
export type AuditRow = Selectable<AuditTable>;
export type UsageRow = Selectable<UsageTable>;
export type ChannelRow = Selectable<ChannelsTable>;
export type ChannelEntryRow = Selectable<ChannelEntriesTable>;
export type FederationPeerRow = Selectable<FederationPeersTable>;
export type CapabilityRecordRow = Selectable<CapabilityRecordsTable>;
export type FeedbackCampaignRow = Selectable<FeedbackCampaignsTable>;
export type FeedbackItemRow = Selectable<FeedbackItemsTable>;
export type FeedbackValidationResponseRow = Selectable<FeedbackValidationResponsesTable>;
export type FeedbackRewardRow = Selectable<FeedbackRewardsTable>;
export type OrgSecretRow = Selectable<OrgSecretTable>;
