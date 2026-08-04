/**
 * Cross-build sync gate, v2 (concern 08 slice 1) — the daemon's TranscriptEventKind list and
 * the webapp's card registry used to be two independently maintained files that this test held
 * together by TEXT-SCRAPING both sources. The webapp now derives its kind union and its
 * exhaustive POINTER_EVENT_KINDS map from a TYPE-ONLY import of src/transcript-event-kinds.ts,
 * so "every daemon kind has a rendering entry" is a COMPILE-TIME guarantee (tsc fails on a new
 * kind until the registry entry exists) and no longer needs a test at all.
 *
 * What remains here is exactly the invariant tsc cannot see — the `local:` namespace rule:
 * client-minted kinds must carry the prefix, and neither their prefixed nor unprefixed forms
 * may collide with a daemon-emitted kind (a collision would let a daemon event masquerade as
 * optimistic client UI, or vice versa). Checked via REAL runtime imports of both modules —
 * no text scraping, no fixture list (a fixture re-creates the drift class this file exists to
 * prevent; see plans/voice-orchestrated-room-integration/06-card-registry-hardening.md).
 * Cross-tree import precedent: tests/webapp.test.ts:24.
 */

import { expect, test } from "bun:test";
import { TRANSCRIPT_EVENT_KINDS } from "../src/transcript-event-kinds.ts";
import { LOCAL_CARD_KINDS } from "../webapp/src/lib/channelTimeline.ts";

test("no daemon-emitted kind collides with a webapp local: client-minted kind (prefixed or bare)", () => {
	const daemonKinds = new Set<string>(TRANSCRIPT_EVENT_KINDS);
	const localKinds = Object.keys(LOCAL_CARD_KINDS);
	expect(localKinds.length).toBeGreaterThan(0);
	for (const local of localKinds) {
		expect(local.startsWith("local:")).toBe(true);
		expect(daemonKinds.has(local)).toBe(false);
		// The unprefixed form must also never collide, since local kinds are reserved names too.
		expect(daemonKinds.has(local.slice("local:".length))).toBe(false);
	}
});

test("the shared list is duplicate-free and non-empty (the one runtime property of the contract)", () => {
	expect(TRANSCRIPT_EVENT_KINDS.length).toBeGreaterThan(0);
	expect(new Set(TRANSCRIPT_EVENT_KINDS).size).toBe(TRANSCRIPT_EVENT_KINDS.length);
});

test("every exported TRANSCRIPT_EVENT_* constant is a member of the canonical list (codex M on the rewrite)", async () => {
	// tsc can't see this: a constant added to the module but forgotten from TRANSCRIPT_EVENT_KINDS
	// compiles everywhere, then isTranscriptEventKind rejects it at runtime and the room projection
	// silently skips the event — the exact class the old text-scrape accidentally covered.
	const mod = (await import("../src/transcript-event-kinds.ts")) as Record<string, unknown>;
	const listed = new Set<string>(TRANSCRIPT_EVENT_KINDS);
	const constants = Object.entries(mod)
		.filter(([name, value]) => name.startsWith("TRANSCRIPT_EVENT_") && typeof value === "string")
		.map(([name, value]) => ({ name, value: value as string }));
	expect(constants.length).toBeGreaterThan(0);
	const missing = constants.filter((c) => !listed.has(c.value)).map((c) => `${c.name}="${c.value}"`);
	expect(missing).toEqual([]);
});
