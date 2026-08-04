import type { ChannelEntry } from './dto';

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
