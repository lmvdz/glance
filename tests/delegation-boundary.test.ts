import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import {
	DelegationBoundaryError,
	assertHumanAuthority,
	boundaryJustification,
	classifiedActions,
	grantFor,
	nonDelegatableClassOf,
	nonDelegatableClasses,
	type DelegationGrant,
} from "../src/delegation-boundary.ts";
import { NodeRecordStore } from "../src/node-records.ts";
import { SquadManager } from "../src/squad-manager.ts";

function grant(action: string, over: Partial<DelegationGrant> = {}): DelegationGrant {
	const cls = nonDelegatableClassOf(action);
	if (!cls) throw new Error(`${action} is not in the class`);
	return { id: `grant:${action}`, action, class: cls, grantedBy: "db:lars", grantedAt: 1, reason: "I want merges to land without me.", ...over };
}

test("autonomy cannot take a non-delegatable action without a grant", () => {
	for (const action of ["land", "landFeature", "remove", "deleteFeature", "disburseReward"]) {
		expect(() => assertHumanAuthority(action, "autonomous", [])).toThrow(DelegationBoundaryError);
		// The same action by a person is never blocked — this boundary is about autonomy, not authority.
		expect(() => assertHumanAuthority(action, "human", [])).not.toThrow();
	}
});

test("a grant opens exactly one action and nothing adjacent", () => {
	const grants = [grant("land")];
	expect(() => assertHumanAuthority("land", "autonomous", grants)).not.toThrow();
	// Same class, different action: publishing a feature is a separate decision from landing a unit.
	expect(() => assertHumanAuthority("landFeature", "autonomous", grants)).toThrow(DelegationBoundaryError);
	// Different class entirely.
	expect(() => assertHumanAuthority("deleteFeature", "autonomous", grants)).toThrow(DelegationBoundaryError);
});

test("a revoked grant is not a grant", () => {
	const revoked = [grant("land", { revokedAt: 99, revokedBy: "db:lars" })];
	expect(() => assertHumanAuthority("land", "autonomous", revoked)).toThrow(DelegationBoundaryError);
	expect(grantFor("land", revoked)).toBeUndefined();
});

test("a forged grant for a class the action is not in does not carry", () => {
	// The action is publishing; the row claims deletion. Matching on action alone would let a grant
	// written for one purpose authorise another.
	const mismatched: DelegationGrant[] = [{ ...grant("land"), class: "deletion" }];
	expect(() => assertHumanAuthority("land", "autonomous", mismatched)).toThrow(DelegationBoundaryError);
});

test("every member of the class carries a justification written for a person", () => {
	for (const cls of nonDelegatableClasses) {
		const justification = boundaryJustification[cls];
		expect(justification).toBeTruthy();
		// The standing rule: a string that only names a state is unfinished. Each of these has to say
		// what it means, not just that the class exists.
		expect(justification.length).toBeGreaterThan(60);
		expect(justification).not.toBe(cls);
	}
});

test("the refusal states its blast radius", () => {
	const err = new DelegationBoundaryError("land", "publishing");
	expect(err.message).toContain("needs a person");
	// Every interruption answers the anxious question before it is asked.
	expect(err.message).toContain("Nothing else in the fleet is affected");
	expect(err.message).toContain(boundaryJustification.publishing);
});

test("every command type is classified — a new action cannot open a silent hole", () => {
	// This is the test that matters most in this file. The map is only a boundary if nothing can be
	// added beside it without a decision. Every ClientCommand type must be explicitly delegatable or
	// explicitly not; adding one without saying which fails here rather than defaulting to permitted.
	const commandTypes = [
		"snapshot", "subscribe", "typing", "prompt", "answer", "interrupt", "message", "notify",
		"create", "commission", "set-mode", "set-model", "kill", "restart", "fork", "continue", "remove",
	];
	const classified = new Set(classifiedActions());
	expect(commandTypes.filter((type) => !classified.has(type))).toEqual([]);
	// And the manager actions that are not commands.
	for (const action of ["land", "landFeature", "deleteFeature", "disburseReward"]) expect(classified.has(action)).toBe(true);
});

test("an unclassified action is refused, not permitted — nobody-decided is not allowed", () => {
	const all = classifiedActions();
	expect(all).not.toContain("something-nobody-has-considered");
	// The fail-closed branch: autonomy attempting an action nobody has classified is refused outright,
	// so adding a capability without deciding its class cannot quietly grant it.
	expect(() => assertHumanAuthority("something-nobody-has-considered", "autonomous", [])).toThrow(DelegationBoundaryError);
	// A person is still unaffected — this boundary constrains autonomy, never authority.
	expect(() => assertHumanAuthority("something-nobody-has-considered", "human", [])).not.toThrow();
	// No action is both delegatable and not.
	expect(new Set(all).size).toBe(all.length);
});

test("a rule that names a non-delegatable action is refused at creation, not at invocation", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-rules-"));
	const store = new FileStore(dir);
	await store.putNode({ id: "n1", kind: "unit", title: "unit", state: "working", createdAt: 1, channelId: null });
	const records = new NodeRecordStore(store);
	const rule = {
		kind: "rule" as const,
		id: "r1",
		nodeId: "n1",
		createdAt: 1,
		sentence: "Just merge things when the tests pass.",
		authorId: "db:lars",
		scope: "org" as const,
		settles: ["land"],
		status: "active" as const,
		proposedFrom: ["decision-1"],
		wouldNotHaveCaught: [],
		invocations: [],
	};
	// One test per member of the class, per concern 12's own verify list.
	for (const [action, cls] of [["land", "publishing"], ["deleteFeature", "deletion"], ["disburseReward", "spend"]] as const) {
		await expect(records.put({ ...rule, settles: [action] })).rejects.toThrow(new RegExp(`cannot settle ${action}[\\s\\S]*${cls}`));
	}
	// A rule that settles something ordinary is fine — once its cited evidence actually exists.
	await records.put({ kind: "decision", id: "decision-1", nodeId: "n1", createdAt: 1, question: "Take the reversible option?", options: ["yes", "no"], chose: "yes", decidedBy: "db:lars", askedAt: 1, decidedAt: 2, reason: "no-rule-applied" });
	await records.put({ ...rule, settles: ["reversible-change"] });
	expect(await records.mayRuleSettle("n1", "reversible-change")).toBe(true);
	// And even had one existed, evaluation refuses the class too — belt and braces, because the
	// creation check protects new rules and this protects any that predate it.
	expect(await records.mayRuleSettle("n1", "reversible-change", "publishing")).toBe(false);
	await fs.rm(dir, { recursive: true, force: true });
});

test("grants persist and revocation survives a reread", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-grants-"));
	const store = new FileStore(dir);
	expect(await store.listDelegationGrants()).toEqual([]);

	await store.putDelegationGrant(grant("land"));
	const [read] = await store.listDelegationGrants();
	expect(read).toEqual(grant("land"));
	expect(() => assertHumanAuthority("land", "autonomous", [read!])).not.toThrow();

	await store.putDelegationGrant({ ...grant("land"), revokedAt: 500, revokedBy: "db:lars" });
	const after = await store.listDelegationGrants();
	expect(after).toHaveLength(1);
	expect(after[0]?.revokedAt).toBe(500);
	// Who granted it is still there after revocation — both halves are history.
	expect(after[0]?.grantedBy).toBe("db:lars");
	expect(() => assertHumanAuthority("land", "autonomous", after)).toThrow(DelegationBoundaryError);
	await fs.rm(dir, { recursive: true, force: true });
});

test("a half-written grant row is not a grant", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-halfwritten-"));
	const store = new FileStore(dir);
	// No `reason`, and a class that is not a member. Either alone must disqualify it, because the only
	// thing standing between autonomy and a publish is this row decoding.
	await fs.writeFile(path.join(dir, "delegation-grants.json"), JSON.stringify([
		{ id: "g1", action: "land", class: "publishing", grantedBy: "db:lars", grantedAt: 1 },
		{ id: "g2", action: "land", class: "not-a-class", grantedBy: "db:lars", grantedAt: 1, reason: "x" },
	]));
	expect(await store.listDelegationGrants()).toEqual([]);
	await fs.rm(dir, { recursive: true, force: true });
});

// --- The manager, where the boundary is actually enforced -------------------------------------

async function manager(autoLand: boolean): Promise<{ mgr: SquadManager; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-mgr-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-wt-"));
	const mgr = new SquadManager({ stateDir: dir, worktreeBase, autoLand });
	await mgr.start();
	return { mgr, dir };
}

test("an autonomous land is refused before it touches anything, and a grant lets it through", async () => {
	const { mgr, dir } = await manager(false);
	// No agent exists. The boundary check is the FIRST thing land does, so the refusal must be the
	// boundary error rather than "no such agent" — enforcement before work, not after.
	await expect(mgr.land("nobody", "msg", { auto: true })).rejects.toThrow(DelegationBoundaryError);
	// A human landing the same thing is never stopped by this boundary.
	await expect(mgr.land("nobody", "msg")).resolves.toBeDefined();

	await mgr.grantDelegation({ action: "land", grantedBy: "db:lars", reason: "Merges can land without me when the gate is green." });
	// Past the boundary now: whatever happens next, it is not a boundary refusal.
	await expect(mgr.land("nobody", "msg", { auto: true })).resolves.toBeDefined();
	await mgr.stop();
	await fs.rm(dir, { recursive: true, force: true });
});

test("a grant records who and why, and refuses to be anonymous", async () => {
	const { mgr, dir } = await manager(false);
	await expect(mgr.grantDelegation({ action: "land", grantedBy: "  ", reason: "x" })).rejects.toThrow(/who made it/);
	await expect(mgr.grantDelegation({ action: "land", grantedBy: "db:lars", reason: "   " })).rejects.toThrow(/why it was made/);
	// And an action that is not in the class needs no grant, so asking for one is a mistake worth naming.
	await expect(mgr.grantDelegation({ action: "prompt", grantedBy: "db:lars", reason: "x" })).rejects.toThrow(/needs no grant/);

	const granted = await mgr.grantDelegation({ action: "land", grantedBy: "db:lars", reason: "Green gate is enough for me." });
	expect(granted.grantedBy).toBe("db:lars");
	expect(granted.reason).toBe("Green gate is enough for me.");
	expect(granted.class).toBe("publishing");
	await mgr.stop();
	await fs.rm(dir, { recursive: true, force: true });
});

test("the autoland configuration becomes an attributable grant instead of an anonymous default", async () => {
	const { mgr, dir } = await manager(true);
	const grants = await mgr.delegationGrants();
	expect(grants).toHaveLength(1);
	expect(grants[0]?.action).toBe("land");
	// It does not pretend a person typed it — it says where it came from.
	expect(grants[0]?.grantedBy).toContain("OMP_SQUAD_AUTOLAND");
	expect(grants[0]?.reason).toContain("before grants existed");
	await expect(mgr.land("nobody", "msg", { auto: true })).resolves.toBeDefined();
	await mgr.stop();
	await fs.rm(dir, { recursive: true, force: true });
});

test("revoking the autoland grant survives a restart — a restart must not undo a human", async () => {
	// The sharpest failure this could have: a person takes autonomous merging away, the daemon restarts,
	// and the env flag silently hands it back. Then the revocation was theatre.
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-restart-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-restart-wt-"));

	const first = new SquadManager({ stateDir: dir, worktreeBase, autoLand: true });
	await first.start();
	expect(await first.delegationGrants()).toHaveLength(1);
	const revoked = await first.revokeDelegation("land", "db:lars");
	expect(revoked?.revokedBy).toBe("db:lars");
	await expect(first.land("nobody", "msg", { auto: true })).rejects.toThrow(DelegationBoundaryError);
	await first.stop();

	const second = new SquadManager({ stateDir: dir, worktreeBase, autoLand: true });
	await second.start();
	const after = await second.delegationGrants();
	expect(after).toHaveLength(1);
	expect(after[0]?.revokedAt).toBeGreaterThan(0);
	await expect(second.land("nobody", "msg", { auto: true })).rejects.toThrow(DelegationBoundaryError);
	await second.stop();
	await fs.rm(dir, { recursive: true, force: true });
});

test("an agent cannot reach a boundary action by sending the command itself", async () => {
	// The other way autonomy could take a non-delegatable action: an agent driving the manager directly
	// rather than through the fleet's own auto path. Agent-origin actors are held to a message-only
	// allowlist, so this is refused before the boundary is even consulted — but it is asserted here
	// because it is the same guarantee, and a later widening of that allowlist must fail this test.
	const { mgr, dir } = await manager(false);
	const agentActor = { id: "agent:wren", origin: "agent" as const, role: "viewer" as const, displayName: "Wren" };
	for (const type of ["remove", "kill", "restart"] as const) {
		await expect(mgr.applyCommand({ type, id: "anything" } as never, agentActor)).rejects.toThrow();
	}
	await mgr.stop();
	await fs.rm(dir, { recursive: true, force: true });
});
