import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The rail's seam: src/rail/index.ts is the lane's interface; the modules inside the directory are
 * implementation. Cloned from tests/memory-lane-boundary.test.ts (glance#335, T7 slice 1 of the
 * rail-extraction design on lmvdz/glance#328). This test freezes the set of files OUTSIDE src/rail/
 * that deep-import rail internals at the set that existed right after the land-ledger + land-risk
 * move — land-risk.ts has NO barrel export by design (its sole consumer, src/land.ts, deep-imports it
 * directly), so that one coupling is seeded here deliberately, not as future debt. A NEW (file ->
 * module) coupling fails here: import from "./rail/index.ts" instead, or consciously extend the
 * allowlist in the same PR that justifies the new internal coupling.
 *
 * Deliberately a set-diff against an explicit allowlist, not a count ratchet: a count lets one
 * removed coupling mask one added elsewhere (the ratchet-drift failure mode).
 */

const ALLOWED = new Set([
	"src/land.ts -> land-risk",
]);

const ROOT = join(import.meta.dir, "..");

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (e === "node_modules" || e === ".git" || e === "dist") continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
	}
	return out;
}

function deepImports(): string[] {
	const hits: string[] = [];
	// The import specifier, not the pathname, is what's matched — so NUL bytes elsewhere in a
	// file (server.ts has them) can't hide an import from a line-based scan.
	const re = /from\s*["'][./]+rail\/([a-z0-9-]+)\.ts["']|import\(\s*["'][./]+rail\/([a-z0-9-]+)\.ts["']\s*\)/g;
	for (const f of walk(join(ROOT, "src"))) {
		const rel = relative(ROOT, f).replace(/\\/g, "/");
		if (rel.startsWith("src/rail/")) continue; // the lane's own internals may deep-import freely
		const text = readFileSync(f, "utf8");
		for (const m of text.matchAll(re)) {
			const mod = m[1] ?? m[2];
			if (mod === "index") continue; // the barrel is the legal target
			hits.push(`${rel} -> ${mod}`);
		}
	}
	return [...new Set(hits)].sort();
}

test("rail: no new deep imports past the src/rail seam", () => {
	const current = deepImports();
	const added = current.filter((h) => !ALLOWED.has(h));
	expect(
		added,
		`new deep import(s) into src/rail internals:\n  ${added.join("\n  ")}\n` +
			`Import from "src/rail/index.ts" (the lane's interface) instead — or, if the internal ` +
			`coupling is genuinely deliberate, extend the allowlist in this test in the same PR.`,
	).toEqual([]);
});

test("rail: allowlist entries that no longer exist get removed (ratchet down)", () => {
	const current = new Set(deepImports());
	const stale = [...ALLOWED].filter((a) => !current.has(a));
	expect(
		stale,
		`allowlisted deep imports no longer exist — delete them from ALLOWED so they can't come back:\n  ${stale.join("\n  ")}`,
	).toEqual([]);
});
