/**
 * Tier-0 deterministic code-fix pass: applyCodefixes runs TypeScript's own auto-import code-fix over
 * a project, resolving a "cannot find name" (2304) by inserting the missing local import — no AI, no
 * node_modules. Hermetic: a throwaway project with a local module keeps the test self-contained.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyCodefixes } from "../src/workflow/codefix.ts";

test("applyCodefixes auto-imports a local export to resolve a cannot-find-name (2304)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codefix-"));
	try {
		fs.writeFileSync(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "bundler", target: "ESNext", skipLibCheck: true } }),
		);
		fs.writeFileSync(path.join(dir, "a.ts"), "export const foo = 1;\n");
		fs.writeFileSync(path.join(dir, "b.ts"), "export const bar = foo + 1;\n"); // uses foo with no import ⇒ TS2304

		const result = applyCodefixes(dir);

		expect(result.fixed).toBeGreaterThanOrEqual(1);
		const fixed = fs.readFileSync(path.join(dir, "b.ts"), "utf8");
		expect(fixed).toMatch(/import\s*\{\s*foo\s*\}\s*from\s*['"]\.\/a['"]/); // the missing local import was inserted
		expect(fixed).toContain("export const bar = foo + 1;"); // original usage preserved
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("applyCodefixes is a best-effort no-op when there is no tsconfig", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codefix-empty-"));
	try {
		expect(applyCodefixes(dir)).toEqual({ fixed: 0, files: 0 });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
