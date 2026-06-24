import { describe, expect, test } from "bun:test";
import { parseTier2 } from "../src/tier2.ts";

// A representative promote-issue body (description_html with Tier-1 + Tier-2 blocks).
const PROMOTED = `<p>Original triage description: the auth handler drops 401s.</p>
<hr />
<h2>Tier-1 origin &amp; research context</h2>
<h3>Discovery</h3><p>Found 2026-06 during review.</p>
<h3>Acceptance test</h3><p>NARRATIVE — not the real one.</p>
<hr />
<h2>Tier-2 implementation context</h2>
<h3>Touches (files + lines)</h3><ul><li><code>src/auth.ts:40-60</code></li></ul>
<h3>Acceptance test</h3><pre><code>bun test tests/auth.test.ts</code></pre><p>Fails before, passes after.</p>
<h3>Verification gate</h3><pre><code>bun run check &amp;&amp; bun test</code></pre>
<h3>Scope</h3><p><strong>Allowed:</strong> src/auth.ts. <strong>Denied:</strong> webapp/</p>`;

describe("parseTier2", () => {
	test("extracts the four sections from a promoted HTML body", () => {
		const t = parseTier2(PROMOTED);
		expect(t.description).toContain("Original triage description");
		expect(t.acceptanceCriteria).toContain("bun test tests/auth.test.ts");
		// First-match-wins: the real Tier-2 acceptance test, NOT the Tier-1 narrative line above it.
		expect(t.acceptanceCriteria).not.toContain("NARRATIVE");
		expect(t.verification).toContain("bun run check && bun test"); // entities decoded
		expect(t.scope).toContain("Allowed:");
		expect(t.scope).toContain("Denied:");
	});

	test("a bare body (no tiers) becomes the description; other fields empty", () => {
		const t = parseTier2("<p>Just a plain issue with no schema.</p>");
		expect(t.description).toBe("Just a plain issue with no schema.");
		expect(t.acceptanceCriteria).toBe("");
		expect(t.verification).toBe("");
		expect(t.scope).toBe("");
	});

	test("markdown-heading bodies parse via the fallback", () => {
		const t = parseTier2("intro line\n\n## Acceptance Test\nrun it\n\n## Scope\nsrc only");
		expect(t.description).toBe("intro line");
		expect(t.acceptanceCriteria).toBe("run it");
		expect(t.scope).toBe("src only");
	});

	test("empty / whitespace never throws", () => {
		expect(parseTier2("")).toEqual({ description: "", acceptanceCriteria: "", verification: "", scope: "" });
		expect(parseTier2("   ")).toEqual({ description: "", acceptanceCriteria: "", verification: "", scope: "" });
	});
});
