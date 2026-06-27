import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const manifest = {
	name: "ui-review",
	framework: "workflow",
	version: "1.0.0",
	title: "UI Review",
	description: "Review frontend craft.",
	files: [{ path: "agent/instructions.md", content: "Review UI." }],
	profiles: [{ id: "ui-reviewer", name: "UI Reviewer", instructions: "Review the active UI." }],
	workflows: [{ id: "review", label: "Review UI" }],
	tools: ["browser"],
};

async function startedServer() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cap-api-"));
	const manager = new SquadManager({ stateDir: dir, store: new FileStore(dir) });
	const server = new SquadServer(manager, { port: 0, token: "admin" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return url;
}

function authed(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { "content-type": "application/json", authorization: "Bearer admin", ...init.headers } };
}

test("public capability catalog imports through trusted source route", async () => {
	const url = await startedServer();
	const catalog = await fetch(`${url}/api/capability-catalog`, authed()).then((res) => res.json());
	const ids = new Set(catalog.catalog.map((entry: { id: string }) => entry.id));
	for (const id of ["collaborative-plan-reviser", "verified-feature-delivery", "parallel-solution-race", "conflict-resolution-doctor", "agent-factory-architect", "fleet-autonomy-steward"]) {
		expect(ids.has(id)).toBe(true);
	}
	const delivery = catalog.catalog.find((entry: { id: string }) => entry.id === "verified-feature-delivery");
	expect(delivery.profiles.some((profile: { id?: string }) => profile.id === "issue-implementer")).toBe(true);
	expect(delivery.workflows.some((workflow: { id?: string }) => workflow.id === "research-plan-implement")).toBe(true);
	expect(delivery.tools.some((tool: { name: string }) => tool.name === "plane")).toBe(true);

	const imported = await fetch(`${url}/api/capability-sources`, authed({ method: "POST", body: JSON.stringify({ catalogId: delivery.id }) })).then((res) => res.json());
	expect(imported.pack.title).toBe(delivery.title);
	expect(imported.pack.profiles.some((profile: { id?: string }) => profile.id === "issue-implementer")).toBe(true);

	const packs = await fetch(`${url}/api/capability-packs`, authed()).then((res) => res.json());
	expect(packs.packs.some((pack: { slug: string }) => pack.slug === delivery.slug)).toBe(true);
});

test("capability APIs import, install, expose runtime state, and audit", async () => {
	const url = await startedServer();
	const imported = await fetch(`${url}/api/capability-sources`, authed({ method: "POST", body: JSON.stringify({ name: "agentcn", manifest }) })).then((res) => res.json());
	expect(imported.pack.title).toBe("UI Review");

	const packs = await fetch(`${url}/api/capability-packs`, authed()).then((res) => res.json());
	expect(packs.packs).toHaveLength(1);

	const installed = await fetch(`${url}/api/capability-installs`, authed({ method: "POST", body: JSON.stringify({ packId: imported.pack.id, enable: true }) })).then((res) => res.json());
	expect(installed.state).toBe("enabled");

	const profiles = await fetch(`${url}/api/profiles`, authed()).then((res) => res.json());
	// Capability profile ids are keyed (cap:<slug>:<id>) so runCapability's profileId resolves them.
	expect(profiles.profiles.some((profile: { id: string }) => profile.id === "cap:ui-review:ui-reviewer")).toBe(true);

	const workflows = await fetch(`${url}/api/workflows`, authed()).then((res) => res.json());
	expect(workflows.definitions.some((workflow: { id: string }) => workflow.id.includes("review"))).toBe(true);

	const fed = await fetch(`${url}/api/federation/capabilities`, authed()).then((res) => res.json());
	expect(fed.capabilities[0]).not.toHaveProperty("files");

	const audit = await fetch(`${url}/api/capability-audit`, authed()).then((res) => res.json());
	expect(audit.audit.some((event: { action: string }) => event.action === "capability.install")).toBe(true);

	const disabled = await fetch(`${url}/api/capability-installs/${installed.id}`, authed({ method: "PATCH", body: JSON.stringify({ enabled: false }) })).then((res) => res.json());
	expect(disabled.state).toBe("disabled");
});
