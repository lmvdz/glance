/**
 * Path-ownership partition — pure logic that decides whether a new spawn may touch
 * the same files as a live agent. No processes, no git: just the prefix-overlap rules
 * create() enforces before cutting a worktree.
 */

import { expect, test } from "bun:test";
import { type Owner, isWithinAny, outOfScopeWrites, ownershipConflict, ownershipOverlap, producesAllowlist, requiresConflict } from "../src/ownership.ts";

test("ownershipOverlap: exact, nested (both ways), and normalized slashes hit", () => {
	expect(ownershipOverlap(["src/web"], ["src/web"])).toEqual(["src/web"]);
	// parent owns the dir, newcomer wants a file inside it
	expect(ownershipOverlap(["src/web/index.html"], ["src/web"])).toEqual(["src/web/index.html"]);
	// newcomer owns the dir, holder has a file inside it
	expect(ownershipOverlap(["src/web"], ["src/web/index.html"])).toEqual(["src/web"]);
	// leading/trailing slashes are stripped before comparing
	expect(ownershipOverlap(["/src/web/"], ["src/web"])).toEqual(["src/web"]);
});

test("ownershipOverlap: siblings and segment-prefix lookalikes do NOT overlap", () => {
	expect(ownershipOverlap(["src/server.ts"], ["src/web"])).toEqual([]);
	// "src/web" must not match "src/webhooks" — containment is segment-safe
	expect(ownershipOverlap(["src/webhooks"], ["src/web"])).toEqual([]);
	expect(ownershipOverlap(["src/web"], ["src/webhooks"])).toEqual([]);
});

test("ownershipOverlap: empty/whitespace-only claims never overlap", () => {
	expect(ownershipOverlap([], ["src/web"])).toEqual([]);
	expect(ownershipOverlap(["src/web"], [])).toEqual([]);
	expect(ownershipOverlap(["  "], ["src/web"])).toEqual([]);
});

test("ownershipOverlap: canonicalization defeats ./ .. dup-slash and case evasion", () => {
	// every spelling below resolves to the same prefix as the holder's "src/web"
	expect(ownershipOverlap(["./src/web"], ["src/web"])).toEqual(["src/web"]);
	expect(ownershipOverlap(["src//web"], ["src/web"])).toEqual(["src/web"]);
	expect(ownershipOverlap(["src/x/../web"], ["src/web"])).toEqual(["src/web"]);
	expect(ownershipOverlap(["SRC/Web"], ["src/web"])).toEqual(["src/web"]);
	expect(ownershipOverlap(["./SRC//x/..//web/"], ["src/web"])).toEqual(["src/web"]);
	// holder side is canonicalized too
	expect(ownershipOverlap(["src/web"], ["./SRC//web/"])).toEqual(["src/web"]);
	// `..` clamps at root rather than escaping it
	expect(ownershipOverlap(["../../src/web"], ["src/web"])).toEqual(["src/web"]);
});

const owner = (over: Partial<Owner> = {}): Owner => ({ repo: "/r", name: "alpha", status: "working", owns: ["src/web"], ...over });

test("ownershipConflict: a live overlapping agent blocks the spawn and names paths", () => {
	const c = ownershipConflict([owner()], "/r", ["src/web/index.html"]);
	expect(c).toEqual({ agent: "alpha", paths: ["src/web/index.html"] });
});

test("ownershipConflict: disjoint paths, other repo, or no requester claim → allowed", () => {
	expect(ownershipConflict([owner()], "/r", ["src/server.ts"])).toBeUndefined();
	expect(ownershipConflict([owner({ repo: "/other" })], "/r", ["src/web"])).toBeUndefined();
	expect(ownershipConflict([owner()], "/r", [])).toBeUndefined();
});

test("ownershipConflict: a terminal (stopped/error) or claimless holder doesn't block", () => {
	expect(ownershipConflict([owner({ status: "stopped" })], "/r", ["src/web"])).toBeUndefined();
	expect(ownershipConflict([owner({ status: "error" })], "/r", ["src/web"])).toBeUndefined();
	expect(ownershipConflict([owner({ owns: undefined })], "/r", ["src/web"])).toBeUndefined();
	expect(ownershipConflict([owner({ owns: [] })], "/r", ["src/web"])).toBeUndefined();
});

test("ownershipConflict: returns the FIRST overlapping holder among many", () => {
	const live: Owner[] = [owner({ name: "idle-other", owns: ["docs"] }), owner({ name: "beta", owns: ["src/web/app"] })];
	expect(ownershipConflict(live, "/r", ["src/web"])?.agent).toBe("beta");
});

test("requiresConflict: read deps are blocked by live owns or produces writes", () => {
	expect(requiresConflict([owner()], "/r", ["src/web/config.ts"])).toEqual({ agent: "alpha", paths: ["src/web/config.ts"] });
	expect(requiresConflict([owner({ owns: undefined, produces: ["generated/api"] })], "/r", ["generated/api/types.ts"])).toEqual({ agent: "alpha", paths: ["generated/api/types.ts"] });
});

test("requiresConflict: read deps ignore read-only, terminal, and disjoint agents", () => {
	expect(requiresConflict([owner({ owns: undefined, requires: ["src/web"] })], "/r", ["src/web"])).toBeUndefined();
	expect(requiresConflict([owner({ status: "stopped" })], "/r", ["src/web"])).toBeUndefined();
	expect(requiresConflict([owner()], "/r", ["src/server.ts"])).toBeUndefined();
	expect(requiresConflict([owner()], "/other", ["src/web"])).toBeUndefined();
	expect(requiresConflict([owner()], "/r", [])).toBeUndefined();
});

// ── produces audit (concern 08) ──────────────────────────────────────────────

test("isWithinAny: a file is in scope only when under a declared prefix (segment-safe)", () => {
	expect(isWithinAny("src/web/app.tsx", ["src/web"])).toBe(true);
	expect(isWithinAny("src/web", ["src/web"])).toBe(true); // the prefix itself
	expect(isWithinAny("src/webapp/x.ts", ["src/web"])).toBe(false); // sibling lookalike, not nested
	expect(isWithinAny("src/server.ts", ["src/web", "docs"])).toBe(false);
	expect(isWithinAny("SRC/Web/app.ts", ["src/web"])).toBe(true); // case + normalization
});

test("outOfScopeWrites: flags only real writes outside declared produces, minus the allowlist", () => {
	const allow = producesAllowlist();
	const actual = ["src/web/app.tsx", "src/server.ts", "package.json", "bun.lock"];
	// declared = src/web ⇒ server.ts is out of scope; lockfile + package.json are allowlisted.
	expect(outOfScopeWrites(actual, ["src/web"], allow)).toEqual(["src/server.ts"]);
});

test("outOfScopeWrites: no declared scope ⇒ never flags (can't exceed a scope you never declared)", () => {
	expect(outOfScopeWrites(["src/anything.ts"], [], producesAllowlist())).toEqual([]);
});

test("outOfScopeWrites: everything in scope ⇒ empty", () => {
	expect(outOfScopeWrites(["src/web/a.ts", "src/web/b.ts"], ["src/web"], producesAllowlist())).toEqual([]);
});

test("producesAllowlist: OMP_SQUAD_PRODUCES_ALLOW extends the defaults (basename match)", () => {
	const allow = producesAllowlist("codegen/schema.ts, .env.example");
	expect(outOfScopeWrites(["codegen/schema.ts", "src/x.ts"], ["src/web"], allow)).toEqual(["src/x.ts"]);
});
