/**
 * GET /api/symptoms (comprehension concern 07) — the wiring, not a reimplementation of it: a real
 * `SquadManager` + `SquadServer` round trip proves the route actually ranks `listSymptoms` entries
 * with `rankKbDocs` and returns the full `SymptomEntry` shape (whereToLook array, fixedBy, landedAt),
 * not a lossy fabric/⌘K snippet. `answers.test.ts`'s closing note applies here too: "the function
 * works" and "the function is called" are different claims.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import { saveSymptom } from "../src/symptoms.ts";
import type { SymptomSearchHit } from "../src/symptoms.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function authed(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { "content-type": "application/json", authorization: "Bearer viewer-token-xxxxxxxx", ...init.headers } };
}

async function fixture() {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "symptom-route-"));
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
	const server = new SquadServer(manager, { port: 0, token: "admin-token-xxxxxxxx", roleTokens: { viewer: "viewer-token-xxxxxxxx" } });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
	});
	return { url, state };
}

test("GET /api/symptoms ranks the matching card top and returns the full entry, viewer-tier (no admin needed)", async () => {
	const { url, state } = await fixture();
	await saveSymptom(state, { id: "s1", symptom: "daemon healthy but dispatch stalled", whereToLook: ["src/dispatch.ts"], repo: "/srv/app", fixedBy: { agentId: "a1", prNumber: 42 }, landedAt: 1000 });
	await saveSymptom(state, { id: "s2", symptom: "verify green but land never fires", whereToLook: ["src/land.ts"], repo: "/srv/app", fixedBy: {}, landedAt: 2000 });

	const res = await fetch(`${url}/api/symptoms?q=${encodeURIComponent("dispatch stalled")}`, authed());
	expect(res.status).toBe(200);
	const body = (await res.json()) as { query: string; results: SymptomSearchHit[] };
	expect(body.results).toHaveLength(1);
	expect(body.results[0]!.id).toBe("s1");
	expect(body.results[0]!.whereToLook).toEqual(["src/dispatch.ts"]);
	expect(body.results[0]!.fixedBy.prNumber).toBe(42);
	expect(body.results[0]!.landedAt).toBe(1000);
	expect(typeof body.results[0]!.score).toBe("number");
});

test("GET /api/symptoms with an empty/missing q ranks nothing — this route ranks, it doesn't browse", async () => {
	const { url, state } = await fixture();
	await saveSymptom(state, { id: "s1", symptom: "daemon healthy but dispatch stalled", whereToLook: ["src/dispatch.ts"], repo: "/srv/app", fixedBy: {}, landedAt: 1000 });

	const res = await fetch(`${url}/api/symptoms`, authed());
	expect(res.status).toBe(200);
	expect((await res.json()).results).toEqual([]);
});

test("GET /api/symptoms respects ?repo= scoping", async () => {
	const { url, state } = await fixture();
	await saveSymptom(state, { id: "s1", symptom: "alpha's dispatch stalls under load", whereToLook: ["src/alpha.ts"], repo: "/srv/alpha", fixedBy: {}, landedAt: 1000 });
	await saveSymptom(state, { id: "s2", symptom: "beta's dispatch stalls under load", whereToLook: ["src/beta.ts"], repo: "/srv/beta", fixedBy: {}, landedAt: 1000 });

	const res = await fetch(`${url}/api/symptoms?q=${encodeURIComponent("dispatch stalls")}&repo=${encodeURIComponent("/srv/alpha")}`, authed());
	const body = (await res.json()) as { results: SymptomSearchHit[] };
	expect(body.results.map((r) => r.id)).toEqual(["s1"]);
});

test("a viewer token is enough — this is deliberately not operator-gated like /api/doctor", async () => {
	const { url, state } = await fixture();
	await saveSymptom(state, { id: "s1", symptom: "daemon healthy but dispatch stalled", whereToLook: ["src/dispatch.ts"], repo: "/srv/app", fixedBy: {}, landedAt: 1000 });
	const res = await fetch(`${url}/api/symptoms?q=dispatch`, authed());
	expect(res.status).toBe(200);
});
