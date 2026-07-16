/**
 * GET /api/fog surprise wiring (comprehension concern 08) — the wiring, not a reimplementation:
 * `computeFog`'s `surpriseCounts` boost and `AttentionStore.surpriseCountsFor` are unit-tested
 * elsewhere (comprehension-fog.test.ts, attention.test.ts); this proves the actual HTTP route reads
 * a recorded `surprise` tap back out of the durable count map and feeds it through, exactly like
 * symptom-route.test.ts proves GET /api/symptoms actually calls `listSymptoms`+`rankKbDocs`.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { appendReceipt } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { RunReceipt } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function authed(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { "content-type": "application/json", authorization: "Bearer viewer-token-xxxxxxxx", ...init.headers } };
}

async function fixture(repo = "/srv/app") {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "fog-route-"));
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
	// The route derives repo scope from the actor-visible set (same discipline as GET /api/symptoms) —
	// seed a persisted feature for the repo so an actor with no live agents still sees it.
	const featureStore = (manager as unknown as { featureStore: Map<string, unknown> }).featureStore;
	featureStore.set("f0", { id: "f0", repo, title: "feat-0", archived: false, decisions: [] });
	const server = new SquadServer(manager, { port: 0, token: "admin-token-xxxxxxxx", roleTokens: { viewer: "viewer-token-xxxxxxxx" } });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
	});
	return { state, manager, server, url };
}

function receipt(over: Partial<RunReceipt> & Pick<RunReceipt, "repo" | "filesTouched">): RunReceipt {
	return {
		agentId: "agent-1",
		name: "agent-1",
		runId: "run-1",
		startedAt: 0,
		status: "idle",
		toolCalls: 1,
		toolTally: {},
		...over,
	};
}

test("GET /api/fog reflects a recorded surprise tap as a debt boost", async () => {
	const { state, url } = await fixture();
	await appendReceipt(state, receipt({ repo: "/srv/app", filesTouched: ["a.ts"], endedAt: 100 }));

	const before = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	const beforeEntry = before.entries.find((e: { file: string }) => e.file === "a.ts");
	expect(beforeEntry).toBeDefined();
	expect(beforeEntry.changesSinceSeen).toBe(1);
	const plainDebt = beforeEntry.debt;

	const postRes = await fetch(`${url}/api/attention`, authed({ method: "POST", body: JSON.stringify({ kind: "surprise", repo: "/srv/app", file: "a.ts" }) }));
	expect(postRes.status).toBe(200);
	expect((await postRes.json()).ok).toBe(true);

	// A surprise tap is ITSELF a genuine view (attention.ts's `SEEN_UPDATING_KINDS`), so it also
	// resets `changesSinceSeen` to 0 via the seen-map merge — but the debt formula's separate
	// surprise-boost term still raises debt on top of that reset, exactly per DESIGN.md: tapping
	// "surprised me" does not fully forgive the file, because the operator's mental model of it is
	// flagged as weak regardless of having just looked at it.
	const after = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	const afterEntry = after.entries.find((e: { file: string }) => e.file === "a.ts");
	expect(afterEntry.changesSinceSeen).toBe(0); // the tap itself counts as a view
	expect(afterEntry.debt).toBeGreaterThan(plainDebt); // but the boost still raises debt above the pre-tap baseline
	expect(afterEntry.debt).toBeGreaterThan(0);
});

test("GET /api/fog is unaffected by a surprise tap recorded against a DIFFERENT repo", async () => {
	const { state, url } = await fixture("/srv/app");
	await appendReceipt(state, receipt({ repo: "/srv/app", filesTouched: ["a.ts"], endedAt: 100 }));

	const before = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	const plainDebt = before.entries.find((e: { file: string }) => e.file === "a.ts").debt;

	// A surprise tap against an unrelated/foreign repo is rejected (unknown repo, fail-closed) — the
	// visible repo set here only contains /srv/app, so this never reaches the surprise-count map.
	const rejected = await fetch(`${url}/api/attention`, authed({ method: "POST", body: JSON.stringify({ kind: "surprise", repo: "/other-tenant", file: "a.ts" }) }));
	expect(rejected.status).toBe(400);

	const after = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	expect(after.entries.find((e: { file: string }) => e.file === "a.ts").debt).toBe(plainDebt);
});
