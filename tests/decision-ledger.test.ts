import { describe, expect, test } from "bun:test";
import { DecisionLedger, type DecisionLedgerStore, normalizeSupersedesRef } from "../src/memory/decision-ledger.ts";
import type { FeatureDecision, PersistedFeature } from "../src/types.ts";

/**
 * The decision ledger through its OWN interface — no SquadManager, no reach-through casts.
 * The in-memory store adapter here is the second adapter that makes the DecisionLedgerStore
 * seam real (production's adapter is SquadManager's store-resident Map + adopt + persist).
 */

function feature(id: string, decisions: FeatureDecision[] = []): PersistedFeature {
	return { id, title: id, repo: "r", decisions, assignees: [], createdAt: 1, updatedAt: 1 } as unknown as PersistedFeature;
}

function memoryStore(seed: PersistedFeature[] = [], opts?: { derived?: PersistedFeature[] }) {
	const map = new Map(seed.map((f) => [f.id, f]));
	const derived = new Map((opts?.derived ?? []).map((f) => [f.id, f]));
	let changed = 0;
	const store: DecisionLedgerStore = {
		get: (id) => map.get(id),
		adopt: async (id) => {
			const d = derived.get(id);
			if (!d) return undefined;
			const raced = map.get(id);
			if (raced) return raced; // the adapter's race guard: store-resident object wins
			map.set(id, d);
			return d;
		},
		changed: () => {
			changed++;
		},
	};
	return { store, map, changes: () => changed };
}

const d = (id: string, text: string, extra: Partial<FeatureDecision> = {}): FeatureDecision => ({ id, text, source: "agent", createdAt: 1, ...extra });

describe("record — the single write rule", () => {
	test("records, notifies the store, and appends to the feature", async () => {
		const { store, map, changes } = memoryStore([feature("f")]);
		const ledger = new DecisionLedger(store);
		expect(await ledger.record("f", d("a", "ship file mode first"))).toBe("recorded");
		expect(map.get("f")?.decisions?.map((x) => x.id)).toEqual(["a"]);
		expect(changes()).toBe(1);
	});

	test("unknown feature: no-feature, nothing written", async () => {
		const { store, changes } = memoryStore();
		expect(await new DecisionLedger(store).record("ghost", d("a", "text"))).toBe("no-feature");
		expect(changes()).toBe(0);
	});

	test("plan-derived feature is adopted on first write", async () => {
		const { store, map } = memoryStore([], { derived: [feature("plan-f")] });
		expect(await new DecisionLedger(store).record("plan-f", d("a", "adopted then recorded"))).toBe("recorded");
		expect(map.get("plan-f")?.decisions?.length).toBe(1);
	});

	test("text de-dupe is normalized and considers only CURRENT decisions (A→B→A is legal)", async () => {
		const { store } = memoryStore([feature("f")]);
		const ledger = new DecisionLedger(store);
		await ledger.record("f", d("a", "Use   SQLite for state"));
		expect(await ledger.record("f", d("a2", "use sqlite FOR state"))).toBe("duplicate");
		// Reverse it, then re-assert the original: legal ledger history, not a silent no-op.
		expect(await ledger.record("f", d("b", "use postgres for state", { supersedes: "a" }))).toBe("recorded");
		expect(await ledger.record("f", d("a3", "use sqlite for state", { supersedes: "b" }))).toBe("recorded");
	});

	test("supersession stamps supersededBy/supersededAt in the same write", async () => {
		const { store, map } = memoryStore([feature("f", [d("old", "old truth")])]);
		await new DecisionLedger(store).record("f", d("new", "new truth", { supersedes: "old" }));
		const decisions = map.get("f")!.decisions!;
		const old = decisions.find((x) => x.id === "old")!;
		expect(old.supersededBy).toBe("new");
		expect(old.supersededAt).toBeGreaterThan(0);
		expect(decisions.find((x) => x.id === "new")?.supersedes).toBe("old");
	});

	test("supersedes accepts the kb-search `decision:<id>` doc-id form", async () => {
		const { store, map } = memoryStore([feature("f", [d("old", "old truth")])]);
		expect(await new DecisionLedger(store).record("f", d("new", "new truth", { supersedes: "decision:old" }))).toBe("recorded");
		expect(map.get("f")!.decisions!.find((x) => x.id === "old")?.supersededBy).toBe("new");
	});

	test("missing target: supersede-missing; already-superseded target: supersede-superseded", async () => {
		const { store } = memoryStore([feature("f", [d("old", "old truth", { supersededBy: "mid" }), d("mid", "mid truth")])]);
		const ledger = new DecisionLedger(store);
		expect(await ledger.record("f", d("x", "some new claim", { supersedes: "nope" }))).toBe("supersede-missing");
		expect(await ledger.record("f", d("y", "another new claim", { supersedes: "old" }))).toBe("supersede-superseded");
	});
});

describe("capture — the agent-tool mint path", () => {
	test("model-delta without a real anchor is rejected before anything is written", async () => {
		const { store, changes } = memoryStore([feature("f")]);
		const result = await new DecisionLedger(store).capture({
			featureId: "f",
			text: "the daemon now resolves features through the ledger seam",
			modelDelta: true,
			evidence: ["src/not-touched.ts"],
			filesTouched: async () => ["src/memory/decision-ledger.ts"],
		});
		expect(result.kind).toBe("rejected");
		if (result.kind === "rejected") expect(result.rule).toBe("model-delta-evidence-anchor");
		expect(changes()).toBe(0);
	});

	test("model-delta mints with normalized evidence anchors and provenance backlink", async () => {
		const { store, map } = memoryStore([feature("f")]);
		const result = await new DecisionLedger(store).capture({
			featureId: "f",
			text: "decision writes now go through DecisionLedger, not a private manager method",
			modelDelta: true,
			evidence: ["./src/memory/decision-ledger.ts:10-20"],
			sourceRef: { agentId: "unit-1", runId: "run-9" },
			filesTouched: async () => ["src/memory/decision-ledger.ts"],
		});
		expect(result.kind).toBe("recorded");
		const rec = map.get("f")!.decisions![0]!;
		expect(rec.source).toBe("model-delta");
		expect(rec.evidence).toEqual(["src/memory/decision-ledger.ts:10-20"]);
		expect(rec.sourceRef).toEqual({ agentId: "unit-1", runId: "run-9" });
		expect(rec.id).toBeTruthy();
	});

	test("plain capture never invokes the filesTouched provider", async () => {
		const { store } = memoryStore([feature("f")]);
		let invoked = 0;
		const result = await new DecisionLedger(store).capture({
			featureId: "f",
			text: "a plain agent decision",
			modelDelta: false,
			filesTouched: async () => {
				invoked++;
				return [];
			},
		});
		expect(result.kind).toBe("recorded");
		expect(invoked).toBe(0);
	});
});

describe("supersede — the human lane's verb", () => {
	test("empty text or a bare `decision:` prefix is invalid, not a silent append", async () => {
		const { store, changes } = memoryStore([feature("f", [d("old", "old truth")])]);
		const ledger = new DecisionLedger(store);
		expect((await ledger.supersede("f", { text: "  ", supersedes: "old" })).outcome).toBe("invalid");
		expect((await ledger.supersede("f", { text: "new truth", supersedes: "decision:" })).outcome).toBe("invalid");
		expect(changes()).toBe(0);
	});

	test("mints a human-sourced decision through the write rule", async () => {
		const { store, map } = memoryStore([feature("f", [d("old", "old truth")])]);
		const result = await new DecisionLedger(store).supersede("f", { text: "corrected truth", supersedes: "decision:old" });
		expect(result.outcome).toBe("recorded");
		if (result.outcome === "recorded") expect(result.decision.source).toBe("human");
		expect(map.get("f")!.decisions!.find((x) => x.id === "old")?.supersededBy).toBeTruthy();
	});
});

test("normalizeSupersedesRef strips the doc-id prefix and whitespace", () => {
	expect(normalizeSupersedesRef("  decision:abc ")).toBe("abc");
	expect(normalizeSupersedesRef("abc")).toBe("abc");
	expect(normalizeSupersedesRef("decision:")).toBe("");
});
