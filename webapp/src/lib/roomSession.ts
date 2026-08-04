import type { ChannelEntry, PresenceSnapshot } from './dto';
import { reduceChannelEntries } from './hub';

/**
 * Room-session cursor (plans/deepen-modules/10, slice 1) — the seq-cursor discipline that was
 * previously inlined across four HubShell effects, where the stale-running-claims incident
 * class (PR #216) actually lived. This module is deliberately FRAMEWORK-FREE: it holds the
 * session's cursor state (active channel, last applied seq, which entry ids have already been
 * counted as unread) and returns DECISIONS AS DATA — the caller's effects apply them to React
 * state. That inversion is what makes the wiring testable: every seq-regression, cross-channel
 * leak and double-count case becomes a table-driven unit test with no DOM, no timers, no
 * transport.
 *
 * Invariants owned here (each one a previously-inlined bug surface):
 *  - the seq cursor is MONOTONIC per channel session: an entry at or below `lastSeq` is never
 *    re-applied (WS replay / poll overlap / reconnect races collapse to no-ops);
 *  - live entries for OTHER channels never touch the active timeline — they surface only as
 *    unread candidates, and each entry id is counted at most ONCE across its lifetime (the
 *    `counted` set survives channel switches, exactly like the old module-level ref);
 *  - a channel switch RESETS the cursor before the initial load, so a stale seq from the
 *    previous channel can never suppress the new channel's entries.
 */

export interface LiveIngest {
	/** Entries for the ACTIVE channel, strictly newer than the cursor — apply to the timeline. */
	incoming: ChannelEntry[];
	/** Live entries for OTHER channels seen for the first time — candidates for unread badges.
	 *  The caller compares each against its channel's OWN lastReadSeq at apply time (that state
	 *  lives with the channel list, not the session cursor). */
	unreadCandidates: ChannelEntry[];
	/** The cursor after `incoming` is applied; equal to the previous cursor when none. Callers
	 *  mark the channel read AT this seq exactly when `incoming` is non-empty. */
	lastSeq: number;
}

export interface ResyncIngest {
	incoming: ChannelEntry[];
	lastSeq: number;
}

const latestSeq = (entries: readonly ChannelEntry[]): number => entries.reduce((max, e) => Math.max(max, e.seq), 0);

export class RoomSessionCursor {
	private channelId: string;
	private lastSeqValue = 0;
	private readonly counted = new Set<string>();

	constructor(channelId: string) {
		this.channelId = channelId;
	}

	get lastSeq(): number {
		return this.lastSeqValue;
	}

	get activeChannelId(): string {
		return this.channelId;
	}

	/** Switch the session to a channel: the cursor resets to 0 so the initial load owns the
	 *  timeline. The unread `counted` set deliberately survives (an entry badge-counted while
	 *  this channel was backgrounded must not count again when we switch back and forth). */
	beginChannel(channelId: string): void {
		if (channelId === this.channelId) return; // idempotent — called from two effects per render
		this.channelId = channelId;
		this.lastSeqValue = 0;
	}

	/** The initial `since=0` load completed. ADVANCES only (codex MEDIUM): a live entry that
	 *  raced ahead of the snapshot response must not be regressed past — the cursor is monotonic
	 *  within a channel session, exactly as the module doc claims. */
	loadComplete(entries: readonly ChannelEntry[]): number {
		this.lastSeqValue = Math.max(this.lastSeqValue, latestSeq(entries));
		return this.lastSeqValue;
	}

	/** One batch of LIVE (WS-pushed) entries, any channel mixed together. */
	ingestLive(entries: readonly ChannelEntry[]): LiveIngest {
		const unreadCandidates: ChannelEntry[] = [];
		for (const entry of entries) {
			if (entry.channelId === this.channelId || this.counted.has(entry.id)) continue;
			this.counted.add(entry.id);
			unreadCandidates.push(entry);
		}
		const incoming = entries.filter((e) => e.channelId === this.channelId && e.seq > this.lastSeqValue);
		if (incoming.length) this.lastSeqValue = Math.max(this.lastSeqValue, latestSeq(incoming));
		return { incoming, unreadCandidates, lastSeq: this.lastSeqValue };
	}

	/** The session's own just-posted entry landed (the send path applies it optimistically-
	 *  confirmed): advance the cursor so the next poll doesn't re-fetch it. Never regresses. */
	advanceTo(seq: number): void {
		this.lastSeqValue = Math.max(this.lastSeqValue, seq);
	}

	/** One resync batch (poll or reconnect `since=lastSeq` fetch). The batch is TAGGED with the
	 *  channel the fetch was issued for: an in-flight fetch from BEFORE a channel switch lands
	 *  here with the old tag and is rejected outright — the stale-closure interleaving where an
	 *  old channel's response could otherwise apply to the new channel's timeline AND advance
	 *  the shared cursor past the new channel's real seqs (the nastiest member of the PR #216
	 *  class; the old inline refs had exactly this hole). The seq gate still applies to accepted
	 *  batches (a slow same-channel response racing a newer live batch must not re-apply). */
	ingestResync(channelId: string, entries: readonly ChannelEntry[]): ResyncIngest {
		if (channelId !== this.channelId) return { incoming: [], lastSeq: this.lastSeqValue };
		const incoming = entries.filter((e) => e.seq > this.lastSeqValue);
		if (incoming.length) this.lastSeqValue = Math.max(this.lastSeqValue, latestSeq(incoming));
		return { incoming, lastSeq: this.lastSeqValue };
	}
}

// ── Slice 2: the transport port + session orchestrator ─────────────────────────────────────────

/** Everything the session needs from the network — the PORT. Production adapts apiJson; tests
 *  script it with controllable promises, which is what finally makes the load/poll/reconnect
 *  INTERLEAVINGS unit-testable (slow snapshot racing a switch, poll racing live, etc). */
export interface RoomTransport {
	fetchEntries(channelId: string, since: number): Promise<ChannelEntry[]>;
	fetchPresence(): Promise<PresenceSnapshot>;
}

/** Where decisions land — thin adapters over the caller's state setters. Resolved through a
 *  ref-style getter at call time so React callers can pass their latest closures without
 *  recreating the session (the session, like the cursor it owns, outlives renders). */
export interface RoomSessionSinks {
	applyEntries(apply: (prev: ChannelEntry[]) => ChannelEntry[]): void;
	applyPresence(presence: PresenceSnapshot): void;
	/** Mark CHANNELID read at seq — parameterized (grok HIGH on this slice): the session always
	 *  names the channel the operation was issued for, so a completion landing in the
	 *  render→effects window can never mark the newly-routed channel with an old channel's seq
	 *  (the latest-closure sink pattern made the old closure-captured channel unsafe). */
	markRead(channelId: string, seq: number): void;
	loadStarted(): void;
	loadFinished(error?: string): void;
}

/**
 * The session orchestrator: owns one RoomSessionCursor plus the transport calls the four
 * HubShell effects used to make inline. An EPOCH stamp replaces the old `alive` boolean —
 * every openChannel bumps it, and any async continuation from a previous epoch (a slow
 * snapshot response, a poll that started before the switch) discards itself. Combined with
 * the cursor's own channel tag, the two stale-response classes are closed at different
 * layers: the epoch kills stale OPENS, the tag kills stale RESYNCS.
 */
export class RoomSession {
	private readonly cursor: RoomSessionCursor;
	private epoch = 0;

	constructor(
		private readonly transport: RoomTransport,
		private readonly sinks: () => RoomSessionSinks,
		initialChannelId: string,
	) {
		this.cursor = new RoomSessionCursor(initialChannelId);
	}

	get lastSeq(): number {
		return this.cursor.lastSeq;
	}

	get activeChannelId(): string {
		return this.cursor.activeChannelId;
	}

	/** Live WS entries — synchronous, cursor-gated. Returns the unread candidates so the caller
	 *  can update its channel-badge state (which lives with the channel list, not here). */
	ingestLive(channelId: string, entries: readonly ChannelEntry[]): ChannelEntry[] {
		this.cursor.beginChannel(channelId); // idempotent switch guard (codex HIGH, slice 1)
		const { incoming, unreadCandidates, lastSeq } = this.cursor.ingestLive(entries);
		if (incoming.length) {
			this.sinks().applyEntries((prev) => reduceChannelEntries(prev, [...incoming], channelId));
			this.sinks().markRead(channelId, lastSeq);
		}
		return unreadCandidates;
	}

	/** The just-posted entry from the send path. */
	advanceTo(seq: number): void {
		this.cursor.advanceTo(seq);
	}

	/** Channel open: initial snapshot + presence, epoch-guarded, merge-not-replace (codex
	 *  MEDIUM, slice 1: a live entry that raced ahead of the snapshot must not flicker out). */
	async openChannel(channelId: string): Promise<void> {
		this.cursor.beginChannel(channelId);
		const myEpoch = ++this.epoch;
		this.sinks().loadStarted();
		try {
			const [entries, presence] = await Promise.all([
				this.transport.fetchEntries(channelId, 0),
				// Parity with the old inline load (grok MEDIUM): a failed presence fetch applies the
				// EMPTY snapshot rather than stranding the previous channel's users on screen.
				this.transport.fetchPresence().catch(() => ({ users: [] }) as PresenceSnapshot),
			]);
			if (myEpoch !== this.epoch) return; // a newer open superseded this one
			this.sinks().applyEntries((prev) => reduceChannelEntries(prev, entries, channelId));
			this.sinks().markRead(channelId, this.cursor.loadComplete(entries));
			this.sinks().applyPresence(presence);
			this.sinks().loadFinished();
		} catch (err) {
			if (myEpoch !== this.epoch) return;
			this.sinks().loadFinished(err instanceof Error ? err.message : 'Could not load channel');
		}
	}

	/** Poll/reconnect resync for the CURRENT channel — the fetch is tagged with the channel it
	 *  was issued for, so a response landing after a switch is rejected by the cursor. */
	async resync(): Promise<void> {
		const channelId = this.cursor.activeChannelId;
		const entries = await this.transport.fetchEntries(channelId, this.cursor.lastSeq);
		const { incoming, lastSeq } = this.cursor.ingestResync(channelId, entries);
		if (!incoming.length) return;
		this.sinks().applyEntries((prev) => reduceChannelEntries(prev, incoming, channelId));
		this.sinks().markRead(channelId, lastSeq);
	}

	/** Invalidate every in-flight openChannel (grok LOW: the old `alive` flag also covered
	 *  unmount; callers put this in their teardown so a straggler can't sink-apply after it). */
	cancelPending(): void {
		this.epoch++;
	}

	async refreshPresence(): Promise<void> {
		const presence = await this.transport.fetchPresence();
		this.sinks().applyPresence(presence);
	}
}
