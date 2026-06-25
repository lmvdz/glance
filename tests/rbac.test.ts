/**
 * rbac — the three-tier capability gate (viewer ⊂ operator ⊂ admin) enforced at the
 * manager's applyCommand chokepoint AND the REST/WS surface.
 *
 * Pure-policy units (roleAtLeast / commandRole / requiredRole / effectiveRole / resolveRole)
 * plus live-server integration (a viewer token reads but cannot mutate; an operator token
 * mutates but cannot upgrade; the manager rejects an under-tiered command).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { actorForRole, authEnabled, commandRole, effectiveRole, RbacDenied, requiredRole, resolveRole, roleAtLeast } from "../src/auth.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { Actor } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

test("roleAtLeast respects the viewer ⊂ operator ⊂ admin ordering", () => {
	expect(roleAtLeast("admin", "operator")).toBe(true);
	expect(roleAtLeast("operator", "operator")).toBe(true);
	expect(roleAtLeast("operator", "viewer")).toBe(true);
	expect(roleAtLeast("viewer", "operator")).toBe(false);
	expect(roleAtLeast("viewer", "admin")).toBe(false);
});

test("commandRole: reads need viewer, driving needs operator, destructive needs admin", () => {
	expect(commandRole({ type: "snapshot" })).toBe("viewer");
	expect(commandRole({ type: "subscribe", id: "a" })).toBe("viewer");
	expect(commandRole({ type: "prompt", id: "a", message: "hi" })).toBe("operator");
	expect(commandRole({ type: "create", options: { repo: "/x" } })).toBe("operator");
	expect(commandRole({ type: "message", to: "b", text: "hi" })).toBe("operator");
	expect(commandRole({ type: "kill", id: "a" })).toBe("admin");
	expect(commandRole({ type: "restart", id: "a" })).toBe("admin");
	expect(commandRole({ type: "remove", id: "a" })).toBe("admin");
});

test("requiredRole: GET=viewer, mutation=operator, destructive=admin, auth/push=viewer", () => {
	expect(requiredRole("GET", "/api/agents")).toBe("viewer");
	expect(requiredRole("GET", "/api/upgrade/status")).toBe("viewer");
	expect(requiredRole("POST", "/api/features")).toBe("operator");
	expect(requiredRole("PATCH", "/api/features/x")).toBe("operator");
	expect(requiredRole("POST", "/api/command")).toBe("operator");
	expect(requiredRole("POST", "/api/upgrade")).toBe("admin");
	expect(requiredRole("POST", "/api/agents/a1/land")).toBe("admin");
	expect(requiredRole("POST", "/api/features/f1/land")).toBe("admin");
	expect(requiredRole("POST", "/api/features/f1/verify")).toBe("admin");
	expect(requiredRole("GET", "/api/auth/check")).toBe("viewer");
	expect(requiredRole("POST", "/api/push/subscribe")).toBe("viewer");
});

test("effectiveRole: explicit role wins except agent-origin stays viewer; else local⇒admin, remote⇒viewer", () => {
	expect(effectiveRole({ id: "x", origin: "local", role: "viewer" })).toBe("viewer");
	expect(effectiveRole({ id: "x", origin: "local" })).toBe("admin"); // trusted in-process surface
	expect(effectiveRole({ id: "x", origin: "remote" })).toBe("viewer"); // untrusted peer defaults read-only
	expect(effectiveRole({ id: "x", origin: "agent", role: "admin" })).toBe("viewer"); // message-only allowlist lives in applyCommand
});

test("resolveRole: auth off ⇒ admin; else highest matching token, null on miss", () => {
	const policy = { admin: "AAAA", operator: "BBBB", viewer: "CCCC" };
	const reqWith = (t: string) => new Request("http://x/api/agents", { headers: { authorization: `Bearer ${t}` } });
	expect(resolveRole(new Request("http://x/api/agents"), {})).toBe("admin"); // no tokens ⇒ open
	expect(authEnabled({})).toBe(false);
	expect(authEnabled(policy)).toBe(true);
	expect(resolveRole(reqWith("AAAA"), policy)).toBe("admin");
	expect(resolveRole(reqWith("BBBB"), policy)).toBe("operator");
	expect(resolveRole(reqWith("CCCC"), policy)).toBe("viewer");
	expect(resolveRole(reqWith("nope"), policy)).toBeNull();
	expect(resolveRole(new Request("http://x/api/agents"), policy)).toBeNull(); // no token presented
});

test("manager.applyCommand denies a command above the actor's tier", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbac-mgr-"));
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	cleanups.push(async () => {
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const viewer: Actor = { id: "v", origin: "remote", role: "viewer" };
	const operator: Actor = { id: "o", origin: "remote", role: "operator" };

	// A viewer mutating is rejected — the check fires before any agent lookup.
	await expect(mgr.applyCommand({ type: "prompt", id: "ghost", message: "x" }, viewer)).rejects.toThrow(RbacDenied);
	await expect(mgr.applyCommand({ type: "kill", id: "ghost" }, viewer)).rejects.toThrow(RbacDenied);

	// A viewer reading is allowed (subscribe/snapshot resolve, even for an unknown agent).
	await mgr.applyCommand({ type: "subscribe", id: "ghost" }, viewer);
	await mgr.applyCommand({ type: "snapshot" }, viewer);

	// An operator mutating passes the gate (unknown agent ⇒ no-op, but no RBAC throw).
	await mgr.applyCommand({ type: "prompt", id: "ghost", message: "x" }, operator);
});

test("a role-tokened server: viewer reads but cannot mutate; operator mutates but cannot upgrade", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbac-srv-"));
	const tokens = { admin: "admin-token-xxxxxxxx", operator: "operator-token-xxxxxx", viewer: "viewer-token-xxxxxxxx" };
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token: tokens.admin, roleTokens: { operator: tokens.operator, viewer: tokens.viewer } });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
	const post = (p: string, t: string, body: unknown) => fetch(`${url}${p}`, { method: "POST", headers: { ...bearer(t), "content-type": "application/json" }, body: JSON.stringify(body) });

	// Unauthenticated → 401.
	expect((await fetch(`${url}/api/agents`)).status).toBe(401);

	// Viewer: read OK, mutate forbidden.
	expect((await fetch(`${url}/api/agents`, { headers: bearer(tokens.viewer) })).status).toBe(200);
	expect((await post("/api/features", tokens.viewer, { title: "nope" })).status).toBe(403);
	expect((await post("/api/upgrade", tokens.viewer, {})).status).toBe(403);

	// Operator: mutate OK, upgrade forbidden (admin-only).
	expect((await fetch(`${url}/api/agents`, { headers: bearer(tokens.operator) })).status).toBe(200);
	expect((await post("/api/features", tokens.operator, { title: "ok" })).status).toBe(200);
	expect((await post("/api/upgrade", tokens.operator, {})).status).toBe(403);

	// The operator's mutation actually took effect.
	const feats = await (await fetch(`${url}/api/features`, { headers: bearer(tokens.operator) })).json();
	expect(feats.some((f: { title: string }) => f.title === "ok")).toBe(true);

	// actorForRole stamps the tier it grants.
	expect(actorForRole("operator").role).toBe("operator");
});
