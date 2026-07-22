import { randomUUID } from "node:crypto";
import type { Store } from "./dal/store.ts";
import { redact } from "./redact.ts";
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
	replyToId?: string;
	/** Manager-authored card payload. Client appends must never set this. */
	event?: { kind: string; payload: unknown };
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
	replyToId?: string;
	event?: { kind: string; payload: unknown };
	kind?: ChannelEntry["kind"];
	format?: ChannelEntry["format"];
}

const HOT_TAIL = 500;


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

	async appendClient(channelId: string, actor: Actor, input: ClientChannelPost): Promise<ChannelEntry> {
		const { text, replyToId } = input;
		return this.appendManager(channelId, { text, replyToId, authorActor: actor.id, kind: "user", format: "markdown" });
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
			replyToId: input.replyToId,
			kind: input.kind ?? "system",
			text: redact(input.text),
			ts: this.now(),
			status: "ok",
			format: input.format ?? "markdown",
			...(input.event ? { event: input.event } : {}),
		};
		await this.store.appendChannelEntry(entry);
		this.hotTail.push(entry);
		if (this.hotTail.length > HOT_TAIL) this.hotTail.shift();
		return entry;
	}

	async stop(): Promise<void> {}
}
