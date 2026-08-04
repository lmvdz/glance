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
import { sql, type Transaction } from "kysely";
import type { Channel, ChannelEntry, ChannelMembership, ChannelReadCursor } from "../channels.ts";
import type { Node } from "../memory/nodes.ts";
import { readNodeRecord, type NodeRecord } from "../memory/node-records.ts";
import { nonDelegatableClasses, type DelegationGrant } from "../delegation-boundary.ts";
import { readPlanProposal, type PlanProposal } from "../plan-proposals.ts";
import type { PersistedAgent, PersistedFeature, RunReceipt, TranscriptEntry } from "../types.ts";
import { normalizeCapabilitySnapshot, type CapabilitySnapshot } from "../capabilities/index.ts";
import { emptyFeedbackSnapshot, type FeedbackSnapshot } from "../feedback.ts";
import { decryptSecret, encryptSecret, last4 as secretLast4 } from "../secrets.ts";
import { type OrgContext, withOrg } from "./context.ts";
import type { AppDatabase } from "../db/schema.ts";
import { errText } from "../err-text.ts";
import { getStorageBackend } from "./storage.ts";

export interface ChannelSearchResult {
	entry: ChannelEntry;
	snippet: string;
}


function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChannel(value: unknown): Channel | undefined {
	if (!isPlainObject(value)) return undefined;
	const kind = value.kind;
	const visibility = value.visibility === "private" ? "private" : "org-public";
	return typeof value.id === "string" && typeof value.name === "string" && typeof value.createdAt === "number" && (kind === "default" || kind === "user")
		? { id: value.id, name: value.name, createdAt: value.createdAt, kind, visibility, creatorUserId: typeof value.creatorUserId === "string" ? value.creatorUserId : undefined }
		: undefined;
}

function readNode(value: unknown): Node | undefined {
	if (!isPlainObject(value)) return undefined;
	const kind = value.kind;
	const state = value.state;
	if (!(typeof value.id === "string" && typeof value.title === "string" && typeof value.createdAt === "number" && (kind === "plan" || kind === "unit" || kind === "subagent" || kind === "landing") && typeof state === "string")) return undefined;
	return {
		id: value.id,
		parentId: typeof value.parentId === "string" ? value.parentId : undefined,
		kind,
		title: value.title,
		state: state as Node["state"],
		ownerId: typeof value.ownerId === "string" ? value.ownerId : undefined,
		goal: typeof value.goal === "string" ? value.goal : undefined,
		createdAt: value.createdAt,
		settledAt: typeof value.settledAt === "number" ? value.settledAt : undefined,
		channelId: typeof value.channelId === "string" ? value.channelId : undefined,
	};
}

/** A grant is the ONLY door out of the non-delegatable class, so a half-decoded one is no grant at all. */
function readDelegationGrant(value: unknown): DelegationGrant | undefined {
	if (!isPlainObject(value)) return undefined;
	const { id, action, grantedBy, grantedAt, reason, revokedAt, revokedBy } = value;
	if (typeof id !== "string" || typeof action !== "string" || typeof grantedBy !== "string" || typeof grantedAt !== "number" || typeof reason !== "string") return undefined;
	if (!nonDelegatableClasses.includes(value.class as never)) return undefined;
	return {
		id,
		action,
		class: value.class as DelegationGrant["class"],
		grantedBy,
		grantedAt,
		reason,
		...(typeof revokedAt === "number" ? { revokedAt } : {}),
		...(typeof revokedBy === "string" ? { revokedBy } : {}),
	};
}

function readChannelMembership(value: unknown): ChannelMembership | undefined {
	if (!isPlainObject(value)) return undefined;
	return typeof value.channelId === "string" && typeof value.userId === "string" && typeof value.active === "boolean" && typeof value.updatedBy === "string" && typeof value.updatedAt === "number"
		? { channelId: value.channelId, userId: value.userId, active: value.active, updatedBy: value.updatedBy, updatedAt: value.updatedAt }
		: undefined;
}

function readChannelReadCursor(value: unknown): ChannelReadCursor | undefined {
	if (!isPlainObject(value)) return undefined;
	return typeof value.channelId === "string" && typeof value.userId === "string" && typeof value.lastReadSeq === "number" && typeof value.updatedAt === "number"
		? { channelId: value.channelId, userId: value.userId, lastReadSeq: value.lastReadSeq, updatedAt: value.updatedAt }
		: undefined;
}

function readChannelEntry(value: unknown): ChannelEntry | undefined {
	if (!isPlainObject(value)) return undefined;
	const kind = value.kind;
	const status = value.status;
	if (!(typeof value.id === "string" && typeof value.seq === "number" && typeof value.channelId === "string" && typeof value.authorActor === "string" && typeof value.text === "string" && typeof value.ts === "number" && (kind === "user" || kind === "assistant" || kind === "thinking" || kind === "tool" || kind === "system") && (status === undefined || status === "ok" || status === "error" || status === "cancelled"))) return undefined;
	return {
		id: value.id,
		seq: value.seq,
		channelId: value.channelId,
		authorActor: value.authorActor,
		authorDisplayName: typeof value.authorDisplayName === "string" ? value.authorDisplayName : undefined,
		authorOrigin: value.authorOrigin === "local" || value.authorOrigin === "remote" || value.authorOrigin === "agent" ? value.authorOrigin : undefined,
		replyToId: typeof value.replyToId === "string" ? value.replyToId : undefined,
		kind,
		text: value.text,
		ts: value.ts,
		status,
		format: value.format === "markdown" || value.format === "command" || value.format === "stage" || value.format === "plain" ? value.format : undefined,
		event:
			isPlainObject(value.event) && typeof value.event.kind === "string"
				? {
						kind: value.event.kind,
						...(typeof value.event.issuer === "string" ? { issuer: value.event.issuer } : {}),
						payload: value.event.payload,
					}
				: undefined,
	};
}

function searchSnippet(text: string, hitAt: number, length: number): string {
	const start = Math.max(0, hitAt - 48);
	const end = Math.min(text.length, hitAt + length + 96);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
	/** Load the capability lane's snapshot alone. Falls back to the legacy copy embedded in the
	 *  full snapshot until the first saveCapabilities migrates it out (concern 12, per-lane split). */
	loadCapabilities(): Promise<CapabilitySnapshot>;
	/** Persist the capability lane's snapshot alone — a capability mutation no longer rewrites
	 *  agents + every transcript through the full-blob save (its write amplification and crash
	 *  window become its own; same escape shape feedback took). */
	saveCapabilities(snapshot: CapabilitySnapshot): Promise<void>;
	/** Append one audit row (no-op for single-tenant file mode). */
	appendAudit(entry: AuditEntry): Promise<void>;
	/** Append/replace one run usage row (no-op for file mode — receipts already on disk). */
	appendUsage(receipt: RunReceipt): Promise<void>;
	/** Durable org-scoped channel primitives. File mode stores JSON/JSONL; DB mode stores rows. */
	listChannels(): Promise<Channel[]>;
	getChannel(id: string): Promise<Channel | undefined>;
	putChannel(channel: Channel): Promise<void>;
	/** Work graph primitives. Node visibility is always inherited from the bound channel. */
	listNodes(): Promise<Node[]>;
	getNode(id: string): Promise<Node | undefined>;
	putNode(node: Node): Promise<void>;
	/** Bind a lazy channel exactly once; returns undefined for an unknown node. */
	bindNodeChannel(nodeId: string, channelId: string): Promise<Node | undefined>;
	/** Durable evidence attached to a node. Missing records are unknown, never permission. */
	listNodeRecords(nodeId: string): Promise<NodeRecord[]>;
	putNodeRecord(record: NodeRecord): Promise<void>;
	/** Remove records by id. Only reachable through an authorized compaction — see `archive.ts`. */
	deleteNodeRecords(nodeId: string, ids: readonly string[]): Promise<number>;
	/** Human grants out of the non-delegatable class. An empty list means autonomy takes none of it. */
	listDelegationGrants(): Promise<DelegationGrant[]>;
	putDelegationGrant(grant: DelegationGrant): Promise<void>;
	/** Plans a human has been shown but not yet started. A proposal is not work. */
	listPlanProposals(): Promise<PlanProposal[]>;
	putPlanProposal(proposal: PlanProposal): Promise<void>;
	listChannelEntries(channelId: string, since?: number): Promise<ChannelEntry[]>;
	searchChannelEntries?(q: string, limit?: number, offset?: number): Promise<ChannelSearchResult[]>;
	appendChannelEntry(entry: Omit<ChannelEntry, "seq">): Promise<ChannelEntry>;
	nextChannelSeq(channelId: string): Promise<number>;
	listChannelMemberships(channelId: string): Promise<ChannelMembership[]>;
	putChannelMembership(row: ChannelMembership): Promise<void>;
	getChannelReadCursor(channelId: string, userId: string): Promise<ChannelReadCursor | undefined>;
	putChannelReadCursor(row: ChannelReadCursor): Promise<void>;
	/** Cumulative save() failures this process, when the store tracks them (FileStore only — DbStore's
	 *  per-write failures throw rather than swallow, so there's nothing to count). Surfaced through
	 *  factory-status since the topology guarantee now rests on this write actually landing. */
	saveFailures?(): number;
}

const EMPTY: StateSnapshot = { agents: [], transcripts: {}, features: [] };

/** Back-compat (daily-attention-w0 concern 01): pre-rename records persisted the completion-push
 *  latch as `voicePushArmed` (voice was its only arm source then). Map it forward once at load — in
 *  BOTH store implementations — so an armed latch, and the one push it owes, survives the upgrade
 *  instead of silently reading as unarmed under the new field name. Kind defaults to "voice": that
 *  is the only way a legacy record could have been armed. Never overwrites a new-name field. */
function migrateLegacyAgentFields(agents: PersistedAgent[]): PersistedAgent[] {
	for (const a of agents as Array<PersistedAgent & { voicePushArmed?: boolean }>) {
		if (a.completionPushArmed === undefined && a.voicePushArmed !== undefined) {
			a.completionPushArmed = a.voicePushArmed;
			if (a.voicePushArmed === true && a.completionPushKind === undefined) a.completionPushKind = "voice";
		}
	}
	return agents;
}

/** Today's file-backed behavior: one `state.json` per stateDir, written temp+rename. */
export class FileStore implements Store {
	private readonly stateFile: string;
	private readonly feedbackFile: string;
	private readonly capabilitiesFile: string;
	private saveFailureCount = 0;
	private lastSaveWarnAt = 0;
	private static readonly channelWriteLocks = new Map<string, Promise<void>>();
	private static readonly channelEntryWriteLocks = new Map<string, Promise<void>>();
	private static readonly nodeWriteLocks = new Map<string, Promise<void>>();
	constructor(private readonly stateDir: string) {
		this.stateFile = path.join(stateDir, "state.json");
		this.feedbackFile = path.join(stateDir, "feedback.json");
		this.capabilitiesFile = path.join(stateDir, "capabilities.json");
	}

	async hasState(): Promise<boolean> {
		// The split capability file counts (codex H3): if it landed but the first blob write never
		// did, a restart must still hydrate the lane — otherwise the next import overwrites the
		// only copy from an apparently-empty lane.
		return existsSync(this.stateFile) || existsSync(this.capabilitiesFile);
	}

	async load(): Promise<StateSnapshot> {
		let raw: string;
		try {
			raw = await fs.readFile(this.stateFile, "utf8");
		} catch {
			// No blob yet — but the split capability file may exist alone (codex H3): fold it in.
			const state: StateSnapshot = { ...EMPTY };
			if (existsSync(this.capabilitiesFile)) state.capabilities = await this.loadCapabilities();
			return state;
		}
		const parsed = JSON.parse(raw) as Partial<StateSnapshot>;
		const state: StateSnapshot = { agents: migrateLegacyAgentFields(parsed.agents ?? []), transcripts: parsed.transcripts ?? {}, features: parsed.features ?? [] };
		// Split file wins; the copy embedded in state.json is the legacy location, read only until
		// the first saveCapabilities writes the split file (concern 12 — same fold-in as feedback).
		if (existsSync(this.capabilitiesFile)) state.capabilities = await this.loadCapabilities();
		else if (parsed.capabilities) state.capabilities = normalizeCapabilitySnapshot(parsed.capabilities);
		if (existsSync(this.feedbackFile)) state.feedback = await this.loadFeedback();
		return state;
	}

	async save(snapshot: StateSnapshot): Promise<void> {
		// Durable atomic write (temp → fsync → rename → fsync dir). Behavior-preserving:
		// swallow write errors as the old inline temp+rename did, leaving no stray `.tmp` — but no longer
		// SILENTLY: a rate-limited warn plus a cumulative counter (surfaced via factory-status) since the
		// topology guarantee this store backs now rests on this write actually landing.
		try {
			const { feedback, capabilities, ...state } = snapshot;
			// Capabilities no longer ride the blob (concern 12): a caller that still passes them gets
			// them persisted through the split file — honored, never silently dropped — but state.json
			// itself stops carrying the copy, so a blob save stops rewriting the capability lane.
			// ORDER MATTERS (codex H2): the split file lands durably BEFORE the blob write erases the
			// legacy embedded copy — a crash between the two must never leave zero durable copies.
			if (capabilities) await this.saveCapabilities(capabilities);
			const body: StateSnapshot & { version: 1 } = { version: 1, agents: state.agents, transcripts: state.transcripts, features: state.features };
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

	async loadCapabilities(): Promise<CapabilitySnapshot> {
		// Split-file-wins is gated on EXISTENCE, not readability (codex M3): a malformed or
		// transiently unreadable capabilities.json must NOT silently fall back to the stale legacy
		// copy — a later mutation would then overwrite the newer snapshot with resurrected state.
		// The corrupt bytes are set aside (recoverable), the failure is loud, and the lane starts
		// empty rather than stale.
		if (existsSync(this.capabilitiesFile)) {
			try {
				return normalizeCapabilitySnapshot(JSON.parse(await fs.readFile(this.capabilitiesFile, "utf8")));
			} catch (err) {
				const aside = `${this.capabilitiesFile}.corrupt-${Date.now()}`;
				await fs.rename(this.capabilitiesFile, aside).catch(() => {});
				console.error(`[FileStore] capabilities.json unreadable — set aside at ${aside}, NOT falling back to the stale legacy copy: ${errText(err)}`);
				return normalizeCapabilitySnapshot(undefined);
			}
		}
		// Legacy location: embedded in state.json until the first saveCapabilities migrates it
		// out. Parsed as unknown — the normalizer IS the validator, no cast needed.
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.stateFile, "utf8"));
			const embedded = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).capabilities : undefined;
			return normalizeCapabilitySnapshot(embedded);
		} catch {
			return normalizeCapabilitySnapshot(undefined);
		}
	}

	async saveCapabilities(snapshot: CapabilitySnapshot): Promise<void> {
		await writeFileDurable(this.capabilitiesFile, JSON.stringify(normalizeCapabilitySnapshot(snapshot), null, 2));
	}

	// Single-tenant file mode: audit/usage live in the on-disk receipts; the DB ledger is DB-mode only.
	async appendAudit(): Promise<void> {}
	async appendUsage(): Promise<void> {}

	async listNodes(): Promise<Node[]> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "nodes.json"));
		if (!raw) return [];
		try {
			const decoded = JSON.parse(raw);
			return Array.isArray(decoded) ? decoded.map(readNode).filter((node): node is Node => node !== undefined).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) : [];
		} catch {
			return [];
		}
	}

	async getNode(id: string): Promise<Node | undefined> {
		return (await this.listNodes()).find((node) => node.id === id);
	}

	async putNode(node: Node): Promise<void> {
		const file = path.join(this.stateDir, "nodes.json");
		const prior = FileStore.nodeWriteLocks.get(file) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.nodeWriteLocks.set(file, next);
		await prior;
		try {
			const nodes = await this.listNodes();
			const index = nodes.findIndex((existing) => existing.id === node.id);
			if (index >= 0) nodes[index] = node;
			else nodes.push(node);
			await getStorageBackend().writeDurable(file, JSON.stringify(nodes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), null, 2));
		} finally {
			release();
			if (FileStore.nodeWriteLocks.get(file) === next) FileStore.nodeWriteLocks.delete(file);
		}
	}

	async bindNodeChannel(nodeId: string, channelId: string): Promise<Node | undefined> {
		const file = path.join(this.stateDir, "nodes.json");
		const prior = FileStore.nodeWriteLocks.get(file) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.nodeWriteLocks.set(file, next);
		await prior;
		try {
			const nodes = await this.listNodes();
			const index = nodes.findIndex((node) => node.id === nodeId);
			if (index < 0) return undefined;
			const current = nodes[index]!;
			if (current.channelId) return current;
			const bound = { ...current, channelId };
			nodes[index] = bound;
			await getStorageBackend().writeDurable(file, JSON.stringify(nodes, null, 2));
			return bound;
		} finally {
			release();
			if (FileStore.nodeWriteLocks.get(file) === next) FileStore.nodeWriteLocks.delete(file);
		}
	}

	async listNodeRecords(nodeId: string): Promise<NodeRecord[]> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "node-records.json"));
		if (!raw) return [];
		try {
			const decoded = JSON.parse(raw);
			return Array.isArray(decoded)
				? decoded.map(readNodeRecord).filter((record): record is NodeRecord => record !== undefined && record.nodeId === nodeId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
				: [];
		} catch {
			return [];
		}
	}

	async putNodeRecord(record: NodeRecord): Promise<void> {
		const file = path.join(this.stateDir, "node-records.json");
		const prior = FileStore.nodeWriteLocks.get(file) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.nodeWriteLocks.set(file, next);
		await prior;
		try {
			const raw = await getStorageBackend().readText(file);
			const existing = raw ? JSON.parse(raw) : [];
			const records = Array.isArray(existing) ? existing.map(readNodeRecord).filter((value): value is NodeRecord => value !== undefined) : [];
			const index = records.findIndex((value) => value.id === record.id);
			if (index >= 0) records[index] = record;
			else records.push(record);
			await getStorageBackend().writeDurable(file, JSON.stringify(records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), null, 2));
		} finally {
			release();
			if (FileStore.nodeWriteLocks.get(file) === next) FileStore.nodeWriteLocks.delete(file);
		}
	}

	async deleteNodeRecords(nodeId: string, ids: readonly string[]): Promise<number> {
		const file = path.join(this.stateDir, "node-records.json");
		const remove = new Set(ids);
		const prior = FileStore.nodeWriteLocks.get(file) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.nodeWriteLocks.set(file, next);
		await prior;
		try {
			const raw = await getStorageBackend().readText(file);
			const existing = raw ? JSON.parse(raw) : [];
			const records = Array.isArray(existing) ? existing.map(readNodeRecord).filter((value): value is NodeRecord => value !== undefined) : [];
			const kept = records.filter((record) => !(record.nodeId === nodeId && remove.has(record.id)));
			await getStorageBackend().writeDurable(file, JSON.stringify(kept, null, 2));
			return records.length - kept.length;
		} finally {
			release();
			if (FileStore.nodeWriteLocks.get(file) === next) FileStore.nodeWriteLocks.delete(file);
		}
	}

	async listPlanProposals(): Promise<PlanProposal[]> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "plan-proposals.json"));
		if (!raw) return [];
		try {
			const decoded = JSON.parse(raw);
			return Array.isArray(decoded) ? decoded.map(readPlanProposal).filter((value): value is PlanProposal => value !== undefined).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) : [];
		} catch {
			return [];
		}
	}

	async putPlanProposal(proposal: PlanProposal): Promise<void> {
		const file = path.join(this.stateDir, "plan-proposals.json");
		const prior = FileStore.nodeWriteLocks.get(file) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.nodeWriteLocks.set(file, next);
		await prior;
		try {
			const raw = await getStorageBackend().readText(file);
			const existing = raw ? JSON.parse(raw) : [];
			const all = Array.isArray(existing) ? existing.map(readPlanProposal).filter((value): value is PlanProposal => value !== undefined) : [];
			const index = all.findIndex((value) => value.id === proposal.id);
			if (index >= 0) all[index] = proposal;
			else all.push(proposal);
			await getStorageBackend().writeDurable(file, JSON.stringify(all.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), null, 2));
		} finally {
			release();
			if (FileStore.nodeWriteLocks.get(file) === next) FileStore.nodeWriteLocks.delete(file);
		}
	}

	async listDelegationGrants(): Promise<DelegationGrant[]> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "delegation-grants.json"));
		if (!raw) return [];
		try {
			const decoded = JSON.parse(raw);
			return Array.isArray(decoded) ? decoded.map(readDelegationGrant).filter((grant): grant is DelegationGrant => grant !== undefined).sort((a, b) => a.grantedAt - b.grantedAt || a.id.localeCompare(b.id)) : [];
		} catch {
			return [];
		}
	}

	async putDelegationGrant(grant: DelegationGrant): Promise<void> {
		const file = path.join(this.stateDir, "delegation-grants.json");
		const prior = FileStore.nodeWriteLocks.get(file) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.nodeWriteLocks.set(file, next);
		await prior;
		try {
			const raw = await getStorageBackend().readText(file);
			const existing = raw ? JSON.parse(raw) : [];
			const grants = Array.isArray(existing) ? existing.map(readDelegationGrant).filter((value): value is DelegationGrant => value !== undefined) : [];
			const index = grants.findIndex((value) => value.id === grant.id);
			if (index >= 0) grants[index] = grant;
			else grants.push(grant);
			await getStorageBackend().writeDurable(file, JSON.stringify(grants.sort((a, b) => a.grantedAt - b.grantedAt || a.id.localeCompare(b.id)), null, 2));
		} finally {
			release();
			if (FileStore.nodeWriteLocks.get(file) === next) FileStore.nodeWriteLocks.delete(file);
		}
	}

	async listChannels(): Promise<Channel[]> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "channels.json"));
		if (!raw) return [];
		try {
			const decoded = JSON.parse(raw);
			return Array.isArray(decoded) ? decoded.map(readChannel).filter((c): c is Channel => c !== undefined) : [];
		} catch {
			return [];
		}
	}

	async getChannel(id: string): Promise<Channel | undefined> {
		return (await this.listChannels()).find((c) => c.id === id);
	}

	async putChannel(channel: Channel): Promise<void> {
		const file = path.join(this.stateDir, "channels.json");
		const prior = FileStore.channelWriteLocks.get(file) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.channelWriteLocks.set(file, next);
		await prior;
		try {
			const existing = await this.listChannels();
			const current = existing.find((c) => c.id === channel.id);
			if (current) {
				if (current.visibility !== channel.visibility || current.creatorUserId !== channel.creatorUserId || current.name !== channel.name) throw new Error("channel already exists");
				return;
			}
			const channels = [...existing, channel].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
			await getStorageBackend().writeDurable(file, JSON.stringify(channels, null, 2));
		} finally {
			release();
			if (FileStore.channelWriteLocks.get(file) === next) FileStore.channelWriteLocks.delete(file);
		}
	}

	async listChannelEntries(channelId: string, since = 0): Promise<ChannelEntry[]> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "channels.jsonl"));
		if (!raw) return [];
		const entries: ChannelEntry[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = readChannelEntry(JSON.parse(line));
				if (entry?.channelId === channelId && entry.seq > since) entries.push(entry);
			} catch {}
		}
		return entries.sort((a, b) => a.seq - b.seq);
	}

	async searchChannelEntries(q: string, limit = 50, offset = 0): Promise<ChannelSearchResult[]> {
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "channels.jsonl"));
		if (!raw) return [];
		const results: ChannelSearchResult[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = readChannelEntry(JSON.parse(line));
				if (!entry) continue;
				const text = entry.displayText ?? entry.text;
				const hitAt = text.toLowerCase().indexOf(needle);
				if (hitAt === -1) continue;
				results.push({ entry, snippet: searchSnippet(text, hitAt, q.trim().length) });
			} catch {}
		}
		return results.sort((a, b) => b.entry.ts - a.entry.ts || b.entry.seq - a.entry.seq).slice(offset, offset + limit);
	}


	async appendChannelEntry(entry: Omit<ChannelEntry, "seq">): Promise<ChannelEntry> {
		const file = path.join(this.stateDir, "channels.jsonl");
		const prior = FileStore.channelEntryWriteLocks.get(file)?.catch(() => {}) ?? Promise.resolve();
		let release!: () => void;
		const next = prior.then(() => new Promise<void>((resolve) => { release = resolve; }));
		FileStore.channelEntryWriteLocks.set(file, next);
		await prior;
		try {
			const persisted = { ...entry, seq: (await this.nextChannelSeq(entry.channelId)) + 1 };
			await getStorageBackend().appendDurable(file, `${JSON.stringify(persisted)}\n`);
			return persisted;
		} finally {
			release();
			if (FileStore.channelEntryWriteLocks.get(file) === next) FileStore.channelEntryWriteLocks.delete(file);
		}
	}

	async nextChannelSeq(channelId: string): Promise<number> {
		return (await this.listChannelEntries(channelId, 0)).reduce((max, entry) => Math.max(max, entry.seq), 0);
	}

	async listChannelMemberships(channelId: string): Promise<ChannelMembership[]> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "channel-memberships.jsonl"));
		if (!raw) return [];
		const latest = new Map<string, ChannelMembership>();
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = readChannelMembership(JSON.parse(line));
				if (row?.channelId === channelId) latest.set(row.userId, row);
			} catch {}
		}
		return [...latest.values()].sort((a, b) => a.userId.localeCompare(b.userId));
	}

	async putChannelMembership(row: ChannelMembership): Promise<void> {
		await getStorageBackend().appendDurable(path.join(this.stateDir, "channel-memberships.jsonl"), `${JSON.stringify(row)}\n`);
	}

	async getChannelReadCursor(channelId: string, userId: string): Promise<ChannelReadCursor | undefined> {
		const raw = await getStorageBackend().readText(path.join(this.stateDir, "channel-read-cursors.jsonl"));
		if (!raw) return undefined;
		let latest: ChannelReadCursor | undefined;
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = readChannelReadCursor(JSON.parse(line));
				if (row?.channelId === channelId && row.userId === userId) latest = row;
			} catch {}
		}
		return latest;
	}

	async putChannelReadCursor(row: ChannelReadCursor): Promise<void> {
		await getStorageBackend().appendDurable(path.join(this.stateDir, "channel-read-cursors.jsonl"), `${JSON.stringify(row)}\n`);
	}
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

	/** Parse capability_records rows into a snapshot — shared by load() and loadCapabilities(). */
	private static capRowsToSnapshot(rows: Array<{ kind: string; data: string }>): CapabilitySnapshot {
		const cap: Partial<CapabilitySnapshot> = {};
		for (const row of rows) {
			const data = JSON.parse(row.data) as unknown;
			if (row.kind === "sources" && Array.isArray(data)) cap.sources = data as CapabilitySnapshot["sources"];
			else if (row.kind === "packs" && Array.isArray(data)) cap.packs = data as CapabilitySnapshot["packs"];
			else if (row.kind === "installs" && Array.isArray(data)) cap.installs = data as CapabilitySnapshot["installs"];
			else if (row.kind === "verifications" && Array.isArray(data)) cap.verifications = data as CapabilitySnapshot["verifications"];
			else if (row.kind === "audit" && Array.isArray(data)) cap.audit = data as CapabilitySnapshot["audit"];
		}
		return normalizeCapabilitySnapshot(cap);
	}

	async load(): Promise<StateSnapshot> {
		const { agents, features, capabilities } = await withOrg(this.ctx, this.orgId, async (trx) => {
			const rosterRows = await trx.selectFrom("roster_index").select("data").where("org_id", "=", this.orgId).execute();
			const featureRows = await trx.selectFrom("features").select("data").where("org_id", "=", this.orgId).execute();
			const capabilityRows = await trx.selectFrom("capability_records").select(["kind", "data"]).where("org_id", "=", this.orgId).execute();
			return {
				agents: migrateLegacyAgentFields(rosterRows.map((r) => JSON.parse(r.data) as PersistedAgent)),
				features: featureRows.map((r) => JSON.parse(r.data) as PersistedFeature),
				capabilities: DbStore.capRowsToSnapshot(capabilityRows),
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
			// Capabilities no longer ride the blob save when absent (concern 12): persistNow stops
			// passing them, and their full replace happens through saveCapabilities below. A caller
			// that still passes them gets the same delete+insert — honored, never silently dropped.
			if (snapshot.capabilities) await this.writeCapabilityRecords(trx, snapshot.capabilities, now);
		});
		await this.saveTranscripts(snapshot.transcripts);
		if (snapshot.feedback) await this.saveFeedback(snapshot.feedback);
	}

	/** Full replace of this org's capability rows — shared by save() and saveCapabilities(). */
	private async writeCapabilityRecords(trx: Transaction<AppDatabase>, capabilities: CapabilitySnapshot, now: number): Promise<void> {
		await trx.deleteFrom("capability_records").where("org_id", "=", this.orgId).execute();
		const cap = normalizeCapabilitySnapshot(capabilities);
		await trx.insertInto("capability_records").values([
			{ org_id: this.orgId, id: "sources", kind: "sources", data: JSON.stringify(cap.sources), updated_at: now },
			{ org_id: this.orgId, id: "packs", kind: "packs", data: JSON.stringify(cap.packs), updated_at: now },
			{ org_id: this.orgId, id: "installs", kind: "installs", data: JSON.stringify(cap.installs), updated_at: now },
			{ org_id: this.orgId, id: "verifications", kind: "verifications", data: JSON.stringify(cap.verifications), updated_at: now },
			{ org_id: this.orgId, id: "audit", kind: "audit", data: JSON.stringify(cap.audit), updated_at: now },
		]).execute();
	}

	async loadCapabilities(): Promise<CapabilitySnapshot> {
		const rows = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("capability_records").select(["kind", "data"]).where("org_id", "=", this.orgId).execute());
		return DbStore.capRowsToSnapshot(rows);
	}

	async saveCapabilities(snapshot: CapabilitySnapshot): Promise<void> {
		const now = Date.now();
		await withOrg(this.ctx, this.orgId, (trx) => this.writeCapabilityRecords(trx, snapshot, now));
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

	async listChannels(): Promise<Channel[]> {
		return withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("channels").select(["id", "name", "created_at", "kind", "visibility", "creator_user_id"]).where("org_id", "=", this.orgId).orderBy("created_at").execute())
			.then((rows) => rows.map((r) => ({ id: r.id, name: r.name, createdAt: Number(r.created_at), kind: r.kind as Channel["kind"], visibility: r.visibility as Channel["visibility"], creatorUserId: r.creator_user_id ?? undefined })));
	}

	async getChannel(id: string): Promise<Channel | undefined> {
		const row = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("channels").select(["id", "name", "created_at", "kind", "visibility", "creator_user_id"]).where("org_id", "=", this.orgId).where("id", "=", id).executeTakeFirst());
		return row ? { id: row.id, name: row.name, createdAt: Number(row.created_at), kind: row.kind as Channel["kind"], visibility: row.visibility as Channel["visibility"], creatorUserId: row.creator_user_id ?? undefined } : undefined;
	}

	async putChannel(channel: Channel): Promise<void> {
		await withOrg(this.ctx, this.orgId, (trx) =>
			trx
				.insertInto("channels")
				.values({ org_id: this.orgId, id: channel.id, name: channel.name, kind: channel.kind, created_at: channel.createdAt, visibility: channel.visibility, creator_user_id: channel.creatorUserId ?? null })
				.onConflict((oc) => oc.columns(["org_id", "id"]).doNothing())
				.execute(),
		);
	}

	async listNodes(): Promise<Node[]> {
		const rows = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("nodes").selectAll().where("org_id", "=", this.orgId).orderBy("created_at").execute());
		return rows.map((row) => ({ id: row.id, parentId: row.parent_id ?? undefined, kind: row.kind as Node["kind"], title: row.title, state: row.state as Node["state"], ownerId: row.owner_id ?? undefined, goal: row.goal ?? undefined, createdAt: Number(row.created_at), settledAt: row.settled_at === null ? undefined : Number(row.settled_at), channelId: row.channel_id ?? undefined }));
	}

	async getNode(id: string): Promise<Node | undefined> {
		const row = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("nodes").selectAll().where("org_id", "=", this.orgId).where("id", "=", id).executeTakeFirst());
		return row ? { id: row.id, parentId: row.parent_id ?? undefined, kind: row.kind as Node["kind"], title: row.title, state: row.state as Node["state"], ownerId: row.owner_id ?? undefined, goal: row.goal ?? undefined, createdAt: Number(row.created_at), settledAt: row.settled_at === null ? undefined : Number(row.settled_at), channelId: row.channel_id ?? undefined } : undefined;
	}

	async putNode(node: Node): Promise<void> {
		await withOrg(this.ctx, this.orgId, (trx) =>
			trx.insertInto("nodes").values({ org_id: this.orgId, id: node.id, parent_id: node.parentId ?? null, kind: node.kind, title: node.title, state: node.state, owner_id: node.ownerId ?? null, goal: node.goal ?? null, created_at: node.createdAt, settled_at: node.settledAt ?? null, channel_id: node.channelId ?? null }).onConflict((oc) => oc.columns(["org_id", "id"]).doUpdateSet({ parent_id: node.parentId ?? null, kind: node.kind, title: node.title, state: node.state, owner_id: node.ownerId ?? null, goal: node.goal ?? null, created_at: node.createdAt, settled_at: node.settledAt ?? null, channel_id: node.channelId ?? null })).execute(),
		);
	}

	async bindNodeChannel(nodeId: string, channelId: string): Promise<Node | undefined> {
		await withOrg(this.ctx, this.orgId, (trx) => trx.updateTable("nodes").set({ channel_id: channelId }).where("org_id", "=", this.orgId).where("id", "=", nodeId).where("channel_id", "is", null).execute());
		return this.getNode(nodeId);
	}

	async listNodeRecords(nodeId: string): Promise<NodeRecord[]> {
		const rows = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("node_records").select(["data"]).where("org_id", "=", this.orgId).where("node_id", "=", nodeId).orderBy("created_at").execute());
		return rows.map((row) => readNodeRecord(JSON.parse(row.data))).filter((record): record is NodeRecord => record !== undefined);
	}

	async putNodeRecord(record: NodeRecord): Promise<void> {
		await withOrg(this.ctx, this.orgId, (trx) =>
			trx.insertInto("node_records").values({ org_id: this.orgId, id: record.id, node_id: record.nodeId, kind: record.kind, created_at: record.createdAt, data: JSON.stringify(record) }).onConflict((oc) => oc.columns(["org_id", "id"]).doUpdateSet({ node_id: record.nodeId, kind: record.kind, created_at: record.createdAt, data: JSON.stringify(record) })).execute(),
		);
	}

	async deleteNodeRecords(nodeId: string, ids: readonly string[]): Promise<number> {
		if (ids.length === 0) return 0;
		const result = await withOrg(this.ctx, this.orgId, (trx) =>
			trx.deleteFrom("node_records").where("org_id", "=", this.orgId).where("node_id", "=", nodeId).where("id", "in", [...ids]).executeTakeFirst(),
		);
		return Number(result?.numDeletedRows ?? 0);
	}

	async listPlanProposals(): Promise<PlanProposal[]> {
		const rows = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("plan_proposals").select(["data"]).where("org_id", "=", this.orgId).orderBy("created_at").execute());
		return rows.map((row) => readPlanProposal(JSON.parse(row.data))).filter((value): value is PlanProposal => value !== undefined);
	}

	async putPlanProposal(proposal: PlanProposal): Promise<void> {
		await withOrg(this.ctx, this.orgId, (trx) =>
			trx.insertInto("plan_proposals").values({ org_id: this.orgId, id: proposal.id, status: proposal.status, created_at: proposal.createdAt, data: JSON.stringify(proposal) }).onConflict((oc) => oc.columns(["org_id", "id"]).doUpdateSet({ status: proposal.status, created_at: proposal.createdAt, data: JSON.stringify(proposal) })).execute(),
		);
	}

	async listDelegationGrants(): Promise<DelegationGrant[]> {
		const rows = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("delegation_grants").select(["data"]).where("org_id", "=", this.orgId).orderBy("granted_at").execute());
		return rows.map((row) => readDelegationGrant(JSON.parse(row.data))).filter((grant): grant is DelegationGrant => grant !== undefined);
	}

	async putDelegationGrant(grant: DelegationGrant): Promise<void> {
		await withOrg(this.ctx, this.orgId, (trx) =>
			trx.insertInto("delegation_grants").values({ org_id: this.orgId, id: grant.id, action: grant.action, granted_at: grant.grantedAt, data: JSON.stringify(grant) }).onConflict((oc) => oc.columns(["org_id", "id"]).doUpdateSet({ action: grant.action, granted_at: grant.grantedAt, data: JSON.stringify(grant) })).execute(),
		);
	}

	async listChannelEntries(channelId: string, since = 0): Promise<ChannelEntry[]> {
		const rows = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("channel_entries").select(["data"]).where("org_id", "=", this.orgId).where("channel_id", "=", channelId).where("seq", ">", since).orderBy("seq").execute());
		return rows.map((r) => readChannelEntry(JSON.parse(r.data))).filter((entry): entry is ChannelEntry => entry !== undefined);
	}

	async searchChannelEntries(q: string, limit = 50, offset = 0): Promise<ChannelSearchResult[]> {
		const needle = q.trim();
		if (!needle) return [];
		const pattern = `%${escapeLike(needle)}%`;
		const rows = await withOrg(this.ctx, this.orgId, (trx) =>
			trx
				.selectFrom("channel_entries")
				.select(["data"])
				.where("org_id", "=", this.orgId)
				.where(sql`json_extract(data, '$.text')`, "like", pattern)
				.orderBy("ts", "desc")
				.limit(limit)
				.offset(offset)
				.execute(),
		);
		return rows
			.map((r) => readChannelEntry(JSON.parse(r.data)))
			.filter((entry): entry is ChannelEntry => entry !== undefined)
			.map((entry) => {
				const text = entry.displayText ?? entry.text;
				const hitAt = text.toLowerCase().indexOf(needle.toLowerCase());
				return { entry, snippet: searchSnippet(text, hitAt < 0 ? 0 : hitAt, needle.length) };
			});
	}


	async appendChannelEntry(entry: Omit<ChannelEntry, "seq">): Promise<ChannelEntry> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await withOrg(this.ctx, this.orgId, async (trx) => {
					const row = await trx.selectFrom("channel_entries").select(({ fn }) => fn.max("seq").as("seq")).where("org_id", "=", this.orgId).where("channel_id", "=", entry.channelId).executeTakeFirst();
					const persisted = { ...entry, seq: Number(row?.seq ?? 0) + 1 };
					await trx.insertInto("channel_entries").values({ org_id: this.orgId, channel_id: persisted.channelId, id: persisted.id, seq: persisted.seq, author_actor: persisted.authorActor, reply_to_id: persisted.replyToId ?? null, ts: persisted.ts, data: JSON.stringify(persisted) }).execute();
					return persisted;
				});
			} catch (err) {
				if (attempt >= 2 || !(err instanceof Error && /unique constraint|duplicate key/i.test(err.message))) throw err;
			}
		}
	}

	async nextChannelSeq(channelId: string): Promise<number> {
		const row = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("channel_entries").select(({ fn }) => fn.max("seq").as("seq")).where("org_id", "=", this.orgId).where("channel_id", "=", channelId).executeTakeFirst());
		return Number(row?.seq ?? 0);
	}

	async listChannelMemberships(channelId: string): Promise<ChannelMembership[]> {
		return withOrg(this.ctx, this.orgId, async (trx) => {
			const rows = await trx.selectFrom("channel_memberships").select(["channel_id", "user_id", "active", "updated_by", "updated_at"]).where("org_id", "=", this.orgId).where("channel_id", "=", channelId).orderBy("user_id").execute();
			return rows.map((row) => ({ channelId: row.channel_id, userId: row.user_id, active: !!row.active, updatedBy: row.updated_by, updatedAt: Number(row.updated_at) }));
		});
	}

	async putChannelMembership(row: ChannelMembership): Promise<void> {
		await withOrg(this.ctx, this.orgId, (trx) =>
			trx.insertInto("channel_memberships").values({ org_id: this.orgId, channel_id: row.channelId, user_id: row.userId, active: row.active ? 1 : 0, updated_by: row.updatedBy, updated_at: row.updatedAt }).onConflict((oc) => oc.columns(["org_id", "channel_id", "user_id"]).doUpdateSet({ active: row.active ? 1 : 0, updated_by: row.updatedBy, updated_at: row.updatedAt })).execute(),
		);
	}

	async getChannelReadCursor(channelId: string, userId: string): Promise<ChannelReadCursor | undefined> {
		const row = await withOrg(this.ctx, this.orgId, (trx) => trx.selectFrom("channel_read_cursors").select(["channel_id", "user_id", "last_read_seq", "updated_at"]).where("org_id", "=", this.orgId).where("channel_id", "=", channelId).where("user_id", "=", userId).executeTakeFirst());
		return row ? { channelId: row.channel_id, userId: row.user_id, lastReadSeq: Number(row.last_read_seq), updatedAt: Number(row.updated_at) } : undefined;
	}

	async putChannelReadCursor(row: ChannelReadCursor): Promise<void> {
		await withOrg(this.ctx, this.orgId, (trx) =>
			trx.insertInto("channel_read_cursors").values({ org_id: this.orgId, channel_id: row.channelId, user_id: row.userId, last_read_seq: row.lastReadSeq, updated_at: row.updatedAt }).onConflict((oc) => oc.columns(["org_id", "channel_id", "user_id"]).doUpdateSet({ last_read_seq: row.lastReadSeq, updated_at: row.updatedAt })).execute(),
		);
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
