import { randomUUID } from "node:crypto";
import type { Store } from "./dal/store.ts";
import { neutralizeDelimiters } from "./digest.ts";
import { redact } from "./redact.ts";
import { EVENT_ISSUER_MANAGER } from "./transcript-event-kinds.ts";
import type { Actor, TranscriptEntry } from "./types.ts";

export const DEFAULT_CHANNEL_ID = "fleet";
export const DEFAULT_CHANNEL_NAME = "#fleet";

type ClientChannelEvent = never;

export interface Channel {
	id: string;
	name: string;
	createdAt: number;
	kind: "default" | "user";
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
				await this.store.putChannel({ id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_NAME, createdAt: this.now(), kind: "default" });
			}
		})();
		await this.defaultReady;
	}

	async listChannels(): Promise<Channel[]> {
		await this.ensureDefaultChannel();
		return (await this.store.listChannels()).sort(channelSort);
	}

	async entries(channelId = DEFAULT_CHANNEL_ID, since = 0): Promise<ChannelEntry[]> {
		await this.ensureDefaultChannel();
		return (await this.store.listChannelEntries(channelId, since)).sort(entrySort);
	}

	async search(q: string, limit = 50): Promise<ChannelSearchResult[]> {
		await this.ensureDefaultChannel();
		const nativeSearch = this.store.searchChannelEntries?.bind(this.store);
		if (nativeSearch) return nativeSearch(q, limit);
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const results = (await this.entries(DEFAULT_CHANNEL_ID, 0))
			.filter((entry) => entry.text.toLowerCase().includes(needle))
			.map((entry) => ({ entry, snippet: entry.text }))
			.sort((a, b) => b.entry.ts - a.entry.ts || b.entry.seq - a.entry.seq);
		return results.slice(0, limit);
	}


	async appendClient(channelId: string, actor: Actor, input: ClientChannelPost): Promise<ChannelEntry> {
		const { text, replyToId } = input;
		return this.appendManager(channelId, { text, replyToId, authorActor: actor.id, authorDisplayName: actor.displayName, authorOrigin: actor.origin, kind: "user", format: "markdown" });
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
