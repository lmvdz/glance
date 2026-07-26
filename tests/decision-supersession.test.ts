/**
 * Decision supersession — the ledger write rule (plans/research-long-horizon-agent-memory):
 * "recurrence promotes, contradiction supersedes." A decision recorded with `supersedes` stamps
 * the target's `supersededBy`/`supersededAt` in the same atomic write; superseded decisions stay
 * on the feature record (invalidated, never deleted) but are EXCLUDED from the fabric/primer
 * projection — a stale fact in a spawned agent's context gets adopted regardless of labeling
 * (compliance trap, arXiv 2607.10608; VALIDATION C9's exclusion-not-annotation default).
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFabricSnapshot } from "../src/fabric.ts";
import { fabricDocuments, searchFabric } from "../src/fabric-search.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { FeatureDecision, PersistedFeature } from "../src/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(async () => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

function seededManager(dir: string, decisions: FeatureDecision[] = []): { mgr: SquadManager; store: Map<string, PersistedFeature> } {
	const mgr = new SquadManager({ stateDir: dir });
	const store = (mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;
	store.set("f", { id: "f", repo: "/repo", title: "feat-f", archived: false, decisions, createdAt: 1, updatedAt: 1 } as unknown as PersistedFeature);
	return { mgr, store };
}

const dec = (id: string, text: string, extra: Partial<FeatureDecision> = {}): FeatureDecision => ({ id, text, source: "agent", createdAt: 1000, ...extra });

test("superseding write stamps the target and appends the replacement in one step", async () => {
	const dir = await tmpDir("sup-stamp-");
	const { mgr, store } = seededManager(dir, [dec("d1", "target = staging")]);

	const outcome = await mgr.recordAgentDecision("f", dec("d2", "target = prod", { supersedes: "d1" }));
	expect(outcome).toBe("recorded");

	const decisions = store.get("f")?.decisions ?? [];
	expect(decisions).toHaveLength(2);
	const d1 = decisions.find((d) => d.id === "d1")!;
	expect(d1.supersededBy).toBe("d2");
	expect(typeof d1.supersededAt).toBe("number");
	expect(d1.text).toBe("target = staging"); // invalidated, never deleted — still legible
	const d2 = decisions.find((d) => d.id === "d2")!;
	expect(d2.supersedes).toBe("d1");
	expect(d2.supersededBy).toBeUndefined();
});

test("superseding a missing target is rejected and writes nothing", async () => {
	const dir = await tmpDir("sup-missing-");
	const { mgr, store } = seededManager(dir, [dec("d1", "target = staging")]);
	const outcome = await mgr.recordAgentDecision("f", dec("d2", "target = prod", { supersedes: "nope" }));
	expect(outcome).toBe("supersede-missing");
	expect(store.get("f")?.decisions).toHaveLength(1);
});

test("superseding an already-superseded target is rejected — supersede the current decision, not history", async () => {
	const dir = await tmpDir("sup-stale-");
	const { mgr, store } = seededManager(dir, [dec("d1", "target = staging", { supersededBy: "d2", supersededAt: 2000 }), dec("d2", "target = prod", { supersedes: "d1" })]);
	const outcome = await mgr.recordAgentDecision("f", dec("d3", "target = canary", { supersedes: "d1" }));
	expect(outcome).toBe("supersede-superseded");
	expect(store.get("f")?.decisions).toHaveLength(2);
});

test("text de-dupe considers only CURRENT decisions — re-asserting a reversed fact (A→B→A) is legal history", async () => {
	const dir = await tmpDir("sup-aba-");
	const { mgr, store } = seededManager(dir, [dec("d1", "target = staging", { supersededBy: "d2", supersededAt: 2000 }), dec("d2", "target = prod", { supersedes: "d1" })]);

	// Same normalized text as superseded d1 — must be recordable (superseding current d2), not a duplicate no-op.
	const outcome = await mgr.recordAgentDecision("f", dec("d3", "Target = STAGING", { supersedes: "d2" }));
	expect(outcome).toBe("recorded");
	const decisions = store.get("f")?.decisions ?? [];
	expect(decisions).toHaveLength(3);
	expect(decisions.find((d) => d.id === "d2")?.supersededBy).toBe("d3");

	// De-dupe against a CURRENT decision still works.
	expect(await mgr.recordAgentDecision("f", dec("d4", "target = staging"))).toBe("duplicate");
});

test("fabric projection excludes superseded decisions (exclusion, not annotation) and surfaces real ids", async () => {
	const dir = await tmpDir("sup-fabric-");
	const feature = {
		id: "f",
		repo: "/repo",
		title: "feat-f",
		archived: false,
		createdAt: 1,
		updatedAt: 1,
		decisions: [dec("d1", "target = staging", { supersededBy: "d2", supersededAt: 2000 }), dec("d2", "target = prod", { supersedes: "d1" })],
	} as unknown as PersistedFeature;
	const humanActor = { id: "web:admin", origin: "local" as const, role: "admin" as const };
	const snapshot = await buildFabricSnapshot({ actor: humanActor, agents: [], stateDir: dir, features: [feature], now: () => 3000 });

	expect(snapshot.decisions).toHaveLength(1);
	expect(snapshot.decisions[0]).toMatchObject({ id: "d2", text: "target = prod" });

	// KB doc id carries the REAL decision id — the id an agent can see is the id `supersedes` accepts.
	const docs = fabricDocuments(snapshot).filter((d) => d.type === "decision");
	expect(docs).toHaveLength(1);
	expect(docs[0]!.id).toBe("decision:d2");
	const hits = searchFabric(snapshot, "target prod", { type: "decision" });
	expect(hits[0]?.id).toBe("decision:d2");
});
