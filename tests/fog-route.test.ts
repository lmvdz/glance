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
	// surprise-boost term still raises debt on top of that reset: a `surprise` tap does not clear
	// its OWN boost (only a later `diff-viewed`/`pr-reviewed` does — batch-3 review adjudication,
	// see the next test), so the operator's mental model of this file still reads as flagged right
	// after tapping it.
	const after = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	const afterEntry = after.entries.find((e: { file: string }) => e.file === "a.ts");
	expect(afterEntry.changesSinceSeen).toBe(0); // the tap itself counts as a view
	expect(afterEntry.debt).toBeGreaterThan(plainDebt); // but the boost still raises debt above the pre-tap baseline
	expect(afterEntry.debt).toBeGreaterThan(0);
});

test("GET /api/fog: a later diff-viewed clears the surprise boost; a fresh tap re-applies it (batch-3 review adjudication)", async () => {
	const { state, url } = await fixture();
	await appendReceipt(state, receipt({ repo: "/srv/app", filesTouched: ["a.ts"], endedAt: 100 }));

	// tap → boost active
	await fetch(`${url}/api/attention`, authed({ method: "POST", body: JSON.stringify({ kind: "surprise", repo: "/srv/app", file: "a.ts" }) }));
	const afterTap = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	const tapEntry = afterTap.entries.find((e: { file: string }) => e.file === "a.ts");
	expect(tapEntry.debt).toBeGreaterThan(0);

	// later diff-viewed → boost gone (no new receipts, so changesSinceSeen is also 0 → debt 0)
	const viewedRes = await fetch(`${url}/api/attention`, authed({ method: "POST", body: JSON.stringify({ kind: "diff-viewed", repo: "/srv/app", file: "a.ts" }) }));
	expect(viewedRes.status).toBe(200);
	const afterView = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	const viewedEntry = afterView.entries.find((e: { file: string }) => e.file === "a.ts");
	expect(viewedEntry?.debt ?? 0).toBe(0);

	// tap after that → boost active again. Distinct `agentId` from the first tap so this genuinely
	// distinct action doesn't fall into AttentionStore's 30s idempotent-replay coalesce window
	// (keyed on {kind,repo,file,agentId,viewerId}) purely because this test's real HTTP calls run
	// back-to-back on the wall clock — the coalesce window is a real production feature (a
	// double-click/duplicate-observer-callback guard), not something this test should fight.
	await fetch(`${url}/api/attention`, authed({ method: "POST", body: JSON.stringify({ kind: "surprise", repo: "/srv/app", file: "a.ts", agentId: "agent-2" }) }));
	const afterSecondTap = await fetch(`${url}/api/fog`, authed()).then((r) => r.json());
	const secondTapEntry = afterSecondTap.entries.find((e: { file: string }) => e.file === "a.ts");
	expect(secondTapEntry.debt).toBeGreaterThan(0);
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
