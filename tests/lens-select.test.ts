import { describe, expect, test } from "bun:test";
import { changedFilesFromDiff, selectLenses } from "../src/lens-select.ts";

/** Minimal unified-diff header block for a set of new-side paths. */
function diffOf(...paths: string[]): string {
	return paths.map((p) => `diff --git a/${p} b/${p}\nindex 000..111 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new`).join("\n");
}

describe("changedFilesFromDiff", () => {
	test("extracts the new-side path from each diff header", () => {
		expect(changedFilesFromDiff(diffOf("src/a.ts", "docs/b.md"))).toEqual(["src/a.ts", "docs/b.md"]);
	});
	test("empty diff → no files", () => {
		expect(changedFilesFromDiff("")).toEqual([]);
	});
});

describe("selectLenses", () => {
	const max = 1;

	test("docs + lockfile only → no lens", () => {
		expect(selectLenses(diffOf("README.md", "bun.lock"), { max })).toEqual([]);
	});

	test("sensitive/source paths → regression lens", () => {
		expect(selectLenses(diffOf(".env"), { max })).toEqual(["regression"]);
		expect(selectLenses(diffOf(".github/workflows/ci.yml"), { max })).toEqual(["regression"]);
		expect(selectLenses(diffOf("src/auth/session.ts"), { max })).toEqual(["regression"]);
	});

	test("mixed docs + one source file → fires (not treated as docs-only)", () => {
		expect(selectLenses(diffOf("README.md", "src/thing.ts"), { max })).toEqual(["regression"]);
	});

	test("broad source diff → fires even with no individually risky path", () => {
		const broad = diffOf(...Array.from({ length: 20 }, (_, i) => `src/mod${i}.ts`));
		expect(selectLenses(broad, { max })).toEqual(["regression"]);
	});

	test("max <= 0 → no lens regardless of surface", () => {
		expect(selectLenses(diffOf("src/auth/session.ts"), { max: 0 })).toEqual([]);
	});

	test("empty diff → no lens", () => {
		expect(selectLenses("", { max })).toEqual([]);
	});

	test("docs-only but HIGH_RISK criteria text → fires (out-of-criteria edge)", () => {
		expect(selectLenses(diffOf("README.md"), { max, criteriaText: "migrate the production schema" })).toEqual(["regression"]);
	});

	test("allow-list intersection is respected", () => {
		expect(selectLenses(diffOf("src/a.ts"), { max, allow: [] })).toEqual([]);
		expect(selectLenses(diffOf("src/a.ts"), { max, allow: ["regression"] })).toEqual(["regression"]);
	});
});
