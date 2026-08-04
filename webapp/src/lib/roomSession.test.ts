import { describe, expect, test } from 'bun:test';
import type { ChannelEntry } from './dto';
import { RoomSessionCursor } from './roomSession';

/**
 * Concern 10 slice 1 — the seq-cursor discipline, finally table-testable. Every case below is a
 * member of the stale-running-claims incident class (PR #216) that previously lived untested
 * inside HubShell effects.
 */

const entry = (id: string, channelId: string, seq: number): ChannelEntry =>
	({ id, channelId, seq, kind: 'user', text: id, ts: seq }) as ChannelEntry;

describe('live ingest', () => {
	test('applies only active-channel entries strictly newer than the cursor, and advances it', () => {
		const s = new RoomSessionCursor('a');
		s.loadComplete([entry('e1', 'a', 5)]);
		const out = s.ingestLive([entry('e2', 'a', 6), entry('e-old', 'a', 5), entry('e3', 'b', 7)]);
		expect(out.incoming.map((e) => e.id)).toEqual(['e2']);
		expect(out.lastSeq).toBe(6);
		expect(s.lastSeq).toBe(6);
	});

	test('WS replay of an already-applied batch is a no-op (the stale-claims core case)', () => {
		const s = new RoomSessionCursor('a');
		s.loadComplete([entry('e1', 'a', 5)]);
		s.ingestLive([entry('e2', 'a', 6)]);
		const replay = s.ingestLive([entry('e2', 'a', 6)]);
		expect(replay.incoming).toEqual([]);
		expect(replay.lastSeq).toBe(6);
	});

	test('other-channel entries become unread candidates exactly once, ever', () => {
		const s = new RoomSessionCursor('a');
		const first = s.ingestLive([entry('x1', 'b', 3)]);
		expect(first.unreadCandidates.map((e) => e.id)).toEqual(['x1']);
		const again = s.ingestLive([entry('x1', 'b', 3)]);
		expect(again.unreadCandidates).toEqual([]);
		// …including after switching to b and back — the counted set survives channel changes.
		s.beginChannel('b');
		s.beginChannel('a');
		expect(s.ingestLive([entry('x1', 'b', 3)]).unreadCandidates).toEqual([]);
	});

	test('active-channel entries are never unread candidates', () => {
		const s = new RoomSessionCursor('a');
		expect(s.ingestLive([entry('e1', 'a', 1)]).unreadCandidates).toEqual([]);
	});
});

describe('channel switch', () => {
	test('resets the cursor so the old channel seq cannot suppress the new channel (hardening over the inline refs)', () => {
		const s = new RoomSessionCursor('a');
		s.loadComplete([entry('e1', 'a', 100)]);
		s.beginChannel('b');
		expect(s.lastSeq).toBe(0);
		const out = s.ingestLive([entry('b1', 'b', 3)]);
		expect(out.incoming.map((e) => e.id)).toEqual(['b1']);
	});
});

describe('resync ingest', () => {
	test('gates on the cursor even when the server response overlaps a newer live batch', () => {
		const s = new RoomSessionCursor('a');
		s.loadComplete([entry('e1', 'a', 5)]);
		// A slow since=5 response arrives AFTER live already applied seq 6/7.
		s.ingestLive([entry('e2', 'a', 6), entry('e3', 'a', 7)]);
		const slow = s.ingestResync('a', [entry('e2', 'a', 6), entry('e3', 'a', 7)]);
		expect(slow.incoming).toEqual([]);
		expect(slow.lastSeq).toBe(7);
	});

	test('applies genuinely new resync entries and advances', () => {
		const s = new RoomSessionCursor('a');
		s.loadComplete([entry('e1', 'a', 5)]);
		const out = s.ingestResync('a', [entry('e2', 'a', 6)]);
		expect(out.incoming.map((e) => e.id)).toEqual(['e2']);
		expect(out.lastSeq).toBe(6);
	});

	test('an in-flight resync from BEFORE a channel switch is rejected whole (stale-closure interleaving)', () => {
		const s = new RoomSessionCursor('a');
		s.loadComplete([entry('e1', 'a', 5)]);
		s.beginChannel('b');
		s.loadComplete([entry('b1', 'b', 2)]);
		// The old channel's slow response lands now — high seqs that would corrupt b's cursor.
		const stale = s.ingestResync('a', [entry('e9', 'a', 900)]);
		expect(stale.incoming).toEqual([]);
		expect(s.lastSeq).toBe(2);
	});
});

describe('send path', () => {
	test('advanceTo never regresses the cursor', () => {
		const s = new RoomSessionCursor('a');
		s.loadComplete([entry('e1', 'a', 9)]);
		s.advanceTo(4);
		expect(s.lastSeq).toBe(9);
		s.advanceTo(11);
		expect(s.lastSeq).toBe(11);
	});
});

// ── Slice 2: RoomSession over a scripted transport — the interleavings themselves ────────────

import { RoomSession, type RoomSessionSinks, type RoomTransport } from './roomSession';
import type { PresenceSnapshot } from './dto';

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function harness() {
	const pending: Array<{ channelId: string; since: number; d: ReturnType<typeof deferred<ChannelEntry[]>> }> = [];
	const transport: RoomTransport = {
		fetchEntries(channelId, since) {
			const d = deferred<ChannelEntry[]>();
			pending.push({ channelId, since, d });
			return d.promise;
		},
		fetchPresence: () => Promise.resolve({ users: [] } as unknown as PresenceSnapshot),
	};
	let entries: ChannelEntry[] = [];
	const markReads: Array<[string, number]> = [];
	const loads: string[] = [];
	const sinks: RoomSessionSinks = {
		applyEntries: (apply) => { entries = apply(entries); },
		applyPresence: () => {},
		markRead: (channelId, seq) => markReads.push([channelId, seq]),
		loadStarted: () => loads.push('start'),
		loadFinished: (err) => loads.push(err ? `error:${err}` : 'done'),
	};
	const session = new RoomSession(transport, () => sinks, 'a');
	return { session, pending, view: () => entries.map((e) => e.id), markReads, loads };
}

test('a slow snapshot from the OLD channel is discarded whole by the epoch guard', async () => {
	const h = harness();
	const openA = h.session.openChannel('a');
	const openB = h.session.openChannel('b'); // supersedes before A's snapshot resolves
	h.pending[1]!.d.resolve([entry('b1', 'b', 1)]);
	await openB;
	h.pending[0]!.d.resolve([entry('a1', 'a', 50)]); // A's slow snapshot lands last
	await openA;
	expect(h.view()).toEqual(['b1']); // A's snapshot never touched the timeline
	expect(h.session.lastSeq).toBe(1); // and never corrupted the cursor
});

test('a live entry racing ahead of the snapshot survives the merge and the cursor stays monotonic', async () => {
	const h = harness();
	const open = h.session.openChannel('a');
	h.session.ingestLive('a', [entry('a6', 'a', 6)]); // live lands before the snapshot response
	h.pending[0]!.d.resolve([entry('a1', 'a', 1), entry('a5', 'a', 5)]);
	await open;
	expect(h.view()).toEqual(expect.arrayContaining(['a6', 'a1', 'a5']));
	expect(h.session.lastSeq).toBe(6); // Math.max, not the snapshot head
});

test('a poll response landing after a channel switch is rejected by the tag', async () => {
	const h = harness();
	const openA = h.session.openChannel('a');
	h.pending[0]!.d.resolve([entry('a1', 'a', 5)]);
	await openA;
	const poll = h.session.resync(); // issued for channel a (since=5)
	const openB = h.session.openChannel('b');
	h.pending[2]!.d.resolve([entry('b1', 'b', 2)]);
	await openB;
	h.pending[1]!.d.resolve([entry('a9', 'a', 900)]); // the stale poll lands now
	await poll;
	expect(h.view()).toEqual(['b1']);
	expect(h.session.lastSeq).toBe(2);
});

test('openChannel failure reports the error without poisoning a superseding open', async () => {
	const h = harness();
	const openA = h.session.openChannel('a');
	const openB = h.session.openChannel('b');
	h.pending[0]!.d.reject(new Error('boom'));
	await openA;
	expect(h.loads.filter((l) => l.startsWith('error'))).toEqual([]); // stale failure discarded
	h.pending[1]!.d.resolve([entry('b1', 'b', 1)]);
	await openB;
	expect(h.loads.at(-1)).toBe('done');
});
