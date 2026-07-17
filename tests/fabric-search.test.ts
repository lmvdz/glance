/**
 * fabric-search.test.ts — the queryable KB layer: tokenization, flattening,
 * BM25 ranking, and the agent cold-start primer. Pure (no fs/fetch/spawn).
 */

import { afterEach, expect, test, describe } from "bun:test";
import { tokenize, fabricDocuments, rankKbDocs, searchFabric, buildContextPrimer, type KbDoc } from "../src/fabric-search.ts";
import { formatRewardTag } from "../src/digest.ts";
import type { FabricSnapshot } from "../src/fabric.ts";

function snapshot(over: Partial<FabricSnapshot> = {}): FabricSnapshot {
	return {
		actor: "op",
		generatedAt: 0,
		scope: [],
		agents: [
			{ type: "agent", source: { agentId: "a1", repo: "/r" }, agent: { id: "a1", name: "auth-bot", status: "working", activity: "editing tokens", todo: { done: 1, total: 3, active: "rotate refresh token" }, owns: [], featureId: "feat-auth", parentId: undefined, issue: { id: "i1", identifier: "OMPSQ-1", name: "Token rotation" }, repo: "/r", worktree: "/w" } },
		],
		digests: [
			{ type: "digest", source: { agentId: "a1", repo: "/r" }, digest: "## Goal\nImplement JWT refresh token rotation in the auth service.\n## Files touched\nsrc/auth/token.ts" },
		],
		hotAreas: [
			{ type: "hot-area", source: { repo: "/r" }, repo: "/r", file: "src/auth/token.ts", score: 9.5, touchedBy: [] },
			{ type: "hot-area", source: { repo: "/r" }, repo: "/r", file: "src/db/schema.ts", score: 1.2, touchedBy: [] },
		],
		scout: [
			{ type: "scout", source: { repo: "/r" }, issue: { id: "i2", identifier: "OMPSQ-9", name: "x", url: "http://plane/9" }, title: "Add rate limiting to the token endpoint" },
		],
		leases: [
			{ type: "lease", source: { repo: "/r", file: "src/auth/token.ts" }, lease: { id: "l1", repo: "/r", file: "src/auth/token.ts", operator: "op", session: "auth-bot", host: "h" } as FabricSnapshot["leases"][number]["lease"] },
		],
		decisions: [
			{ type: "decision", source: { repo: "/r", featureId: "feat-auth" }, featureTitle: "Auth tokens", text: "Use a 15-minute access token TTL with rotating refresh tokens.", decisionSource: "human", createdAt: 0 },
			{ type: "decision", source: { repo: "/r", featureId: "feat-ui" }, featureTitle: "Dashboard", text: "Adopt the magma colormap for the heat graph.", decisionSource: "human", createdAt: 0 },
		],
		failures: [],
		symptoms: [
			{ type: "symptom", source: { repo: "/r" }, id: "s1", symptom: "daemon healthy but dispatch stalled", whereToLook: ["src/dispatch.ts"], fixedBy: { agentId: "a1" }, landedAt: 500 },
		],
		episodes: [],
		answers: [
			{ type: "answer", source: { repo: "/r", agentId: "u1" }, id: "u1", question: "why is dispatch slow?", answerExcerpt: "Because the spawn loop is serial.", answeredAt: 500, possiblyStale: false },
		],
		...over,
	};
}

describe("tokenize", () => {
	test("splits camelCase and paths, drops 1-char tokens", () => {
		expect(tokenize("src/auth/tokenStore.ts")).toEqual(["src", "auth", "token", "store", "ts"]);
		expect(tokenize("JWT-refresh")).toEqual(["jwt", "refresh"]);
		expect(tokenize("")).toEqual([]);
	});
});

describe("fabricDocuments", () => {
	test("flattens one doc per fact across every type", () => {
		const docs = fabricDocuments(snapshot());
		const byType = (t: string) => docs.filter((d) => d.type === t).length;
		expect(byType("agent")).toBe(1);
		expect(byType("digest")).toBe(1);
		expect(byType("hot-area")).toBe(2);
		expect(byType("scout")).toBe(1);
		expect(byType("lease")).toBe(1);
		expect(byType("decision")).toBe(2);
		expect(byType("symptom")).toBe(1);
		expect(byType("answer")).toBe(1);
	});

	test("a symptom doc's text carries whereToLook too (concern 07: BM25 over symptom+whereToLook)", () => {
		const docs = fabricDocuments(snapshot());
		const doc = docs.find((d) => d.type === "symptom")!;
		expect(doc.title).toBe("daemon healthy but dispatch stalled");
		expect(doc.text).toContain("src/dispatch.ts");
		expect(doc.ref).toBe("src/dispatch.ts");
	});

	/** A recorded `glance ask` answer (comprehension concern 10): title is the question, text is the
	 *  capped excerpt ONLY (never the full untrusted markdown), and `ref` is the answer id so a
	 *  caller (the ⌘K palette) can act on it. */
	test("an answer doc carries the question as title and the capped excerpt as text", () => {
		const docs = fabricDocuments(snapshot());
		const doc = docs.find((d) => d.type === "answer")!;
		expect(doc.title).toBe("why is dispatch slow?");
		expect(doc.text).toBe("Because the spawn loop is serial.");
		expect(doc.ref).toBe("u1");
	});

	test("an absent snapshot.answers (older/forward-compat snapshot) yields no answer docs, not a crash", () => {
		const docs = fabricDocuments(snapshot({ answers: undefined as unknown as FabricSnapshot["answers"] }));
		expect(docs.some((d) => d.type === "answer")).toBe(false);
	});
});

describe("searchFabric", () => {
	test("ranks the relevant decision top for a conceptual query", () => {
		const results = searchFabric(snapshot(), "refresh token ttl");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].type).toBe("decision");
		expect(results[0].title).toContain("Auth tokens");
		expect(results[0].snippet).toContain("refresh");
	});

	test("finds a hot file by path fragment", () => {
		const results = searchFabric(snapshot(), "token.ts", { type: "hot-area" });
		expect(results[0].ref).toBe("src/auth/token.ts");
	});

	test("empty / whitespace query returns nothing", () => {
		expect(searchFabric(snapshot(), "")).toEqual([]);
		expect(searchFabric(snapshot(), "   ")).toEqual([]);
	});

	test("a term that matches nothing returns nothing", () => {
		expect(searchFabric(snapshot(), "kubernetes helm chart")).toEqual([]);
	});

	test("type filter restricts the corpus", () => {
		const results = searchFabric(snapshot(), "token", { type: "decision" });
		expect(results.every((r) => r.type === "decision")).toBe(true);
	});

	test("respects topK", () => {
		expect(searchFabric(snapshot(), "token", { topK: 1 })).toHaveLength(1);
	});

	test("hot-area recency weight breaks ties toward the hotter file", () => {
		// both files share the token-less query term "src"; the higher-scored file should rank first
		const results = searchFabric(snapshot(), "src", { type: "hot-area" });
		expect(results[0].ref).toBe("src/auth/token.ts"); // score 9.5 > 1.2
	});

	test("a recorded symptom card is searchable via ⌘K/fabric (concern 07)", () => {
		const results = searchFabric(snapshot(), "dispatch stalled", { type: "symptom" });
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe("daemon healthy but dispatch stalled");
		expect(results[0]!.ref).toBe("src/dispatch.ts");
	});

	/** A recorded ask→fabric answer (concern 10) is searchable via ⌘K/fabric, same as every other
	 *  fact type — this is the query the ⌘K palette fires. */
	test("a recorded answer is searchable via ⌘K/fabric (concern 10)", () => {
		const results = searchFabric(snapshot(), "dispatch slow spawn serial", { type: "answer" });
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe("why is dispatch slow?");
		expect(results[0]!.ref).toBe("u1");
	});
});

describe("rankKbDocs — the reusable BM25 core (concern 07: GET /api/symptoms reuses this directly)", () => {
	function docs(): KbDoc[] {
		return [
			{ type: "symptom", id: "s1", title: "daemon healthy but dispatch stalled", text: "daemon healthy but dispatch stalled src/dispatch.ts" },
			{ type: "symptom", id: "s2", title: "verify green but land never fires", text: "verify green but land never fires src/land.ts" },
		];
	}

	test("ranks the matching doc top, mirroring searchFabric's own scoring", () => {
		const results = rankKbDocs(docs(), "dispatch stalled");
		expect(results[0]!.id).toBe("s1");
		expect(results.some((r) => r.id === "s2")).toBe(false);
	});

	test("empty query or empty corpus returns nothing", () => {
		expect(rankKbDocs(docs(), "")).toEqual([]);
		expect(rankKbDocs([], "dispatch")).toEqual([]);
	});

	test("respects topK", () => {
		const results = rankKbDocs([...docs(), { type: "symptom", id: "s3", title: "dispatch stalled again", text: "dispatch stalled again" }], "dispatch stalled", { topK: 1 });
		expect(results).toHaveLength(1);
	});

	test("searchFabric and rankKbDocs agree on the same underlying corpus", () => {
		const viaSnapshot = searchFabric(snapshot(), "dispatch stalled", { type: "symptom" });
		const viaDocs = rankKbDocs(fabricDocuments(snapshot()).filter((d) => d.type === "symptom"), "dispatch stalled");
		expect(viaDocs.map((r) => r.id)).toEqual(viaSnapshot.map((r) => r.id));
		expect(viaDocs[0]!.score).toBeCloseTo(viaSnapshot[0]!.score, 6);
	});
});

describe("buildContextPrimer", () => {
	test("distills top hits into a fenced, labeled markdown primer", () => {
		const primer = buildContextPrimer(snapshot(), "refresh token rotation", { topK: 4 });
		expect(primer).toContain("Related context from prior work");
		expect(primer).toMatch(/\*\*(Decision|Hot file|Prior session|Active agent)\*\*/);
		expect(primer).toContain("refresh");
	});

	test("returns empty string when nothing is relevant (caller injects nothing)", () => {
		expect(buildContextPrimer(snapshot(), "kubernetes helm chart")).toBe("");
	});

	test("a recorded symptom is folded into the cold-start primer as a Known symptom (concern 07)", () => {
		const primer = buildContextPrimer(snapshot(), "dispatch stalled", { topK: 4 });
		expect(primer).toContain("**Known symptom**");
		expect(primer).toContain("dispatch stalled");
	});

	test("a recorded answer is folded into the cold-start primer as an Answered question (concern 10)", () => {
		const primer = buildContextPrimer(snapshot(), "dispatch slow spawn serial", { topK: 4 });
		expect(primer).toContain("**Answered question**");
		expect(primer).toContain("why is dispatch slow?");
	});

	test("output is always fenced as untrusted internally — no unfenced path (concern 02)", () => {
		const primer = buildContextPrimer(snapshot(), "refresh token rotation");
		expect(primer.startsWith("===== BEGIN context primer (untrusted data) =====")).toBe(true);
		expect(primer.trim().endsWith("===== END context primer =====")).toBe(true);
	});

	test("a hit carries provenance (source + age) when the underlying fact has a timestamp (concern 02)", () => {
		const now = 10_000_000;
		const snap = snapshot({
			decisions: [{ type: "decision", source: { repo: "/r", featureId: "feat-auth" }, featureTitle: "Auth tokens", text: "Use a 15-minute access token TTL with rotating refresh tokens.", decisionSource: "human", createdAt: now - 2 * 60 * 60 * 1000 }],
		});
		const primer = buildContextPrimer(snap, "refresh token ttl", { now });
		expect(primer).toContain("src: human decision");
		expect(primer).toContain("2h ago");
	});

	test("a hit scoring far below the top match is labelled weak, not dropped", () => {
		// "token" hits the decision strongly and the lease only incidentally via its file path.
		const results = buildContextPrimer(snapshot(), "token rotation ttl 15-minute access", { topK: 6 });
		expect(results).toContain("weak match");
	});
});

describe("reward-boost ranking (concern 03)", () => {
	afterEach(() => {
		delete process.env.OMP_SQUAD_REWARD_BOOST;
	});

	function rewardSnapshot(): FabricSnapshot {
		const body = "## Goal\nFix the flaky retry backoff test\n\n## Summary\n- fixed retry backoff jitter\n";
		return snapshot({
			digests: [
				{ type: "digest", source: { agentId: "unknown-agent", repo: "/r" }, digest: `${body}\n${formatRewardTag({ ok: false, fresh: false, firstTryGreen: false })}\n` },
				{ type: "digest", source: { agentId: "green-agent", repo: "/r" }, digest: `${body}\n${formatRewardTag({ ok: true, fresh: true, firstTryGreen: true })}\n` },
			],
		});
	}

	test("flag off: an unknown digest and a first-try-green digest rank equally on equal BM25", () => {
		const results = searchFabric(rewardSnapshot(), "flaky retry backoff", { type: "digest" });
		expect(results).toHaveLength(2);
		expect(results[0]!.score).toBeCloseTo(results[1]!.score, 6);
	});

	test("flag on: the first-try-green digest out-ranks the unknown one on equal BM25", () => {
		process.env.OMP_SQUAD_REWARD_BOOST = "1";
		const results = searchFabric(rewardSnapshot(), "flaky retry backoff", { type: "digest" });
		expect(results).toHaveLength(2);
		expect(results[0]!.ref).toBe("green-agent");
		expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
	});

	test("flag on: no digest is ever weighted below the equal-BM25 baseline (boost-only)", () => {
		process.env.OMP_SQUAD_REWARD_BOOST = "1";
		const boosted = searchFabric(rewardSnapshot(), "flaky retry backoff", { type: "digest" });
		delete process.env.OMP_SQUAD_REWARD_BOOST;
		const baseline = searchFabric(rewardSnapshot(), "flaky retry backoff", { type: "digest" });
		const unknownBoosted = boosted.find((r) => r.ref === "unknown-agent")!;
		const unknownBaseline = baseline.find((r) => r.ref === "unknown-agent")!;
		expect(unknownBoosted.score).toBeCloseTo(unknownBaseline.score, 6); // the failed/unknown one never drops
	});
});

describe("recurring-failure memory (concern 05 + skills-hardening concern 05)", () => {
	afterEach(() => {
		delete process.env.OMP_SQUAD_FAILURE_MEMORY;
	});

	function failureSnapshot(): FabricSnapshot {
		return snapshot({ failures: [{ type: "failure", source: { repo: "/r" }, fingerprint: "land-failing:squad/a1", branch: "squad/a1", rootCause: "flaky retry backoff jitter", at: 0 }] });
	}

	test("default (env unset): a failure fact is searchable and injected fenced into the primer, prefixed as an imperative", () => {
		const results = searchFabric(failureSnapshot(), "flaky retry backoff jitter", { type: "failure" });
		expect(results).toHaveLength(1);
		expect(results[0]!.ref).toBe("land-failing:squad/a1");

		const primer = buildContextPrimer(failureSnapshot(), "flaky retry backoff jitter");
		expect(primer).toContain("**Recurring failure**");
		expect(primer).toContain("Do not repeat: Recurring failure · squad/a1");
		expect(primer.startsWith("===== BEGIN context primer (untrusted data) =====")).toBe(true);
	});

	test("flag on explicitly (=1): same behavior as the default", () => {
		process.env.OMP_SQUAD_FAILURE_MEMORY = "1";
		const results = searchFabric(failureSnapshot(), "flaky retry backoff jitter", { type: "failure" });
		expect(results).toHaveLength(1);
		expect(results[0]!.ref).toBe("land-failing:squad/a1");

		const primer = buildContextPrimer(failureSnapshot(), "flaky retry backoff jitter");
		expect(primer).toContain("**Recurring failure**");
		expect(primer).toContain("Do not repeat: Recurring failure · squad/a1");
		expect(primer.startsWith("===== BEGIN context primer (untrusted data) =====")).toBe(true);
	});

	test("flag explicitly off (=0): a failure fact never surfaces, even on an exact-text query", () => {
		process.env.OMP_SQUAD_FAILURE_MEMORY = "0";
		const results = searchFabric(failureSnapshot(), "flaky retry backoff jitter");
		expect(results.some((r) => r.type === "failure")).toBe(false);
		const primer = buildContextPrimer(failureSnapshot(), "flaky retry backoff jitter");
		expect(primer).not.toContain("Do not repeat");
	});

	test("a task unrelated to any recorded failure gets no failure injection", () => {
		const primer = buildContextPrimer(failureSnapshot(), "kubernetes helm chart");
		expect(primer).toBe("");
	});

	test("non-failure hit types are never prefixed with the imperative", () => {
		const primer = buildContextPrimer(snapshot(), "refresh token ttl");
		expect(primer).not.toContain("Do not repeat");
	});
});

describe("searchFabric provenance", () => {
	test("results carry source/ranAt from the underlying fact", () => {
		const results = searchFabric(snapshot(), "refresh token ttl");
		const decision = results.find((r) => r.type === "decision");
		expect(decision?.source).toBe("human decision");
		expect(decision?.ranAt).toBe(0);
	});

	test("a fact type with no timestamp (e.g. an agent) carries no fabricated ranAt", () => {
		const results = searchFabric(snapshot(), "auth-bot");
		const agent = results.find((r) => r.type === "agent");
		expect(agent?.ranAt).toBeUndefined();
		expect(agent?.source).toBe("agent a1");
	});
});
