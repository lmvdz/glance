/**
 * POST /api/features/:id/decisions/supersede — the human lane's supersession verb (LIVE-1,
 * plans/research-long-horizon-agent-memory/EXPERIMENTS.md). Before this route, the UI could ADD
 * or DELETE a decision but never SUPERSEDE one: PATCH drops client `supersedes` by anti-forgery
 * design and squad_record_decision is agent-tool-only — leaving deletion, the one verb the ledger
 * forbids for chain members, as the human's only way to retire a decision. The route rides
 * recordAgentDecision's single write rule, so every stamp is server-authored and every conflict
 * maps to an explicit HTTP status.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { FeatureDecision, PersistedFeature } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function authed(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { "content-type": "application/json", authorization: "Bearer admin", ...init.headers } };
}

async function fixture() {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "sup-route-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sup-route-repo-"));
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
	const server = new SquadServer(manager, { port: 0, token: "admin" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});
	const pf = manager.createFeature({ title: "sup-route", repo });
	const store = (manager as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;
	store.get(pf.id)!.decisions = [{ id: "d1", text: "target = staging.api.internal", source: "human", createdAt: 1000 } as FeatureDecision];
	return { url, repo, manager, featureId: pf.id, store };
}

test("a human supersedes a decision over HTTP: stamp server-authored, history intact, projection filtered", async () => {
	const { url, featureId, store } = await fixture();
	const res = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "target = prod.api.internal", supersedes: "d1" }) }));
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.ok).toBe(true);
	expect(body.decision.supersedes).toBe("d1");
	expect(body.decision.source).toBe("human");

	const decisions = store.get(featureId)?.decisions ?? [];
	expect(decisions).toHaveLength(2);
	const d1 = decisions.find((d) => d.id === "d1")!;
	expect(d1.supersededBy).toBe(body.decision.id); // stamp authored by the write rule, not the client
	expect(d1.text).toBe("target = staging.api.internal"); // invalidated, never deleted
	expect(decisions.filter((d) => !d.supersededBy)).toHaveLength(1); // exactly one current
});

test("conflict outcomes map to explicit statuses, never silent drops", async () => {
	const { url, featureId } = await fixture();
	// missing target → 409 naming the id
	const missing = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "target = prod.api.internal", supersedes: "nope" }) }));
	expect(missing.status).toBe(409);
	expect(await missing.text()).toContain("nope");

	// supersede for real, then try to supersede the now-historical target again → 409 steering to current
	const ok = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "target = prod.api.internal", supersedes: "d1" }) }));
	expect(ok.status).toBe(200);
	const stale = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "target = canary.api.internal", supersedes: "d1" }) }));
	expect(stale.status).toBe(409);
	expect(await stale.text()).toContain("already superseded");

	// no such feature → 404
	const nofeat = await fetch(`${url}/api/features/absent/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "x y z", supersedes: "d1" }) }));
	expect(nofeat.status).toBe(404);

	// malformed body → 400
	const bad = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "" }) }));
	expect(bad.status).toBe(400);

	// blind-review lock: empty or bare-prefix supersedes must 400, never degrade to a plain append
	for (const supersedes of ["", "  ", "decision:"]) {
		const degenerate = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "target = other.api.internal", supersedes }) }));
		expect(degenerate.status).toBe(400);
	}
});

test("the route cannot be used to mint stamps: supersededBy/supersededAt in the body are ignored", async () => {
	const { url, featureId, store } = await fixture();
	const res = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/decisions/supersede`, authed({ method: "POST", body: JSON.stringify({ text: "target = prod.api.internal", supersedes: "d1", supersededBy: "forged", supersededAt: 1 }) }));
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.decision.supersededBy).toBeUndefined(); // the NEW decision is current — a forged stamp never sticks
	const d1 = (store.get(featureId)?.decisions ?? []).find((d) => d.id === "d1")!;
	expect(d1.supersededBy).toBe(body.decision.id); // and the real stamp is the server's, not "forged"
});
