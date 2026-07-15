/**
 * `featureDecisions` (server.ts PATCH sanitizer) — batch-1 review CRITICAL: the webapp's routine
 * "add one decision" round-trip PATCHes the FULL decisions array back, and the pre-fix sanitizer
 * coerced every stored `model-delta` to `source:"human"` and dropped its `evidence`/`sourceRef` —
 * destroying the teaching content concern 05 exists to produce. The fix merges by id: stored
 * entries keep their server-authoritative fields (only text is taken from the client); entries the
 * client omits are deleted; NEW client entries are down-tiered so a PATCH can never mint
 * `model-delta`/`plan`/`agent` records it didn't already have.
 */
import { expect, test } from "bun:test";
import { featureDecisions } from "../src/server.ts";
import type { FeatureDecision } from "../src/types.ts";

const stored: FeatureDecision[] = [
	{
		id: "d1",
		text: "Dispatch used to serialize spawns; it now fans out concurrently.",
		source: "model-delta",
		evidence: ["src/dispatch.ts:40-80"],
		createdAt: 1000,
		sourceRef: { agentId: "agent-1", runId: "run-1" },
	},
	{ id: "d2", text: "Ship file mode first.", source: "human", createdAt: 2000 },
];

test("round-tripping the full array preserves stored source/evidence/sourceRef on model-deltas", () => {
	// exactly what TaskDetail's addDecision sends: every existing entry (source lost to the DTO
	// round-trip or mangled) plus one new human entry
	const incoming = [
		{ id: "d1", text: "Dispatch used to serialize spawns; it now fans out concurrently.", source: "human" },
		{ id: "d2", text: "Ship file mode first.", source: "human" },
		{ id: "d3", text: "New operator note.", source: "human" },
	];
	const out = featureDecisions(incoming, stored);
	expect(out).toHaveLength(3);
	expect(out?.[0]).toEqual(stored[0]); // source model-delta, evidence, sourceRef, createdAt all intact
	expect(out?.[1]).toEqual(stored[1]);
	expect(out?.[2]?.source).toBe("human");
});

test("client text edits to an existing entry are taken; everything else stays server-authoritative", () => {
	const out = featureDecisions([{ id: "d1", text: "Edited wording.", source: "human" }], stored);
	expect(out?.[0]?.text).toBe("Edited wording.");
	expect(out?.[0]?.source).toBe("model-delta");
	expect(out?.[0]?.evidence).toEqual(["src/dispatch.ts:40-80"]);
	expect(out?.[0]?.sourceRef).toEqual({ agentId: "agent-1", runId: "run-1" });
});

test("omitting an entry deletes it — the merge must not resurrect removed decisions", () => {
	const out = featureDecisions([{ id: "d2", text: "Ship file mode first.", source: "human" }], stored);
	expect(out).toHaveLength(1);
	expect(out?.[0]?.id).toBe("d2");
});

test("a NEW entry claiming model-delta (or plan/agent-adjacent junk) is down-tiered to human", () => {
	const out = featureDecisions(
		[
			{ id: "new-1", text: "Fake delta with fake anchors.", source: "model-delta", evidence: ["src/anything.ts"] },
			{ id: "new-2", text: "Legit plan entry from a client.", source: "plan" },
		],
		stored,
	);
	expect(out?.[0]?.source).toBe("human");
	expect(out?.[0]?.evidence).toBeUndefined(); // evidence is never accepted from a PATCH client
	expect(out?.[1]?.source).toBe("plan"); // plan/human/agent remain accepted for new entries, as before
});

test("non-array input and entries without id/text behave as before", () => {
	expect(featureDecisions("nope", stored)).toBeUndefined();
	expect(featureDecisions([{ text: "no id" }, { id: "x", text: "  " }], stored)).toEqual([]);
});

test("undefined stored decisions (derived feature) still sanitizes without throwing", () => {
	const out = featureDecisions([{ id: "a", text: "A fresh decision on a derived feature.", source: "agent" }], undefined);
	expect(out?.[0]?.source).toBe("agent");
});
