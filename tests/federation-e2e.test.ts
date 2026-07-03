/**
 * Cross-operator steering, END TO END at the product level: two live SquadManagers
 * (alice + bob), each with its own state dir and LocalFederationBus, joined through a
 * REAL in-process coordinator over real WebSockets. Alice's HTTP endpoint sends a
 * command addressed to bob; bob's manager receives it through the coordinator, derives
 * the actor (no tailnet here ⇒ unverified ⇒ viewer), applies RBAC at applyCommand, and
 * acks the outcome back — which surfaces in alice's HTTP response.
 *
 * The DENIED outcome is the correct one today: a `prompt` needs operator tier and a
 * remote actor stays viewer until a delegation policy exists (deferred authz, see
 * authz.ts). This test pins the complete wire path AND the security floor: crossing
 * hosts must never mint authority.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCoordinator, type CoordinatorHandle } from "../src/coordinator.ts";
import { LocalFederationBus } from "../src/federation.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

interface Daemon {
	url: string;
	manager: SquadManager;
	bus: LocalFederationBus;
}

async function daemon(operatorId: string, coordinatorUrl: string): Promise<Daemon> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `fed-e2e-${operatorId}-`));
	const operator = { id: operatorId, origin: "local" as const };
	// whois injected as "no tailnet" — hermetic AND instant. The default shells out to the
	// tailscale binary; on a host without it (this sandbox: WSL PATH scan) the failed lookup
	// alone costs ~14s, which is the product behavior a real tailnet host doesn't see.
	const bus = new LocalFederationBus({ operator, coordinatorUrl, whois: async () => undefined });
	const manager = new SquadManager({ stateDir, operator, bus });
	await manager.start();
	const server = new SquadServer(manager, { port: 0, operator });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	return { url, manager, bus };
}

test("two daemons: HTTP steer from alice → coordinator → bob's RBAC → denied ack back in alice's HTTP response", async () => {
	const coord: CoordinatorHandle = runCoordinator({ port: 0 });
	cleanups.push(() => coord.stop());

	const alice = await daemon("alice", coord.url);
	const bob = await daemon("bob", coord.url);
	void bob; // bob's manager participates via the coordinator; no direct handle needed

	// Both daemon buses connected to the hub.
	const deadline = Date.now() + 5000;
	while (coord.clients() < 2) {
		if (Date.now() > deadline) throw new Error("coordinator clients never connected");
		await new Promise((r) => setTimeout(r, 10));
	}

	const res = await fetch(`${alice.url}/api/federation/command`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ to: "bob", cmd: { type: "prompt", id: "bob-agent-1", message: "cross-host hello" } }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; sent: string; to: string; cmdId: string; ack: { outcome: string; detail?: string } | null };
	expect(body.ok).toBe(true);
	expect(body.sent).toBe("prompt");
	expect(body.cmdId).toMatch(/^cmd-/);
	// The full round trip resolved: bob's daemon received the frame, derived an UNVERIFIED
	// remote actor (no tailnet), and applyCommand's RBAC refused a viewer-tier prompt — the
	// security floor. The ack carried that outcome back across the coordinator.
	expect(body.ack).not.toBeNull();
	expect(body.ack!.outcome).toBe("denied");
	expect(body.ack!.detail).toContain("operator");
});

test("a command addressed to a third operator never reaches bob (and alice gets no ack)", async () => {
	const coord: CoordinatorHandle = runCoordinator({ port: 0 });
	cleanups.push(() => coord.stop());
	const alice = await daemon("alice", coord.url);
	const bob = await daemon("bob", coord.url);

	let bobSaw = 0;
	bob.bus.onRemoteCommand(() => {
		bobSaw++;
	});
	const deadline = Date.now() + 5000;
	while (coord.clients() < 2) {
		if (Date.now() > deadline) throw new Error("coordinator clients never connected");
		await new Promise((r) => setTimeout(r, 10));
	}

	const cmdId = alice.manager.sendFederationCommand("carol", { type: "prompt", id: "x", message: "hi" });
	const ack = await alice.manager.waitForAck(cmdId, 300); // nobody named carol is online
	expect(ack).toBeNull();
	expect(bobSaw).toBe(0);
});
