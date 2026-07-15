/**
 * Per-org push lane (voice-loop DB-mode prerequisite, plans/voice-loop DESIGN.md "Multi-tenant"
 * decision): in DB-registry mode every org gets its OWN PushService (own subscription store under
 * <pushRoot>/orgs/<orgId>) and its OWN alert state — one org's escalation/completion alerts must
 * never fan out to another org's devices, and the file-mode global service must stay untouched.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ManagerRegistry } from "../src/manager-registry.ts";
import type { PushPayload, PushService } from "../src/push.ts";
import { SquadServer } from "../src/server.ts";
import type { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, AgentStatus, SquadEvent } from "../src/types.ts";

function agent(status: AgentStatus, over: Partial<AgentDTO> = {}): AgentDTO {
	return { id: "x1", name: "alpha", status, kind: "omp-operator", repo: "/r", worktree: "/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

interface OrgPushHost {
	maybePushAlertOrg(orgId: string, e: SquadEvent): void;
	orgPush: Map<string, Promise<PushService>>;
}

function fakePush(captured: PushPayload[]): PushService {
	return { notify: async (p: PushPayload) => (captured.push(p), 1), init: async () => {}, subscribe: async () => {}, publicKey: "pk" } as unknown as PushService;
}

async function makeOrgServer(fakeManagers: Record<string, Partial<SquadManager>>): Promise<{ host: OrgPushHost; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-org-"));
	const registry = { peek: (orgId: string) => fakeManagers[orgId] as SquadManager | undefined } as unknown as ManagerRegistry;
	const server = new SquadServer(undefined, { port: 0, pushRoot: dir, registry });
	return { host: server as unknown as OrgPushHost, dir };
}

test("org isolation: an armed completion in org A notifies ONLY org A's service and disarms via org A's manager", async () => {
	const disarmedA: string[] = [];
	const { host } = await makeOrgServer({
		A: { list: () => [agent("working", { id: "a1" })], clearVoicePushArmed: (id: string) => void disarmedA.push(id) },
		B: { list: () => [agent("working", { id: "b1" })], clearVoicePushArmed: () => {} },
	});
	const sentA: PushPayload[] = [];
	const sentB: PushPayload[] = [];
	host.orgPush.set("A", Promise.resolve(fakePush(sentA)));
	host.orgPush.set("B", Promise.resolve(fakePush(sentB)));

	host.maybePushAlertOrg("A", { type: "agent", agent: agent("working", { id: "a1" }) } as SquadEvent); // lazy-seeds A
	host.maybePushAlertOrg("A", { type: "agent", agent: agent("idle", { id: "a1", voicePushArmed: true }) } as SquadEvent);
	await new Promise((r) => setTimeout(r, 10)); // notify rides pushForOrg's promise

	expect(sentA).toHaveLength(1);
	expect(sentA[0]!.tag).toBe("done:a1");
	expect(sentA[0]!.body.includes("alpha")).toBe(false); // name-only TITLE; body carries no agent text
	expect(sentB).toHaveLength(0); // org B heard nothing
	expect(disarmedA).toEqual(["a1"]); // sync disarm through org A's own manager
});

test("escalations ride the per-org lane too (DB mode gets input/error pushes for the first time), still org-isolated", async () => {
	const { host } = await makeOrgServer({
		A: { list: () => [agent("working", { id: "a1" })], clearVoicePushArmed: () => {} },
		B: { list: () => [agent("working", { id: "b1" })], clearVoicePushArmed: () => {} },
	});
	const sentA: PushPayload[] = [];
	const sentB: PushPayload[] = [];
	host.orgPush.set("A", Promise.resolve(fakePush(sentA)));
	host.orgPush.set("B", Promise.resolve(fakePush(sentB)));

	host.maybePushAlertOrg("A", { type: "agent", agent: agent("working", { id: "a1" }) } as SquadEvent); // seed
	host.maybePushAlertOrg("A", { type: "agent", agent: agent("input", { id: "a1", pending: [{ id: "p", title: "which db?", kind: "question" }] as AgentDTO["pending"] }) } as SquadEvent);
	await new Promise((r) => setTimeout(r, 10));

	expect(sentA).toHaveLength(1);
	expect(sentA[0]!.tag).toBe("a1"); // escalation keeps its own tag namespace
	expect(sentB).toHaveLength(0);
});

test("lazy seeding: the event that materializes an org's alert state never alerts (reconnect-replay discipline)", async () => {
	const { host } = await makeOrgServer({
		A: { list: () => [agent("input", { id: "a1" })], clearVoicePushArmed: () => {} },
	});
	const sentA: PushPayload[] = [];
	host.orgPush.set("A", Promise.resolve(fakePush(sentA)));

	// First-ever event arrives with the agent ALREADY in input (e.g. server restarted mid-question):
	// the lazy seed snapshots that as the baseline — no bulk alert on replay.
	host.maybePushAlertOrg("A", { type: "agent", agent: agent("input", { id: "a1" }) } as SquadEvent);
	await new Promise((r) => setTimeout(r, 10));
	expect(sentA).toHaveLength(0);

	// A REAL later transition still fires.
	host.maybePushAlertOrg("A", { type: "agent", agent: agent("working", { id: "a1" }) } as SquadEvent);
	host.maybePushAlertOrg("A", { type: "agent", agent: agent("error", { id: "a1", error: "boom" }) } as SquadEvent);
	await new Promise((r) => setTimeout(r, 10));
	expect(sentA).toHaveLength(1);
});

test("no registry / no pushRoot -> the per-org lane is inert (file mode keeps the single global service)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-org-inert-"));
	const server = new SquadServer(undefined, { port: 0, pushRoot: dir }); // registry absent
	const host = server as unknown as OrgPushHost;
	host.maybePushAlertOrg("A", { type: "agent", agent: agent("idle", { id: "a1", voicePushArmed: true }) } as SquadEvent);
	expect(host.orgPush.size).toBe(0); // never even constructed a service
});

test("pushForOrg persists per-org stores under <pushRoot>/orgs/<orgId> with independent VAPID keys", async () => {
	const { host, dir } = await makeOrgServer({});
	const svcA = await (host as unknown as { pushForOrg(o: string): Promise<PushService> }).pushForOrg("orgA");
	const svcB = await (host as unknown as { pushForOrg(o: string): Promise<PushService> }).pushForOrg("orgB");
	expect(svcA.publicKey).not.toBe(svcB.publicKey); // independent keypairs
	expect(await fs.exists(path.join(dir, "orgs", "orgA", "vapid.json"))).toBe(true);
	expect(await fs.exists(path.join(dir, "orgs", "orgB", "vapid.json"))).toBe(true);
});
