/**
 * Pluggable persistence seam for the SquadManager (MT-SaaS P2).
 *
 * The manager never imports the DAL directly — it talks to a `Store`. Two impls:
 *  - `FileStore` wraps today's single `state.json` (temp+rename) plus on-disk
 *    receipts; behavior-preserving for file/single-tenant mode and every test.
 *  - `DbStore` makes the per-org DB tables (`roster_index`, `features`, `audit`,
 *    `usage`) authoritative through `withOrg(ctx, orgId, …)`, while large blobs
 *    (transcripts, receipts, digests, worktrees) stay on the org's disk dir.
 *
 * Roster/feature writes are full-snapshot replaces (delete-then-insert per org)
 * mirroring persistNow's atomic full write.
 * ponytail: full replace per save — O(roster) rows rewritten each persist. Fine
 * for the expected per-org roster size; upgrade to diff-upsert only if it bites.
 */

import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sql } from "kysely";
import type { PersistedAgent, PersistedFeature, RunReceipt, TranscriptEntry } from "../types.ts";
import { normalizeCapabilitySnapshot, type CapabilitySnapshot } from "../capabilities/index.ts";
import { emptyFeedbackSnapshot, type FeedbackSnapshot } from "../feedback.ts";
import { decryptSecret, encryptSecret, last4 as secretLast4 } from "../secrets.ts";
import { type OrgContext, withOrg } from "./context.ts";
import { getStorageBackend } from "./storage.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Atomically + durably write `data` to `file` through the active StorageBackend (default: local disk,
 * temp → fsync(file) → rename → fsync(dir)). After this resolves the bytes survive a host crash. The
 * concrete durability mechanism now lives in `LocalStorageBackend` (src/dal/storage.ts); this thin
 * delegator keeps every existing caller (FileStore, settings, policy, …) backend-swappable for free.
 */
export async function writeFileDurable(file: string, data: string): Promise<void> {
	await getStorageBackend().writeDurable(file, data);
}

/** Full persisted state the manager round-trips on save/load. */
export interface StateSnapshot {
	agents: PersistedAgent[];
	transcripts: Record<string, TranscriptEntry[]>;
	features: PersistedFeature[];
	feedback?: FeedbackSnapshot;
	capabilities?: CapabilitySnapshot;
}

/** One accountability record at the mutation chokepoint. */
export interface AuditEntry {
	actor: string;
	action: string;
	target?: string;
	detail?: unknown;
	/** Observability-only provenance tag carried from `ClientCommand.source` (e.g. "voice" |
	 *  "composer") when the originating command set one. Never consulted for authz — see authz.ts. */
	source?: string;
}

export interface Store {
	/** True if there is prior persisted state to recover (gates start()'s reattach/reap). */
	hasState(): Promise<boolean>;
	/** Load the full persisted snapshot ({} when none). */
	load(): Promise<StateSnapshot>;
	/** Persist the full snapshot atomically. */
	save(snapshot: StateSnapshot): Promise<void>;
	/** Load durable feedback loop data. */
	loadFeedback(): Promise<FeedbackSnapshot>;
	/** Persist durable feedback loop data. */
	saveFeedback(snapshot: FeedbackSnapshot): Promise<void>;
	/** Append one audit row (no-op for single-tenant file mode). */
	appendAudit(entry: AuditEntry): Promise<void>;
	/** Append/replace one run usage row (no-op for file mode — receipts already on disk). */
	appendUsage(receipt: RunReceipt): Promise<void>;
	/** Cumulative save() failures this process, when the store tracks them (FileStore only — DbStore's
	 *  per-write failures throw rather than swallow, so there's nothing to count). Surfaced through
	 *  factory-status since the topology guarantee now rests on this write actually landing. */
	saveFailures?(): number;
}

const EMPTY: StateSnapshot = { agents: [], transcripts: {}, features: [] };

/** Today's file-backed behavior: one `state.json` per stateDir, written temp+rename. */
export class FileStore implements Store {
	private readonly stateFile: string;
	private readonly feedbackFile: string;
	private saveFailureCount = 0;
	private lastSaveWarnAt = 0;
	constructor(private readonly stateDir: string) {
		this.stateFile = path.join(stateDir, "state.json");
		this.feedbackFile = path.join(stateDir, "feedback.json");
	}

	async hasState(): Promise<boolean> {
		return existsSync(this.stateFile);
	}

	async load(): Promise<StateSnapshot> {
		let raw: string;
		try {
			raw = await fs.readFile(this.stateFile, "utf8");
		} catch {
			return { ...EMPTY };
		}
		const parsed = JSON.parse(raw) as Partial<StateSnapshot>;
		const state: StateSnapshot = { agents: parsed.agents ?? [], transcripts: parsed.transcripts ?? {}, features: parsed.features ?? [] };
		if (parsed.capabilities) state.capabilities = normalizeCapabilitySnapshot(parsed.capabilities);
		if (existsSync(this.feedbackFile)) state.feedback = await this.loadFeedback();
		return state;
	}

	async save(snapshot: StateSnapshot): Promise<void> {
		// Durable atomic write (temp → fsync → rename → fsync dir). Behavior-preserving:
		// swallow write errors as the old inline temp+rename did, leaving no stray `.tmp` — but no longer
		// SILENTLY: a rate-limited warn plus a cumulative counter (surfaced via factory-status) since the
		// topology guarantee this store backs now rests on this write actually landing.
		try {
			const { feedback, ...state } = snapshot;
			const cap = normalizeCapabilitySnapshot(snapshot.capabilities);
			const body: StateSnapshot & { version: 1 } = { version: 1, agents: state.agents, transcripts: state.transcripts, features: state.features };
			if (cap.sources.length || cap.packs.length || cap.installs.length || cap.verifications.length || cap.audit.length) body.capabilities = cap;
			await writeFileDurable(this.stateFile, JSON.stringify(body, null, 2));
			if (feedback) await this.saveFeedback(feedback);
		} catch (err) {
			this.saveFailureCount++;
			const now = Date.now();
			if (now - this.lastSaveWarnAt > 60_000) {
				this.lastSaveWarnAt = now;
				console.error(`[FileStore] state.json save failed (${this.saveFailureCount} total this run): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/** Cumulative save() failures this process — surfaced via factory-status since the topology
	 *  guarantee (this concern's headline) now rests on this write actually landing. */
	saveFailures(): number {
		return this.saveFailureCount;
	}

	async loadFeedback(): Promise<FeedbackSnapshot> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.feedbackFile, "utf8")) as Partial<FeedbackSnapshot>;
			return { campaigns: parsed.campaigns ?? [], items: parsed.items ?? [], validations: parsed.validations ?? [], rewards: parsed.rewards ?? [] };
		} catch {
			return emptyFeedbackSnapshot();
		}
	}

	async saveFeedback(snapshot: FeedbackSnapshot): Promise<void> {
		await writeFileDurable(this.feedbackFile, JSON.stringify(snapshot, null, 2));
	}

	// Single-tenant file mode: audit/usage live in the on-disk receipts; the DB ledger is DB-mode only.
	async appendAudit(): Promise<void> {}
	async appendUsage(): Promise<void> {}
}

// A per-process random salt, drawn once at module load, folded into every id this process mints.
// Without it, two freshly-booted replicas both start `auditSeq` at 0 — if both write an audit row
// in the SAME millisecond (the exact scenario a fleet of replicas booting together produces), the
// pre-fix `Date.now() * 1000 + (auditSeq++ % 1000)` shape computed the IDENTICAL id on both, and
// `audit.id` is a global PK, so the second insert 500s. The salt means that scenario now only
// collides when two replicas independently draw the same salt (1-in-1000, not guaranteed).
const auditSeqSalt = randomInt(0, 1000);
let auditSeq = 0;
/** Collision-resistant audit id: epoch-ms × 1000 + ((per-boot random salt + a per-process
 *  monotonic counter) mod 1000). Ordering never relies on `id` — `reserveOrgAuditSlot`'s cap check
 *  counts rows by the `at` column, not `id` — so `id` only needs to be unique, not strictly time-
 *  ordered; trading a sliver of the old (deterministic, collision-prone) ordering guarantee for
 *  actual cross-process collision resistance is safe. Residual risk: >1000 calls from ANY mix of
 *  processes landing on the same millisecond can still collide (a 1-in-1000-ish birthday bound,
 *  not zero) — acceptable for this table's write rate (one row per voice mint attempt, rate-capped
 *  well below 1000/ms per org); a DB-generated id (serial/identity column) would close the residual
 *  gap entirely but is a schema migration, out of scope for this fix. */
function nextAuditId(): number {
	return Date.now() * 1000 + ((auditSeqSalt + auditSeq++) % 1000);
}

/**
 * DB-mode store: roster/features/audit/usage are authoritative in the per-org
 * tables; transcripts stay on the org's disk dir (large + append-heavy). Every
 * DB touch runs through `withOrg` so RLS (Postgres) + the explicit `org_id`
 * predicate (SQLite self-host) isolate the tenant.
 */
export class DbStore implements Store {
	private readonly transcriptsFile: string;
	constructor(
		private readonly ctx: OrgContext,
		private readonly orgId: string,
		/** Org-scoped dir for transcript blobs (DB never holds transcripts). */
		private readonly stateDir: string,
	) {
		this.transcriptsFile = path.join(stateDir, "transcripts.json");
	}

	async hasState(): Promise<boolean> {
		return withOrg(this.ctx, this.orgId, async (trx) => {
			const r = await trx.selectFrom("roster_index").select("id").where("org_id", "=", this.orgId).limit(1).executeTakeFirst();
			if (r) return true;
			const f = await trx.selectFrom("features").select("id").where("org_id", "=", this.orgId).limit(1).executeTakeFirst();
			if (f) return true;
			const c = await trx.selectFrom("capability_records").select("id").where("org_id", "=", this.orgId).limit(1).executeTakeFirst();
			return !!c;
		});
	}

	async load(): Promise<StateSnapshot> {
		const { agents, features, capabilities } = await withOrg(this.ctx, this.orgId, async (trx) => {
			const rosterRows = await trx.selectFrom("roster_index").select("data").where("org_id", "=", this.orgId).execute();
			const featureRows = await trx.selectFrom("features").select("data").where("org_id", "=", this.orgId).execute();
			const capabilityRows = await trx.selectFrom("capability_records").select(["kind", "data"]).where("org_id", "=", this.orgId).execute();
			const cap: Partial<CapabilitySnapshot> = {};
			for (const row of capabilityRows) {
				const data = JSON.parse(row.data) as unknown;
				if (row.kind === "sources" && Array.isArray(data)) cap.sources = data as CapabilitySnapshot["sources"];
				else if (row.kind === "packs" && Array.isArray(data)) cap.packs = data as CapabilitySnapshot["packs"];
				else if (row.kind === "installs" && Array.isArray(data)) cap.installs = data as CapabilitySnapshot["installs"];
				else if (row.kind === "verifications" && Array.isArray(data)) cap.verifications = data as CapabilitySnapshot["verifications"];
				else if (row.kind === "audit" && Array.isArray(data)) cap.audit = data as CapabilitySnapshot["audit"];
			}
			return {
				agents: rosterRows.map((r) => JSON.parse(r.data) as PersistedAgent),
				features: featureRows.map((r) => JSON.parse(r.data) as PersistedFeature),
				capabilities: normalizeCapabilitySnapshot(cap),
			};
		});
		const state: StateSnapshot = { agents, features, capabilities, transcripts: await this.loadTranscripts() };
		const feedback = await this.loadFeedback();
		if (feedback.campaigns.length || feedback.items.length || feedback.validations.length || feedback.rewards.length) state.feedback = feedback;
		return state;
	}

	async save(snapshot: StateSnapshot): Promise<void> {
		const now = Date.now();
		await withOrg(this.ctx, this.orgId, async (trx) => {
			// Full replace, scoped to this org (RLS + explicit predicate).
			await trx.deleteFrom("roster_index").where("org_id", "=", this.orgId).execute();
			if (snapshot.agents.length) {
				await trx
					.insertInto("roster_index")
					.values(snapshot.agents.map((a) => ({
						org_id: this.orgId,
						id: a.id,
						name: a.name,
						repo: a.repo,
						branch: a.branch ?? null,
						worktree: a.worktree,
						model: a.model ?? null,
						kind: a.kind ?? null,
						parent_id: a.parentId ?? null,
						issue: a.issue?.identifier ?? a.issue?.id ?? null,
						feature_id: a.featureId ?? null,
						data: JSON.stringify(a),
						created_at: now,
						updated_at: now,
					})))
					.execute();
			}
			await trx.deleteFrom("features").where("org_id", "=", this.orgId).execute();
			if (snapshot.features.length) {
				await trx
					.insertInto("features")
					.values(snapshot.features.map((f) => ({
						org_id: this.orgId,
						id: f.id,
						repo: f.repo,
						title: f.title,
						archived: f.archived ? 1 : 0,
						data: JSON.stringify(f),
						created_at: f.createdAt ?? now,
						updated_at: f.updatedAt ?? now,
					})))
					.execute();
			}
			await trx.deleteFrom("capability_records").where("org_id", "=", this.orgId).execute();
			const cap = normalizeCapabilitySnapshot(snapshot.capabilities);
			await trx.insertInto("capability_records").values([
				{ org_id: this.orgId, id: "sources", kind: "sources", data: JSON.stringify(cap.sources), updated_at: now },
				{ org_id: this.orgId, id: "packs", kind: "packs", data: JSON.stringify(cap.packs), updated_at: now },
				{ org_id: this.orgId, id: "installs", kind: "installs", data: JSON.stringify(cap.installs), updated_at: now },
				{ org_id: this.orgId, id: "verifications", kind: "verifications", data: JSON.stringify(cap.verifications), updated_at: now },
				{ org_id: this.orgId, id: "audit", kind: "audit", data: JSON.stringify(cap.audit), updated_at: now },
			]).execute();
		});
		await this.saveTranscripts(snapshot.transcripts);
		if (snapshot.feedback) await this.saveFeedback(snapshot.feedback);
	}

	async loadFeedback(): Promise<FeedbackSnapshot> {
		const rows = await withOrg(this.ctx, this.orgId, async (trx) => {
			const campaigns = await trx.selectFrom("feedback_campaigns").select("data").where("org_id", "=", this.orgId).orderBy("created_at").execute();
			const items = await trx.selectFrom("feedback_items").select("data").where("org_id", "=", this.orgId).orderBy("created_at").execute();
			const validations = await trx.selectFrom("feedback_validation_responses").select("data").where("org_id", "=", this.orgId).orderBy("created_at").execute();
			const rewards = await trx.selectFrom("feedback_rewards").select("data").where("org_id", "=", this.orgId).orderBy("created_at").execute();
			return { campaigns, items, validations, rewards };
		});
		return {
			campaigns: rows.campaigns.map((r) => JSON.parse(r.data)),
			items: rows.items.map((r) => JSON.parse(r.data)),
			validations: rows.validations.map((r) => JSON.parse(r.data)),
			rewards: rows.rewards.map((r) => JSON.parse(r.data)),
		};
	}

	async saveFeedback(snapshot: FeedbackSnapshot): Promise<void> {
		await withOrg(this.ctx, this.orgId, async (trx) => {
			await trx.deleteFrom("feedback_rewards").where("org_id", "=", this.orgId).execute();
			await trx.deleteFrom("feedback_validation_responses").where("org_id", "=", this.orgId).execute();
			await trx.deleteFrom("feedback_items").where("org_id", "=", this.orgId).execute();
			await trx.deleteFrom("feedback_campaigns").where("org_id", "=", this.orgId).execute();
			if (snapshot.campaigns.length) {
				await trx
					.insertInto("feedback_campaigns")
					.values(snapshot.campaigns.map((c) => ({
						org_id: this.orgId,
						id: c.id,
						campaign_id: c.id,
						repo: c.repo,
						status: c.archived ? "archived" : "active",
						data: JSON.stringify(c),
						created_at: c.createdAt,
					})))
					.execute();
			}
			if (snapshot.items.length) {
				await trx
					.insertInto("feedback_items")
					.values(snapshot.items.map((i) => ({
						org_id: this.orgId,
						id: i.id,
						campaign_id: i.campaignId,
						repo: i.repo,
						status: i.status,
						data: JSON.stringify(i),
						created_at: i.createdAt,
					})))
					.execute();
			}
			if (snapshot.validations.length) {
				await trx
					.insertInto("feedback_validation_responses")
					.values(snapshot.validations.map((v) => ({
						org_id: this.orgId,
						id: v.id,
						campaign_id: v.campaignId,
						repo: v.repo,
						status: v.vote,
						data: JSON.stringify(v),
						created_at: v.createdAt,
					})))
					.execute();
			}
			if (snapshot.rewards.length) {
				await trx
					.insertInto("feedback_rewards")
					.values(snapshot.rewards.map((r) => ({
						org_id: this.orgId,
						id: r.id,
						campaign_id: r.campaignId,
						repo: r.repo,
						status: r.status,
						data: JSON.stringify(r),
						created_at: r.createdAt,
					})))
					.execute();
			}
		});
	}

	async appendAudit(entry: AuditEntry): Promise<void> {
		await appendOrgAudit(this.ctx, this.orgId, entry);
	}

	async appendUsage(receipt: RunReceipt): Promise<void> {
		await withOrg(this.ctx, this.orgId, async (trx) => {
			// One row per (org, run_id); a re-finalized run overwrites its row.
			await trx.deleteFrom("usage").where("org_id", "=", this.orgId).where("run_id", "=", receipt.runId).execute();
			await trx
				.insertInto("usage")
				.values({
					org_id: this.orgId,
					run_id: receipt.runId,
					trace_id: receipt.traceId ?? null,
					agent_id: receipt.agentId,
					repo: receipt.repo,
					model: receipt.model ?? null,
					started_at: receipt.startedAt,
					ended_at: receipt.endedAt ?? null,
					tool_calls: receipt.toolCalls,
					cost_usd: receipt.costUsd ?? null,
					tokens_total: receipt.tokens?.total ?? null,
					data: JSON.stringify(receipt),
				})
				.execute();
		});
	}

	private async loadTranscripts(): Promise<Record<string, TranscriptEntry[]>> {
		try {
			return JSON.parse(await fs.readFile(this.transcriptsFile, "utf8")) as Record<string, TranscriptEntry[]>;
		} catch {
			return {};
		}
	}

	private async saveTranscripts(transcripts: Record<string, TranscriptEntry[]>): Promise<void> {
		// Durable atomic write; swallow errors as the old inline temp+rename did.
		try {
			await writeFileDurable(this.transcriptsFile, JSON.stringify(transcripts));
		} catch {}
	}
}

/**
 * Free-standing `audit` table primitives — NOT part of the `Store` interface, so callers that don't
 * hold a `Store` instance can still write/read org-scoped audit rows. The voice mint route
 * (server.ts, plans/voice-db-mode/04-spend-controls.md) is the reason: it runs BEFORE the
 * `!manager` gate (minting is independent of any specific fleet manager, and a DB-mode refusal must
 * fire even with no active org), so it may have `ctx`/`orgId` from `voiceScope` with no per-org
 * `SquadManager`/`DbStore` resolved at all. `DbStore.appendAudit` above is now a thin wrapper over
 * `appendOrgAudit` so there is exactly one write path, not two that could drift.
 */

/** Fold `entry.source` into `entry.detail` (no dedicated `source` column — no migration for this
 *  concern) the same way in every write path, so DB-mode never silently loses the provenance tag
 *  the file-mode audit trail carries natively. Shared by `appendOrgAudit`, `reserveOrgAuditSlot`,
 *  and `finalizeOrgAuditDetail` so the three writers of an `audit` row can never drift on shape. */
function normalizeAuditDetail(entry: Pick<AuditEntry, "detail" | "source">): unknown {
	return entry.source === undefined
		? entry.detail
		: { ...(isPlainObject(entry.detail) ? entry.detail : entry.detail !== undefined ? { detail: entry.detail } : {}), source: entry.source };
}

/** Write one row directly into the org-scoped `audit` table. `entry.actor` is caller-supplied — the
 *  voice mint route passes `actor.id`, already `db:<userId>` in DB mode (never role-derived; see
 *  server.ts's actor construction), never re-derived here. No active org ⇒ no-op, never a throw —
 *  same guard discipline as the `org_secret` accessors below. */
export async function appendOrgAudit(ctx: OrgContext, orgId: string, entry: AuditEntry): Promise<void> {
	if (!orgId) return;
	await withOrg(ctx, orgId, async (trx) => {
		const detail = normalizeAuditDetail(entry);
		await trx
			.insertInto("audit")
			.values({
				id: nextAuditId(),
				org_id: orgId,
				actor: entry.actor,
				action: entry.action,
				target: entry.target ?? null,
				detail: detail === undefined ? null : JSON.stringify(detail),
				at: Date.now(),
			})
			.execute();
	});
}

/**
 * Atomically reserve one `audit` row for `entry.action`, refusing the write (no row, `reserved:
 * false`) once `cap` matching rows already exist inside `[sinceMs, now]`. This is the fix for the
 * check-then-act race the old count-before-mint/insert-after-mint split had: the row that reserves
 * a slot is now written BEFORE the caller's network round trip (the voice provider mint), not
 * after it returns, so a burst of concurrent requests can no longer all observe the same
 * pre-insert count and all pass. Count + insert happen inside ONE `withOrg` transaction.
 *
 * SQLite (bun:sqlite, self-host) serializes writers on its single connection, so the transaction
 * alone closes the race there. Postgres's default READ COMMITTED does NOT — two concurrent
 * transactions can each take their own snapshot before either commits and both see the pre-insert
 * count — so on Postgres this also takes a per-(org, action) transaction-scoped advisory lock
 * before counting. The lock serializes reservations for the same org+action only (unrelated orgs/
 * actions never contend) and releases automatically at commit/rollback, so a request that never
 * finalizes (crash mid-mint) can't wedge a future one.
 *
 * On success the caller MUST eventually call `finalizeOrgAuditDetail` (mint succeeded — the row
 * stays, now carrying the real detail) or `deleteOrgAuditRow` (mint failed — compensate, the
 * refused slot is freed) with the returned `auditId`. No active org ⇒ refused, never a throw.
 *
 * The inserted row's `detail` always carries `pending: true`, regardless of `entry.detail` — a
 * crash/SIGKILL between reservation and `finalizeOrgAuditDetail`/`deleteOrgAuditRow` (the window
 * `!result.ok` compensation can't cover) then leaves a row that is self-identifying as
 * unfinalized rather than indistinguishable from a real completed mint in the admin's audit
 * trail. `finalizeOrgAuditDetail` overwrites `detail` wholesale with the caller's real detail, so
 * the flag is cleared the instant the mint actually completes. */
export async function reserveOrgAuditSlot(
	ctx: OrgContext,
	orgId: string,
	entry: AuditEntry,
	cap: number,
	sinceMs: number,
): Promise<{ reserved: true; auditId: number } | { reserved: false }> {
	if (!orgId) return { reserved: false };
	return withOrg(ctx, orgId, async (trx) => {
		if (ctx.type === "postgres") {
			// Scoped to this org+action so unrelated reservations (a different org, or a different
			// audit action entirely) never contend for the same lock.
			await sql`select pg_advisory_xact_lock(hashtext(${`voice-audit-reserve:${orgId}:${entry.action}`}))`.execute(trx);
		}
		const row = await trx
			.selectFrom("audit")
			.select(({ fn }) => fn.countAll().as("n"))
			.where("org_id", "=", orgId)
			.where("action", "=", entry.action)
			.where("at", ">=", sinceMs)
			.executeTakeFirst();
		const count = row ? Number(row.n) : 0;
		if (count >= cap) return { reserved: false } as const;
		const id = nextAuditId();
		const baseDetail = normalizeAuditDetail(entry);
		// Always a plain object carrying `pending: true` — never `undefined`/non-object — so a row
		// that never reaches finalize/delete is unambiguously flagged in the stored JSON, not just
		// inferred from a missing providerSessionId (which is also legitimately absent on success).
		const detail: Record<string, unknown> = { ...(isPlainObject(baseDetail) ? baseDetail : baseDetail !== undefined ? { detail: baseDetail } : {}), pending: true };
		await trx
			.insertInto("audit")
			.values({
				id,
				org_id: orgId,
				actor: entry.actor,
				action: entry.action,
				target: entry.target ?? null,
				detail: JSON.stringify(detail),
				at: Date.now(),
			})
			.execute();
		return { reserved: true, auditId: id } as const;
	});
}

/** Overwrite a reserved row's `detail`/`source` once the caller's operation (the provider mint)
 *  actually completed — the row itself (id, actor, action, target, at) was already committed by
 *  `reserveOrgAuditSlot`, so this only ever updates the JSON blob. No active org ⇒ no-op. */
export async function finalizeOrgAuditDetail(ctx: OrgContext, orgId: string, auditId: number, entry: Pick<AuditEntry, "detail" | "source">): Promise<void> {
	if (!orgId) return;
	const detail = normalizeAuditDetail(entry);
	await withOrg(ctx, orgId, (trx) =>
		trx
			.updateTable("audit")
			.set({ detail: detail === undefined ? null : JSON.stringify(detail) })
			.where("org_id", "=", orgId)
			.where("id", "=", auditId)
			.execute(),
	);
}

/** Compensate a reservation whose downstream operation (the provider mint) failed — deletes the
 *  reserved row so it stops counting toward the cap it was never actually spent against, and never
 *  shows up as a phantom success in the audit trail. No active org ⇒ no-op. */
export async function deleteOrgAuditRow(ctx: OrgContext, orgId: string, auditId: number): Promise<void> {
	if (!orgId) return;
	await withOrg(ctx, orgId, (trx) => trx.deleteFrom("audit").where("org_id", "=", orgId).where("id", "=", auditId).execute());
}

/**
 * `org_secret` accessors — NOT part of the `Store` interface above: FileStore has no DB and no
 * org concept (DESIGN.md: "file mode never reads the table"), so these are free functions taking
 * an `OrgContext` directly, called only from DB-mode code paths (concern 03's resolver, concern
 * 05's admin endpoints).
 *
 * Every one of the four guards `if (!orgId)` BEFORE calling `withOrg` — `withOrg` itself THROWS
 * on an empty org id (see dal/context.ts), and a DB session with no active org is a real,
 * reachable state (an unauthenticated caller, a session mid-org-switch). Throwing a decrypt/store
 * call into a request because of that is exactly the "never a 500 at call time" posture this
 * concern rules out — the guard turns it into a clean "no secret" instead.
 */

/** One org's decrypted provider secret plus its metadata. `plaintext` is the raw credential —
 *  never logged, never returned to any HTTP response (the admin GET route returns `last4` only).
 *  Only `getOrgSecret` returns this full shape; `putOrgSecret` returns `OrgSecretSummary` (below)
 *  so the plaintext-free projection is enforced by the type checker, not by caller discipline. */
export interface OrgSecretRecord {
	provider: string;
	plaintext: string;
	last4: string;
	enabled: boolean;
	createdBy: string;
	updatedBy: string;
	createdAt: number;
	updatedAt: number;
}

/** `OrgSecretRecord` minus `plaintext` — the admin PUT response shape. DESIGN.md pins the admin
 *  GET at `{configured, last4, updatedAt, updatedBy, enabled}`; this is the write-path analogue
 *  that makes `return json(await putOrgSecret(...))` structurally safe instead of relying on
 *  concern 05's admin handler remembering to strip the field by hand. */
export type OrgSecretSummary = Omit<OrgSecretRecord, "plaintext">;

function toRecord(
	orgId: string,
	row: {
		provider: string;
		ciphertext: string;
		nonce: string;
		last4: string;
		enabled: number;
		created_by: string;
		updated_by: string;
		created_at: number;
		updated_at: number;
	},
): OrgSecretRecord | undefined {
	// Fail-closed: a corrupted row, a wrong/rotated master key, OR an AAD mismatch (this row's
	// ciphertext didn't actually originate from THIS org+provider pairing — e.g. a raw-row copy
	// across orgs) decrypts to `undefined` here, and that degrades to "no secret" for this org —
	// never a throw into the caller's request.
	const plaintext = decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, `${orgId}:${row.provider}`);
	if (plaintext === undefined) return undefined;
	return {
		provider: row.provider,
		plaintext,
		last4: row.last4,
		enabled: !!row.enabled,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		// Postgres returns bigint (int8) columns as strings (no pg.types.setTypeParser(20, ...) is
		// registered — see src/db/index.ts); SQLite returns a real number. Coerce explicitly so the
		// field is a `number` on both backends, matching the type this function declares.
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

/** Read + decrypt one org's provider secret. `undefined` covers every "no usable secret" case
 *  uniformly — no row, no active org, or a decrypt failure — callers don't get to distinguish
 *  them (nor should they: all three mean "voice unavailable for this org"). Does NOT consult
 *  `enabled` — the synchronous kill switch is a separate check the caller applies on the returned
 *  record, matching DESIGN.md's "Kill switch" row (deleting a key and disabling it are distinct
 *  levers). Consumed by the org-aware voice resolver's `voiceKeyFor` (voice-token.ts, concern 03). */
export async function getOrgSecret(ctx: OrgContext, orgId: string, provider: string): Promise<OrgSecretRecord | undefined> {
	if (!orgId) return undefined;
	const row = await withOrg(ctx, orgId, (trx) =>
		trx.selectFrom("org_secret").selectAll().where("org_id", "=", orgId).where("provider", "=", provider).executeTakeFirst(),
	);
	if (!row) return undefined;
	return toRecord(orgId, row);
}

/** Encrypt and upsert one org's provider secret (admin PUT). Returns `undefined` — never throws
 *  — when no master key is configured server-side: a write that can't be encrypted must not
 *  persist plaintext, so it persists nothing at all. `actor` is the `db:<userId>` tag (never
 *  role-derived, per DESIGN.md's "Mint audit discipline" row). A re-PUT ALWAYS sets `enabled: 1`,
 *  matching the insert path — a freshly provider-verified key re-save is an explicit
 *  re-provision, and must actually re-enable a previously-disabled row (the admin who just pasted
 *  a working key almost certainly wants it live now; the OFF-only-going-forward lever is the
 *  separate synchronous kill switch below). Returns `OrgSecretSummary` (no `plaintext`) — the
 *  admin HTTP handler can echo this response body directly without re-deriving a safe projection.
 *  Built entirely from the single `INSERT … ON CONFLICT … RETURNING` round trip below (no
 *  follow-up `getOrgSecret` SELECT + AES decrypt — the summary never needs the plaintext, and the
 *  RETURNING clause already carries the row's true `created_by`/`created_at`, which a
 *  build-from-scope shortcut would get wrong on the update path).
 *  Consumed by the admin PUT endpoint (server.ts, concern 05). */
export async function putOrgSecret(ctx: OrgContext, orgId: string, provider: string, plaintext: string, actor: string): Promise<OrgSecretSummary | undefined> {
	if (!orgId) return undefined;
	const enc = encryptSecret(plaintext, `${orgId}:${provider}`);
	if (!enc) return undefined;
	const now = Date.now();
	const last4Val = secretLast4(plaintext);
	const row = await withOrg(ctx, orgId, (trx) =>
		trx
			.insertInto("org_secret")
			.values({
				org_id: orgId,
				provider,
				ciphertext: enc.ciphertext,
				nonce: enc.nonce,
				last4: last4Val,
				enabled: 1,
				created_by: actor,
				updated_by: actor,
				created_at: now,
				updated_at: now,
			})
			.onConflict((oc) =>
				oc.columns(["org_id", "provider"]).doUpdateSet({
					ciphertext: enc.ciphertext,
					nonce: enc.nonce,
					last4: last4Val,
					enabled: 1,
					updated_by: actor,
					updated_at: now,
				}),
			)
			.returning(["provider", "last4", "enabled", "created_by", "updated_by", "created_at", "updated_at"])
			.executeTakeFirst(),
	);
	if (!row) return undefined;
	return {
		provider: row.provider,
		last4: row.last4,
		enabled: !!row.enabled,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		// Postgres returns bigint (int8) columns as strings; SQLite returns a real number — coerce
		// explicitly, matching `toRecord`'s handling of the same columns.
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

/** Delete one org's provider secret (admin DELETE). `ON DELETE CASCADE` on the org FK handles the
 *  bulk case (an org itself being deleted); this is the single-row admin-initiated removal.
 *  Consumed by the admin DELETE endpoint (server.ts, concern 05). */
export async function deleteOrgSecret(ctx: OrgContext, orgId: string, provider: string): Promise<void> {
	if (!orgId) return;
	await withOrg(ctx, orgId, (trx) => trx.deleteFrom("org_secret").where("org_id", "=", orgId).where("provider", "=", provider).execute());
}

/** Flip the synchronous kill switch (DESIGN.md "Kill switch" row) without touching the stored
 *  key — instant, reversible, no re-paste. A no-op (not an error) when the org has no row for
 *  this provider yet: there is nothing to enable/disable.
 *  Consumed by the admin enable/disable endpoint (server.ts, concern 05). */
export async function setOrgSecretEnabled(ctx: OrgContext, orgId: string, provider: string, enabled: boolean, actor: string): Promise<void> {
	if (!orgId) return;
	await withOrg(ctx, orgId, (trx) =>
		trx
			.updateTable("org_secret")
			.set({ enabled: enabled ? 1 : 0, updated_by: actor, updated_at: Date.now() })
			.where("org_id", "=", orgId)
			.where("provider", "=", provider)
			.execute(),
	);
}
