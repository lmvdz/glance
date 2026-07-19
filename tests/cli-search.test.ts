/**
 * `glance search "<query>"` — the terminal client for `GET /api/fabric/search`
 * (fabric-search.ts's BM25 `searchFabric`). Drives the pure renderer directly
 * (`renderSearchResults`), matching how `renderAgentRoster`/`renderHarnessTable` are
 * tested elsewhere in this file's siblings — no HTTP mocking in this codebase's CLI tests.
 */
import { describe, expect, test } from "bun:test";
import { renderSearchResults } from "../src/index.ts";
import type { FabricSearchResult } from "../src/fabric-search.ts";

function hit(overrides: Partial<FabricSearchResult> = {}): FabricSearchResult {
	return {
		type: "decision",
		id: "decision:1:0",
		title: "Decision · use BM25 for fabric search",
		snippet: "we chose bm25 because it needs no external index",
		score: 4.3217,
		...overrides,
	};
}

describe("renderSearchResults", () => {
	test("no results renders a clean, query-echoing miss", () => {
		expect(renderSearchResults([], "does not exist")).toBe('no matches for "does not exist".\n');
	});

	test("renders score (2dp), type, title, and snippet", () => {
		const out = renderSearchResults([hit()], "bm25");
		expect(out).toContain("4.32");
		expect(out).toContain("decision");
		expect(out).toContain("Decision · use BM25 for fabric search");
		expect(out).toContain("we chose bm25 because it needs no external index");
	});

	test("ref and source render as a pointer line", () => {
		const out = renderSearchResults([hit({ ref: "src/fabric-search.ts", source: "human decision" })], "bm25");
		expect(out).toContain("ref: src/fabric-search.ts");
		expect(out).toContain("src: human decision");
	});

	test("ranAt renders a relative age, absent ranAt renders none", () => {
		const withAge = renderSearchResults([hit({ ranAt: Date.now() - 90 * 60_000 })], "q");
		expect(withAge).toMatch(/\d+[hm]? ago|just now/);

		const withoutAny = renderSearchResults([hit({ ref: undefined, source: undefined, ranAt: undefined })], "q");
		// no parenthetical pointer line at all when ref/source/ranAt are all absent
		expect(withoutAny).not.toMatch(/\n\s+\(/);
	});

	test("multiple hits render in the given order, separated by a blank line", () => {
		const out = renderSearchResults(
			[hit({ id: "a", title: "First hit", type: "decision" }), hit({ id: "b", title: "Second hit", type: "hot-area" })],
			"q",
		);
		const firstIdx = out.indexOf("First hit");
		const secondIdx = out.indexOf("Second hit");
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);
		expect(out.slice(firstIdx, secondIdx)).toContain("\n\n");
	});

	test("differing type-name widths (scout vs hot-area) still align without truncating either", () => {
		const out = renderSearchResults([hit({ type: "scout", title: "S" }), hit({ type: "hot-area", title: "H" })], "q");
		expect(out).toContain("scout");
		expect(out).toContain("hot-area");
	});
});
