/**
 * Path-ownership partition — pure logic that decides whether a new spawn may touch
 * the same files as a live agent. No processes, no git: just the prefix-overlap rules
 * create() enforces before cutting a worktree.
 */

import { expect, test } from "bun:test";
import { type Owner, ownershipConflict, ownershipOverlap } from "../src/ownership.ts";

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
