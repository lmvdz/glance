/**
 * Web smoke gate — the dashboard (`src/web/index.html`) is a single inline-script SPA, and
 * `tsc` does NOT check it (it's HTML, not TypeScript). A malformed edit to that 1000-line script
 * otherwise ships silently and white-screens the dashboard at runtime.
 *
 * This asserts the inline <script> at least PARSES as valid JS (zero browser deps — runtime/DOM
 * behavior stays the job of the manual browser smoke). It's the automated floor `tsc` can't give.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const INDEX = path.join(import.meta.dir, "..", "src", "web", "index.html");

test("web/index.html inline scripts parse as valid JS", async () => {
	const html = await fs.readFile(INDEX, "utf8");
	const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((s) => s.trim().length > 0);
	expect(scripts.length).toBeGreaterThan(0);

	const transpiler = new Bun.Transpiler({ loader: "js" });
	for (const code of scripts) {
		// transformSync throws on a syntax error, failing the gate with the location.
		transpiler.transformSync(code);
	}

	// Guard against a catastrophic truncation/emptying of the app script.
	const total = scripts.reduce((n, s) => n + s.length, 0);
	expect(total).toBeGreaterThan(5000);
});
