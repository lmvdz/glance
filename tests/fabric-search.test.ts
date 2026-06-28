/**
 * fabric-search.test.ts — the queryable KB layer: tokenization, flattening,
 * BM25 ranking, and the agent cold-start primer. Pure (no fs/fetch/spawn).
 */

import { expect, test, describe } from "bun:test";
import { tokenize, fabricDocuments, searchFabric, buildContextPrimer } from "../src/fabric-search.ts";
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
});
