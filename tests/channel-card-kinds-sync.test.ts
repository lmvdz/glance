/**
 * Cross-build sync gate — the daemon's TranscriptEventKind constants (src/transcript-event-kinds.ts)
 * and the webapp's card registry (webapp/src/lib/channelTimeline.ts) are two independently
 * maintained files with no shared import (daemon and webapp are separate builds). This test reads
 * both REAL source files as text and asserts they haven't drifted:
 *   - every daemon-emitted kind has a rendering entry in the webapp's POINTER_EVENT_KINDS map
 *   - no daemon-emitted kind collides with a webapp `local:`-namespaced client-only kind
 *
 * Deliberately no hand-mirrored fixture list: a fixture re-creates exactly the comment-discipline
 * failure that produced the return-emit / design-revised drift this test exists to catch (see
 * plans/voice-orchestrated-room-integration/06-card-registry-hardening.md). Cross-tree source
 * reads follow the precedent in tests/webapp.test.ts:24 (SquadServer/webapp dir import).
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

async function readDaemonEventKinds(): Promise<string[]> {
	const src = await fs.readFile(path.join(ROOT, "src", "transcript-event-kinds.ts"), "utf8");
	const kinds: string[] = [];
	// export const TRANSCRIPT_EVENT_X = "kind-name";
	for (const m of src.matchAll(/export const TRANSCRIPT_EVENT_[A-Z0-9_]+\s*=\s*"([^"]+)";/g)) {
		kinds.push(m[1]!);
	}
	return kinds;
}

async function readClientPointerKinds(): Promise<string[]> {
	const src = await fs.readFile(path.join(ROOT, "webapp", "src", "lib", "channelTimeline.ts"), "utf8");
	const match = src.match(/const POINTER_EVENT_KINDS = \{([\s\S]*?)\} satisfies/);
	if (!match) throw new Error("POINTER_EVENT_KINDS block not found in webapp/src/lib/channelTimeline.ts");
	const body = match[1]!;
	return [...body.matchAll(/'([^']+)':\s*true/g)].map((m) => m[1]!);
}

async function readClientLocalKinds(): Promise<string[]> {
	const src = await fs.readFile(path.join(ROOT, "webapp", "src", "lib", "channelTimeline.ts"), "utf8");
	const match = src.match(/const LOCAL_CARD_KINDS = \{([\s\S]*?)\} satisfies/);
	if (!match) throw new Error("LOCAL_CARD_KINDS block not found in webapp/src/lib/channelTimeline.ts");
	const body = match[1]!;
	return [...body.matchAll(/'([^']+)':\s*true/g)].map((m) => m[1]!);
}

test("every daemon-emitted transcript event kind is a webapp pointer card kind", async () => {
	const daemonKinds = await readDaemonEventKinds();
	const clientPointerKinds = new Set(await readClientPointerKinds());
	const missing = daemonKinds.filter((kind) => !clientPointerKinds.has(kind));
	expect(missing).toEqual([]);
});

test("no daemon-emitted kind collides with a webapp local: client-minted kind", async () => {
	const daemonKinds = new Set(await readDaemonEventKinds());
	const localKinds = await readClientLocalKinds();
	for (const local of localKinds) {
		expect(local.startsWith("local:")).toBe(true);
		expect(daemonKinds.has(local)).toBe(false);
		// The unprefixed form must also never collide, since local kinds are reserved names too.
		expect(daemonKinds.has(local.slice("local:".length))).toBe(false);
	}
});
