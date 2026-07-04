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

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersistedAgent, PersistedFeature, RunReceipt, TranscriptEntry } from "../types.ts";
import { normalizeCapabilitySnapshot, type CapabilitySnapshot } from "../capabilities/index.ts";
import { emptyFeedbackSnapshot, type FeedbackSnapshot } from "../feedback.ts";
import { type OrgContext, withOrg } from "./context.ts";

/**
 * Atomically + durably write `data` to `file`: temp → fsync(file) → rename → fsync(dir).
 * After this resolves, the bytes survive a host crash (POSIX and Archil both define
 * fsync as the durability barrier). On any throw the temp file is best-effort removed,
 * preserving the old store behavior of never leaving a stray `.tmp` as truth.
 *
 * ponytail: the directory-fd fsync (which makes the rename itself durable) is skipped
 * on platforms where opening a dir for fsync fails — some FUSE mounts reject it. We
 * swallow EISDIR/EINVAL/EBADF/EPERM/ENOTSUP there and proceed; the file-bytes fsync
 * still holds. Upgrade path: a platform-specific dir-sync syscall if a target ever needs
 * the rename barrier and the dir-fd open is the only thing blocking it.
 */
export async function writeFileDurable(file: string, data: string): Promise<void> {
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${file}.tmp`;
	try {
		const fh = await fs.open(tmp, "w");
		try {
			await fh.writeFile(data);
			await fh.sync(); // fsync the file's bytes before the rename
		} finally {
			await fh.close();
		}
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
	// fsync the directory so the rename entry itself is durable.
	try {
		const dfh = await fs.open(dir, "r");
		try {
			await dfh.sync();
		} finally {
			await dfh.close();
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code && !["EISDIR", "EINVAL", "EBADF", "EPERM", "ENOTSUP"].includes(code)) throw err;
	}
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

let auditSeq = 0;
/** Monotonic, collision-free audit id (epoch-ms × 1000 + per-process counter). */
function nextAuditId(): number {
	return Date.now() * 1000 + (auditSeq++ % 1000);
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
		await withOrg(this.ctx, this.orgId, async (trx) => {
			await trx
				.insertInto("audit")
				.values({
					id: nextAuditId(),
					org_id: this.orgId,
					actor: entry.actor,
					action: entry.action,
					target: entry.target ?? null,
					detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
					at: Date.now(),
				})
				.execute();
		});
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
