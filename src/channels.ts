import { randomUUID } from "node:crypto";
import type { Store } from "./dal/store.ts";
import { neutralizeDelimiters } from "./digest.ts";
import { redact } from "./redact.ts";
import { EVENT_ISSUER_MANAGER } from "./transcript-event-kinds.ts";
import type { Actor, TranscriptEntry } from "./types.ts";

export const DEFAULT_CHANNEL_ID = "fleet";
export const DEFAULT_CHANNEL_NAME = "#fleet";

type ClientChannelEvent = never;

export type ChannelVisibility = "org-public" | "private";

export interface Channel {
	id: string;
	name: string;
	createdAt: number;
	kind: "default" | "user";
	visibility: ChannelVisibility;
	creatorUserId?: string;
}

export interface ChannelEntry extends TranscriptEntry {
	id: string;
	seq: number;
	channelId: string;
	authorActor: string;
	authorDisplayName?: string;
	authorOrigin?: Actor["origin"];
	replyToId?: string;
	/**
	 * Manager-authored card payload. Client appends must never set this; `issuer` is
	 * stamped by appendManager from the verified writer, never from input. Optional only
	 * because rows persisted before provenance landed lack it (those read as "manager").
	 */
	event?: { kind: string; issuer?: string; payload: unknown };
}

export interface ClientChannelPost {
	text: string;
	replyToId?: string;
	/** Compile-time tripwire: clients cannot author proof/card events. */
	event?: ClientChannelEvent;
}

export interface ManagerChannelPost {
	text: string;
	authorActor: string;
	authorDisplayName?: string;
	authorOrigin?: Actor["origin"];
	replyToId?: string;
	event?: { kind: string; payload: unknown };
	kind?: ChannelEntry["kind"];
	format?: ChannelEntry["format"];
}

export interface ChannelSearchResult {
	entry: ChannelEntry;
	snippet: string;
}

export interface ChannelMembership {
	channelId: string;
	userId: string;
	active: boolean;
	updatedBy: string;
	updatedAt: number;
}

export interface CreateChannelInput {
	id?: string;
	name: string;
	visibility?: ChannelVisibility;
}

export interface ChannelMemberInput {
	userId: string;
}


const HOT_TAIL = 500;
function sanitizeManagerValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return neutralizeDelimiters(redact(value));
	if (Array.isArray(value)) return value.map((item) => sanitizeManagerValue(item, seen));
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = sanitizeManagerValue(item, seen);
	return out;
}



function normalizeChannelId(name: string): string {
	return name.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function actorUserId(actor: Actor): string | undefined {
	return actor.id.startsWith("db:") ? actor.id.slice(3) : undefined;
}

function channelSort(a: Channel, b: Channel): number {
	return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function entrySort(a: ChannelEntry, b: ChannelEntry): number {
	return a.seq - b.seq || a.ts - b.ts || a.id.localeCompare(b.id);
}

export class ChannelStore {
	private readonly hotTail: ChannelEntry[] = [];
	private defaultReady?: Promise<void>;

	constructor(
		_stateDir: string,
		private readonly store: Store,
		_log: (msg: string) => void = () => {},
		private readonly now: () => number = Date.now,
	) {}

	async ensureDefaultChannel(): Promise<void> {
		this.defaultReady ??= (async () => {
			if (!(await this.store.getChannel(DEFAULT_CHANNEL_ID))) {
				await this.store.putChannel({ id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_NAME, createdAt: this.now(), kind: "default", visibility: "org-public" });
			}
		})();
		await this.defaultReady;
	}

	async listChannels(actor?: Actor): Promise<Channel[]> {
		await this.ensureDefaultChannel();
		const channels = (await this.store.listChannels()).sort(channelSort);
		if (!actor) return channels;
		const allowed: Channel[] = [];
		for (const channel of channels) {
			if (await this.canReadChannel(channel.id, actor)) allowed.push(channel);
		}
		return allowed;
	}

	async entries(channelId = DEFAULT_CHANNEL_ID, since = 0, actor?: Actor): Promise<ChannelEntry[]> {
		await this.ensureDefaultChannel();
		if (actor && !(await this.canReadChannel(channelId, actor))) throw new Error("channel forbidden");
		return (await this.store.listChannelEntries(channelId, since)).sort(entrySort);
	}

	async search(q: string, limit = 50, actor?: Actor): Promise<ChannelSearchResult[]> {
		await this.ensureDefaultChannel();
		const allowed = actor ? new Set((await this.listChannels(actor)).map((channel) => channel.id)) : undefined;
		const nativeSearch = this.store.searchChannelEntries?.bind(this.store);
		if (nativeSearch) return (await nativeSearch(q, actor ? Math.max(limit * 10, 500) : limit)).filter((result) => !allowed || allowed.has(result.entry.channelId)).slice(0, limit);
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const results = (await this.entries(DEFAULT_CHANNEL_ID, 0))
			.filter((entry) => (!allowed || allowed.has(entry.channelId)) && entry.text.toLowerCase().includes(needle))
			.map((entry) => ({ entry, snippet: entry.text }))
			.sort((a, b) => b.entry.ts - a.entry.ts || b.entry.seq - a.entry.seq);
		return results.slice(0, limit);
	}


	async appendClient(channelId: string, actor: Actor, input: ClientChannelPost): Promise<ChannelEntry> {
		await this.ensureDefaultChannel();
		if (!(await this.canReadChannel(channelId, actor))) throw new Error("channel forbidden");
		const { text, replyToId } = input;
		return this.appendManager(channelId, { text, replyToId, authorActor: actor.id, authorDisplayName: actor.displayName, authorOrigin: actor.origin, kind: "user", format: "markdown" });
	}

	async createChannel(actor: Actor, input: CreateChannelInput): Promise<Channel> {
		await this.ensureDefaultChannel();
		const creatorUserId = actorUserId(actor);
		const visibility = input.visibility ?? "org-public";
		if (visibility === "private" && !creatorUserId) throw new Error("private channels require signed-in user identity");
		const id = input.id?.trim() || normalizeChannelId(input.name);
		if (!id) throw new Error("channel id required");
		if (await this.store.getChannel(id)) throw new Error("channel already exists");
		const channel: Channel = { id, name: input.name.trim().startsWith("#") ? input.name.trim() : `#${input.name.trim()}`, createdAt: this.now(), kind: "user", visibility, ...(creatorUserId ? { creatorUserId } : {}) };
		await this.store.putChannel(channel);
		const stored = await this.store.getChannel(id);
		if (!stored || stored.visibility !== channel.visibility || stored.creatorUserId !== channel.creatorUserId || stored.name !== channel.name) throw new Error("channel already exists");
		if (creatorUserId) await this.store.putChannelMembership({ channelId: id, userId: creatorUserId, active: true, updatedBy: creatorUserId, updatedAt: this.now() });
		return stored;
	}

	async setMember(channelId: string, actor: Actor, input: ChannelMemberInput, active: boolean): Promise<ChannelMembership> {
		const channel = await this.store.getChannel(channelId);
		if (!channel) throw new Error("channel not found");
		const actorUserIdValue = actorUserId(actor);
		if (!actorUserIdValue || channel.creatorUserId !== actorUserIdValue) throw new Error("channel forbidden");
		const userId = input.userId.replace(/^db:/, "").trim();
		if (!userId) throw new Error("userId required");
		const row = { channelId, userId, active, updatedBy: actorUserIdValue, updatedAt: this.now() };
		await this.store.putChannelMembership(row);
		return row;
	}

	async memberUserIds(channelId: string): Promise<string[] | undefined> {
		const channel = await this.store.getChannel(channelId);
		if (!channel || channel.visibility !== "private") return undefined;
		return (await this.store.listChannelMemberships(channelId)).filter((row) => row.active).map((row) => row.userId);
	}


	async canReadChannel(channelId: string, actor: Actor): Promise<boolean> {
		const channel = await this.store.getChannel(channelId);
		if (!channel) return false;
		if (channel.visibility !== "private") return true;
		const userId = actorUserId(actor);
		if (!userId) return false;
		return (await this.store.listChannelMemberships(channelId)).some((row) => row.userId === userId && row.active);
	}

	async appendManager(channelId: string, input: ManagerChannelPost): Promise<ChannelEntry> {
		await this.ensureDefaultChannel();
		const channel = await this.store.getChannel(channelId);
		if (!channel) throw new Error("channel not found");
		const seq = (await this.store.nextChannelSeq(channelId)) + 1;
		const entry: ChannelEntry = {
			id: randomUUID(),
			seq,
			channelId,
			authorActor: input.authorActor,
			authorDisplayName: input.authorDisplayName,
			authorOrigin: input.authorOrigin,
			replyToId: input.replyToId,
			kind: input.kind ?? "system",
			text: input.event ? neutralizeDelimiters(redact(input.text)) : redact(input.text),
			ts: this.now(),
			status: "ok",
			format: input.format ?? "markdown",
			...(input.event ? { event: { kind: input.event.kind, issuer: EVENT_ISSUER_MANAGER, payload: sanitizeManagerValue(input.event.payload) } } : {}),
		};
		await this.store.appendChannelEntry(entry);
		this.hotTail.push(entry);
		if (this.hotTail.length > HOT_TAIL) this.hotTail.shift();
		return entry;
	}

	async stop(): Promise<void> {}
}
