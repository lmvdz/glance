/**
 * Path-ownership partition — pure logic that decides whether a new spawn may touch
 * the same files as a live agent. No processes, no git: just the prefix-overlap rules
 * create() enforces before cutting a worktree.
 */

import { expect, test } from "bun:test";
import { type GoalOwner, type Owner, goalConflict, goalConflicts, isWithinAny, outOfScopeWrites, ownershipConflict, ownershipOverlap, producesAllowlist, requiresConflict } from "../src/ownership.ts";

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

test("ownershipConflict: a holder that declared writes via produces (owns undefined) still blocks", () => {
	// The live spawn path stores agents produces-first (create() sets produces = opts.produces ?? opts.owns,
	// owns = opts.owns verbatim), so a modern scope has owns undefined. The write-vs-write guard must resolve
	// produces like requiresConflict does, or two agents write the same tree — the collision it exists to stop.
	const holder = owner({ owns: undefined, produces: ["src/web"] });
	expect(ownershipConflict([holder], "/r", ["src/web/index.html"])).toEqual({ agent: "alpha", paths: ["src/web/index.html"] });
	// produces takes precedence over owns when both are present (matches requiresConflict's resolution)
	const both = owner({ owns: ["docs"], produces: ["src/web"] });
	expect(ownershipConflict([both], "/r", ["src/web/app.ts"])).toEqual({ agent: "alpha", paths: ["src/web/app.ts"] });
	expect(ownershipConflict([both], "/r", ["docs/readme.md"])).toBeUndefined(); // owns is NOT the write claim when produces is set
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

const goalOwner = (over: Partial<GoalOwner> = {}): GoalOwner => ({
	repo: "/r",
	name: "private-team",
	status: "working",
	goal: "Build request throttling controls",
	...over,
});

test("goalConflict: semantically equivalent goals conflict without shared paths", () => {
	const conflict = goalConflict(
		[goalOwner()],
		{ repo: "/r", name: "new-team", status: "working", goal: "Implement rate limiting" },
	);
	expect(conflict).toEqual({ agent: "private-team", strength: "semantic" });
});

test("goalConflict: BM25 catches a lower-overlap lexical duplicate", () => {
	const conflict = goalConflict(
		[goalOwner({ goal: "Build billing invoice reconciliation dashboard" })],
		{ repo: "/r", name: "new-team", status: "working", goal: "Implement billing invoice worker monitoring" },
	);
	expect(conflict).toEqual({ agent: "private-team", strength: "bm25" });
});

test("goalConflict: disclosure names the owner without leaking private work content", () => {
	const privateGoal = "Replace the confidential acquisition pricing rules";
	const result = goalConflict(
		[goalOwner({ name: "legal-owner", goal: privateGoal, issueRefs: ["matter-42"] })],
		{ repo: "/r", name: "requester", status: "working", issueRefs: ["matter-42"] },
	);
	expect(result).toEqual({ agent: "legal-owner", strength: "structural" });
	expect(JSON.stringify(result)).not.toContain(privateGoal);
	expect(JSON.stringify(result)).not.toContain("matter-42");
	expect(JSON.stringify(result)).not.toContain("goal");
});

test("goalConflicts: structural declarations outrank semantic matches", () => {
	const conflicts = goalConflicts(
		[
			goalOwner({ name: "semantic-owner", goal: "Implement request throttling" }),
			goalOwner({ name: "structural-owner", goal: "Unrelated work", produces: ["src/rate-limit.ts"] }),
		],
		{ repo: "/r", name: "requester", status: "working", goal: "Implement rate limiting", produces: ["src/rate-limit.ts"] },
	);
	expect(conflicts).toEqual([
		{ agent: "structural-owner", strength: "structural" },
		{ agent: "semantic-owner", strength: "semantic" },
	]);
});

test("goalConflict: known duplicate naming corpus has no false negatives", () => {
	const duplicates: Array<[string, string]> = [
		["Implement rate limiting", "Build request throttling controls"],
		["Add authentication to the API", "Implement API authorization"],
		["Create a billing webhook retry queue", "Build retry queue for billing webhooks"],
	];
	for (const [first, second] of duplicates) {
		expect(goalConflict([goalOwner({ goal: first })], { repo: "/r", name: "requester", status: "working", goal: second })?.agent).toBe("private-team");
	}
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

test("goalConflict: unrelated goals in the same repo do NOT conflict", () => {
	// The missing half of concern 05's verify list. It asks for a false-NEGATIVE corpus and says
	// nothing about false positives — but this mechanism BLOCKS unit creation, so a false positive is
	// the expensive failure: you cannot spawn the work at all, and there is no way around it from
	// outside the code. A detector tuned only against misses will refuse everything.
	const live: GoalOwner[] = [
		{ name: "wren", repo: "/r", status: "working", goal: "add request rate limiting to the public API" },
		{ name: "pike", repo: "/r", status: "working", goal: "write an Effect service layer for the ingest pipeline" },
		{ name: "ash", repo: "/r", status: "working", goal: "fix the flaky restart-reattach test" },
	];
	const unrelated = [
		"add a dark theme to the settings page",
		"upgrade the sqlite driver to the current release",
		"document the deployment runbook for new operators",
		"reduce the docker image size for the gate container",
		"add keyboard navigation to the command palette",
		"write an Effect schema for the deployment config",
		"fix a memory leak in the transcript renderer",
	];
	for (const goal of unrelated) {
		expect(goalConflict(live, { name: "new", repo: "/r", status: "working", goal })).toBeUndefined();
	}
});

test("goalConflict: a different repo is never a conflict, however similar the goal", () => {
	// Two people building the same thing in two different repositories are not duplicating each other.
	const live: GoalOwner[] = [{ name: "wren", repo: "/a", status: "working", goal: "add request rate limiting to the public API" }];
	expect(goalConflict(live, { name: "new", repo: "/b", status: "working", goal: "add request rate limiting to the public API" })).toBeUndefined();
});

test("goalConflict: a stopped or errored owner releases its goal, a finished one does not", () => {
	// Matches the sibling path primitive exactly: stopped and error release, everything else holds.
	// `done` deliberately still holds — a finished-but-unlanded unit owns its goal until it lands or is
	// reaped off the roster, and someone starting the same work meanwhile IS duplicating it.
	const goal = "add request rate limiting to the public API";
	for (const status of ["stopped", "error"] as const) {
		expect(goalConflict([{ name: "wren", repo: "/r", status, goal }], { name: "new", repo: "/r", status: "working", goal })).toBeUndefined();
	}
	expect(goalConflict([{ name: "wren", repo: "/r", status: "done", goal }], { name: "new", repo: "/r", status: "working", goal })).toMatchObject({ agent: "wren" });
});

test("goalConflict: a goal too short to judge is not a conflict", () => {
	// One or two words carries no evidence. Refusing on it would be refusing on nothing.
	const live: GoalOwner[] = [{ name: "wren", repo: "/r", status: "working", goal: "rate limiting" }];
	for (const goal of ["fix it", "rate", ""]) {
		expect(goalConflict(live, { name: "new", repo: "/r", status: "working", goal })).toBeUndefined();
	}
});

test("goalConflict: two ordinary tracker issues in one repo do not collide", () => {
	// The regression this pins. The dispatcher spawns units from Plane issues, and its own fixture pair
	// — "issue a / spec a" and "issue b / spec b" — scored 0.67 against each other and blocked the
	// second spawn. Three dispatcher tests hung on it. The fleet's entire job is running many units in
	// one repo, so any check that refuses on this shape is unusable regardless of how it is tuned.
	const live: GoalOwner[] = [{ name: "wren", repo: "/r", status: "working", goal: "issue a\n\nspec a" }];
	expect(goalConflict(live, { name: "new", repo: "/r", status: "working", goal: "issue b\n\nspec b" })?.strength).not.toBe("structural");
});

test("goalConflicts: structural overlap is exact, fuzzy overlap is a heuristic — only one may block", () => {
	// The split the manager relies on. A shared declared reference is exact and blocks a spawn, exactly
	// as ownershipConflict already blocks on shared paths. Semantic and BM25 similarity over two short
	// strings is a guess, and a guess must not be able to refuse work outright — it discloses instead.
	const structural: GoalOwner[] = [{ name: "wren", repo: "/r", status: "working", goal: "unrelated words entirely", planRefs: ["plan-7"] }];
	expect(goalConflict(structural, { name: "new", repo: "/r", status: "working", goal: "nothing alike here", planRefs: ["plan-7"] })?.strength).toBe("structural");

	const fuzzy: GoalOwner[] = [{ name: "wren", repo: "/r", status: "working", goal: "add request rate limiting to the public API" }];
	const hit = goalConflict(fuzzy, { name: "new", repo: "/r", status: "working", goal: "build request throttling controls for the API" });
	expect(hit?.strength).toBe("semantic");
	// Whatever the strength, the disclosure carries the owner and nothing else — asserted, not assumed.
	expect(Object.keys(hit ?? {}).sort()).toEqual(["agent", "strength"]);
});
