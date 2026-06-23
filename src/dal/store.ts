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
import { type OrgContext, withOrg } from "./context.ts";

/** Full persisted state the manager round-trips on save/load. */
export interface StateSnapshot {
	agents: PersistedAgent[];
	transcripts: Record<string, TranscriptEntry[]>;
	features: PersistedFeature[];
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
	/** Append one audit row (no-op for single-tenant file mode). */
	appendAudit(entry: AuditEntry): Promise<void>;
	/** Append/replace one run usage row (no-op for file mode — receipts already on disk). */
	appendUsage(receipt: RunReceipt): Promise<void>;
}

const EMPTY: StateSnapshot = { agents: [], transcripts: {}, features: [] };

/** Today's file-backed behavior: one `state.json` per stateDir, written temp+rename. */
export class FileStore implements Store {
	private readonly stateFile: string;
	constructor(private readonly stateDir: string) {
		this.stateFile = path.join(stateDir, "state.json");
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
		return { agents: parsed.agents ?? [], transcripts: parsed.transcripts ?? {}, features: parsed.features ?? [] };
	}

	async save(snapshot: StateSnapshot): Promise<void> {
		await fs.mkdir(this.stateDir, { recursive: true });
		const tmp = `${this.stateFile}.tmp`;
		try {
			await fs.writeFile(tmp, JSON.stringify({ version: 1, ...snapshot }, null, 2));
			await fs.rename(tmp, this.stateFile);
		} catch {
			await fs.rm(tmp, { force: true }).catch(() => {});
		}
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
			return !!f;
		});
	}

	async load(): Promise<StateSnapshot> {
		const { agents, features } = await withOrg(this.ctx, this.orgId, async (trx) => {
			const rosterRows = await trx.selectFrom("roster_index").select("data").where("org_id", "=", this.orgId).execute();
			const featureRows = await trx.selectFrom("features").select("data").where("org_id", "=", this.orgId).execute();
			return {
				agents: rosterRows.map((r) => JSON.parse(r.data) as PersistedAgent),
				features: featureRows.map((r) => JSON.parse(r.data) as PersistedFeature),
			};
		});
		return { agents, features, transcripts: await this.loadTranscripts() };
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
		});
		await this.saveTranscripts(snapshot.transcripts);
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
		await fs.mkdir(this.stateDir, { recursive: true });
		const tmp = `${this.transcriptsFile}.tmp`;
		try {
			await fs.writeFile(tmp, JSON.stringify(transcripts));
			await fs.rename(tmp, this.transcriptsFile);
		} catch {
			await fs.rm(tmp, { force: true }).catch(() => {});
		}
	}
}
