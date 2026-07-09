/**
 * Feature assignees — the human "who owns this feature" list and the substrate for plan voting
 * (a later vote is majority-of-all-assignees). Covers: default-seed on first persist, backward-compat
 * parse of a feature persisted before the field existed, the mode-aware PUT validation
 * (reject a non-org-member in DB mode; file mode collapses to the operator), and the manager's
 * get/set round-trip (incl. adopting a plan-derived feature).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFeatures } from "../src/features.ts";
import { invalidFileAssignees, invalidOrgAssignees, isVoteAssignee, orgMemberAssigneeId } from "../src/feature-assignees.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor, PersistedFeature } from "../src/types.ts";
import type { OrgMember } from "../src/org-admin.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];
afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

async function tmp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(dir);
	return dir;
}

const members: OrgMember[] = [
	{ userId: "u1", name: "Alice", email: "a@x.com", role: "admin" },
	{ userId: "u2", name: "Bob", email: "b@x.com", role: "member" },
];

// ── mode-aware validation (the PUT gate, extracted so it's unit-testable) ─────────────────────

test("DB mode: rejects a non-org-member id, accepts real members, empty is valid", () => {
	expect(orgMemberAssigneeId(members[0]!)).toBe("db:u1");
	// all real members → nothing rejected
	expect(invalidOrgAssignees(["db:u1", "db:u2"], members)).toEqual([]);
	// a stranger → rejected, in input order
	expect(invalidOrgAssignees(["db:u1", "db:ghost", "local"], members)).toEqual(["db:ghost", "local"]);
	// clearing the list is allowed
	expect(invalidOrgAssignees([], members)).toEqual([]);
});

test("file mode: the only valid assignee is the operator identity", () => {
	expect(invalidFileAssignees(["local"], "local")).toEqual([]);
	expect(invalidFileAssignees(["local", "db:u1"], "local")).toEqual(["db:u1"]);
	expect(invalidFileAssignees([], "local")).toEqual([]);
});

// ── isVoteAssignee: the plan-vote call/cast membership predicate (mode-aware) ─────────────────

test("isVoteAssignee: DB mode is strict — no fallback for a non-member, even an admin", () => {
	const actor: Actor = { id: "db:u9", origin: "local", role: "admin" };
	expect(isVoteAssignee(actor, ["db:u1", "db:u2"], { dbMode: true, operatorId: "local" })).toBe(false);
	expect(isVoteAssignee(actor, ["db:u9", "db:u2"], { dbMode: true, operatorId: "local" })).toBe(true); // exact match still works
});

test("isVoteAssignee: file mode — THE GAP — a web:admin bearer actor never literally equals the default-seeded operator id, but IS authorized as the operator", () => {
	const actor: Actor = { id: "web:admin", origin: "local", role: "admin" };
	// The default-seeded assignee is the operator's own identity ("local"), never "web:admin" — a
	// literal-id check can NEVER pass here, which is exactly the reported gap.
	expect(["local"].includes(actor.id)).toBe(false);
	expect(isVoteAssignee(actor, ["local"], { dbMode: false, operatorId: "local" })).toBe(true);
});

test("isVoteAssignee: file mode — an operator-tier bearer actor is also authorized as the operator", () => {
	const actor: Actor = { id: "web:operator", origin: "local", role: "operator" };
	expect(isVoteAssignee(actor, ["local"], { dbMode: false, operatorId: "local" })).toBe(true);
});

test("isVoteAssignee: file mode — a viewer-tier bearer actor is never authorized (read-only)", () => {
	const actor: Actor = { id: "web:viewer", origin: "local", role: "viewer" };
	expect(isVoteAssignee(actor, ["local"], { dbMode: false, operatorId: "local" })).toBe(false);
});

test("isVoteAssignee: file mode — an assignee list that ISN'T the operator still 403s (no blanket admin bypass)", () => {
	const actor: Actor = { id: "web:admin", origin: "local", role: "admin" };
	expect(isVoteAssignee(actor, ["someone-else"], { dbMode: false, operatorId: "local" })).toBe(false);
});

test("isVoteAssignee: an exact literal id match wins in either mode (no need to fall through)", () => {
	const actor: Actor = { id: "web:admin", origin: "local", role: "admin" };
	expect(isVoteAssignee(actor, ["web:admin", "db:u2"], { dbMode: false, operatorId: "local" })).toBe(true);
	expect(isVoteAssignee(actor, ["web:admin", "db:u2"], { dbMode: true, operatorId: "local" })).toBe(true);
});

// ── default-seed at build time ────────────────────────────────────────────────────────────────

test("buildFeatures: a persisted feature with stored assignees keeps them verbatim", async () => {
	const repo = await tmp("fa-");
	const pf: PersistedFeature = { id: "f1", title: "X", repo, assignees: ["db:u1", "db:u2"], createdAt: 1, updatedAt: 1 };
	const [f] = await buildFeatures(repo, [], [pf], "local");
	expect(f?.assignees).toEqual(["db:u1", "db:u2"]);
});

test("buildFeatures: a feature persisted BEFORE assignees existed defaults to [operator] (backward-compat)", async () => {
	const repo = await tmp("fa-");
	// No `assignees` key at all — exactly what an old state.json holds.
	const legacy: PersistedFeature = { id: "f1", title: "X", repo, createdAt: 1, updatedAt: 1 };
	const [f] = await buildFeatures(repo, [], [legacy], "db:owner");
	expect(f?.assignees).toEqual(["db:owner"]);
});

test("buildFeatures: an empty stored array also falls back to [operator]", async () => {
	const repo = await tmp("fa-");
	const pf: PersistedFeature = { id: "f1", title: "X", repo, assignees: [], createdAt: 1, updatedAt: 1 };
	const [f] = await buildFeatures(repo, [], [pf], "local");
	expect(f?.assignees).toEqual(["local"]);
});

// ── manager: create seeds, operatorId, get/set round-trip ─────────────────────────────────────

test("createFeature seeds the author as the sole assignee (A=0 is never the default)", async () => {
	const stateDir = await tmp("fa-state-");
	const repo = await tmp("fa-repo-");
	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const pf = mgr.createFeature({ title: "Voting", repo, author: "db:u1" });
	expect(pf.assignees).toEqual(["db:u1"]);
	const got = (await mgr.features(repo)).find((f) => f.id === pf.id);
	expect(got?.assignees).toEqual(["db:u1"]);
});

test("createFeature with no author falls back to the manager's operator identity", async () => {
	const stateDir = await tmp("fa-state-");
	const repo = await tmp("fa-repo-");
	const operator: Actor = { id: "db:owner1", origin: "local", orgId: "org1" };
	const mgr = new SquadManager({ stateDir, operator });
	managers.push(mgr);
	expect(mgr.operatorId).toBe("db:owner1");
	const pf = mgr.createFeature({ title: "Voting", repo });
	expect(pf.assignees).toEqual(["db:owner1"]);
});

test("setAssignees / featureAssignees round-trip, and dedupe", async () => {
	const stateDir = await tmp("fa-state-");
	const repo = await tmp("fa-repo-");
	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const pf = mgr.createFeature({ title: "Voting", repo, author: "local" });

	expect(await mgr.featureAssignees(pf.id, repo)).toEqual(["local"]);

	const saved = await mgr.setAssignees(pf.id, ["db:u1", "db:u2", "db:u1"], repo);
	expect(saved?.assignees).toEqual(["db:u1", "db:u2"]); // deduped, order preserved
	expect(await mgr.featureAssignees(pf.id, repo)).toEqual(["db:u1", "db:u2"]);

	expect(await mgr.featureAssignees("no-such-feature", repo)).toBeUndefined();
});

test("setAssignees adopts a plan-derived feature that isn't persisted yet", async () => {
	const stateDir = await tmp("fa-state-");
	const repo = await tmp("fa-repo-");
	// A plan dir on disk becomes a derived `plan:` feature with no persisted record.
	const planDir = path.join("plans", "vote");
	await fs.mkdir(path.join(repo, planDir), { recursive: true });
	await fs.writeFile(path.join(repo, planDir, "00-overview.md"), "# Vote\nSTATUS: open\n");
	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);

	const derivedId = `plan:${repo}:${planDir}`;
	const before = (await mgr.features(repo)).find((f) => f.id === derivedId);
	expect(before?.persisted).toBeFalsy();
	expect(before?.assignees).toEqual(["local"]); // derived features default to the operator

	const saved = await mgr.setAssignees(derivedId, ["local"], repo);
	expect(saved?.assignees).toEqual(["local"]);
	const after = (await mgr.features(repo)).find((f) => f.id === derivedId);
	expect(after?.persisted).toBe(true); // adopted into the store
	expect(after?.assignees).toEqual(["local"]);
});

// ── manager backward-compat over the real on-disk load path ───────────────────────────────────

test("a legacy state.json feature (no assignees) loads and defaults to the operator identity", async () => {
	const stateDir = await tmp("fa-state-");
	const repo = await tmp("fa-repo-");
	// Hand-write a state.json exactly as an older daemon would have — no `assignees` field.
	const legacy: PersistedFeature = { id: "old-feat", title: "Legacy", repo, createdAt: 5, updatedAt: 5 };
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify({ agents: [], transcripts: {}, features: [legacy] }));
	const operator: Actor = { id: "db:owner1", origin: "local", orgId: "org1" };
	const mgr = new SquadManager({ stateDir, operator });
	managers.push(mgr);
	await mgr.start();
	const got = (await mgr.features(repo)).find((f) => f.id === "old-feat");
	expect(got).toBeDefined();
	expect(got?.assignees).toEqual(["db:owner1"]);
});
