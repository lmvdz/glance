import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/web/feedback-widget.js", import.meta.url), "utf8");

test("feedback widget posts only to public intake and has no privileged strings", () => {
	expect(source).toContain("window.FeedbackLoop");
	expect(source).toContain("getDisplayMedia");
	expect(source).toContain("/api/feedback/items");

	const forbidden = [
		/\badmin\b/i,
		/\boperator\b/i,
		/\bsecret\b/i,
		/\bprivate[_-]?key\b/i,
		/\bapi[_-]?key\b/i,
		/bearer\s+/i,
		/\/admin\b/i,
		/\/operator\b/i,
		/\/api\/(?!feedback\/items\b)[^"'`\s)]*/i,
	];

	for (const pattern of forbidden) {
		expect(source.match(pattern)?.[0]).toBeUndefined();
	}
});

test("feedback widget remains a self-contained browser script with expected intake fields", () => {
	expect(source).not.toMatch(/^\s*import\s/m);
	expect(source).not.toContain("require(");
	expect(source).toContain("data-campaign");
	expect(source).toContain("data-token");
	expect(source).toContain("identify = function");
	expect(source).toContain("screenshotDataUrl");
	expect(source).toContain("metadata: metadata");
	expect(source).toContain("JSON.stringify(payload)");
});
