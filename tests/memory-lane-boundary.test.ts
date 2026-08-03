import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The memory lane's seam: src/memory/index.ts is the lane's interface; the modules inside
 * the directory are implementation. This test freezes the set of files OUTSIDE src/memory/
 * that deep-import lane internals at the set that existed when the lane got its directory
 * (the mechanical move deliberately did not rewire consumers through the barrel — that
 * migration shrinks this list module-by-module). A NEW (file -> module) coupling fails here:
 * import from "./memory/index.ts" instead, or consciously extend the allowlist in the same
 * PR that justifies the new internal coupling.
 *
 * Deliberately a set-diff against an explicit allowlist, not a count ratchet: a count lets
 * one removed coupling mask one added elsewhere (the ratchet-drift failure mode).
 */

const ALLOWED = new Set([
	"src/agent-records.ts -> node-records",
	"src/archive.ts -> node-records",
	"src/channels.ts -> digest",
	"src/chat-attachment.ts -> digest",
	"src/dal/store.ts -> node-records",
	"src/dal/store.ts -> nodes",
	"src/doctor.ts -> fabric-search",
	"src/index.ts -> fabric-search",
	"src/index.ts -> symptoms",
	"src/instructions.ts -> node-records",
	"src/landed-context.ts -> digest",
	"src/opportunity.ts -> fabric",
	"src/ownership.ts -> fabric-search",
	"src/plan-motion.ts -> node-records",
	"src/pr-body.ts -> symptoms",
	"src/promote.ts -> answers",
	"src/rule-proposals.ts -> node-records",
	"src/server.ts -> fabric",
	"src/server.ts -> fabric-search",
	"src/server.ts -> symptoms",
	"src/server.ts -> weekly-episode",
	"src/squad-manager.ts -> after-action",
	"src/squad-manager.ts -> answers",
	"src/squad-manager.ts -> decision-evidence",
	"src/squad-manager.ts -> decision-impact",
	"src/squad-manager.ts -> digest",
	"src/squad-manager.ts -> fabric",
	"src/squad-manager.ts -> fabric-search",
	"src/squad-manager.ts -> failure-memory",
	"src/squad-manager.ts -> node-records",
	"src/squad-manager.ts -> node-summaries",
	"src/squad-manager.ts -> nodes",
	"src/squad-manager.ts -> symptoms",
	"src/squad-manager.ts -> weekly-episode",
	"src/unknowns.ts -> node-records",
	"src/workflow/executor.ts -> digest",
	"src/workflow/executor.ts -> failure-memory",
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
	const re = /from\s*["'][./]+memory\/([a-z0-9-]+)\.ts["']|import\(\s*["'][./]+memory\/([a-z0-9-]+)\.ts["']\s*\)/g;
	for (const f of walk(join(ROOT, "src"))) {
		const rel = relative(ROOT, f).replace(/\\/g, "/");
		if (rel.startsWith("src/memory/")) continue; // the lane's own internals may deep-import freely
		const text = readFileSync(f, "utf8");
		for (const m of text.matchAll(re)) {
			const mod = m[1] ?? m[2];
			if (mod === "index") continue; // the barrel is the legal target
			hits.push(`${rel} -> ${mod}`);
		}
	}
	return [...new Set(hits)].sort();
}

test("memory lane: no new deep imports past the src/memory seam", () => {
	const current = deepImports();
	const added = current.filter((h) => !ALLOWED.has(h));
	expect(
		added,
		`new deep import(s) into src/memory internals:\n  ${added.join("\n  ")}\n` +
			`Import from "src/memory/index.ts" (the lane's interface) instead — or, if the internal ` +
			`coupling is genuinely deliberate, extend the allowlist in this test in the same PR.`,
	).toEqual([]);
});

test("memory lane: allowlist entries that no longer exist get removed (ratchet down)", () => {
	const current = new Set(deepImports());
	const stale = [...ALLOWED].filter((a) => !current.has(a));
	expect(
		stale,
		`allowlisted deep imports no longer exist — delete them from ALLOWED so they can't come back:\n  ${stale.join("\n  ")}`,
	).toEqual([]);
});
