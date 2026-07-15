/**
 * presence/lease WRITE endpoints (fleet-ide-intervention I02) — the cockpit registers the human
 * as present / holding a file. Load-bearing: the write scope gate (only daemon-known paths), the
 * operator tier, the DB-mode refusal, and that GET/POST round-trips through the real registry.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { restActionTier } from "../src/authz.ts";
import { FileStore } from "../src/dal/store.ts";
import { isDaemonWorkspace, isReservedIdentity, isSafePresenceId } from "../src/presence-write.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function authed(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { "content-type": "application/json", authorization: "Bearer admin", ...init.headers } };
}

async function fixture() {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "pw-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "pw-repo-"));
	// registerProject requires a git repo and canonicalizes the root through realpath.
	spawnSync("git", ["init", "-q", repo]);
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
	const server = new SquadServer(manager, { port: 0, token: "admin" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});
	return { url, repo };
}

/** Register `repo` and return the CANONICAL root the daemon stored — what the cockpit would send
 *  back (it uses the path the roster reported), so the write's scope gate matches. */
async function registerAndCanonical(url: string, repo: string): Promise<string> {
	await fetch(`${url}/api/projects`, authed({ method: "POST", body: JSON.stringify({ repo }) }));
	const projects = (await fetch(`${url}/api/projects`, authed()).then((r) => r.json())) as { repo: string }[];
	return projects[0].repo;
}

test("isDaemonWorkspace: registered project or a live agent path is allowed; anything else denied", () => {
	const known = { projects: ["/home/u/repo"], agentPaths: ["/home/u/repo/.wt/unit-a"] };
	expect(isDaemonWorkspace("/home/u/repo", known)).toBe(true);
	expect(isDaemonWorkspace("/home/u/repo/.wt/unit-a", known)).toBe(true);
	expect(isDaemonWorkspace("/home/u/repo/../repo", known)).toBe(true); // resolves
	expect(isDaemonWorkspace("/home/u/other", known)).toBe(false);
	expect(isDaemonWorkspace("/home/u/repo/src", known)).toBe(false); // a subdir is NOT the workspace root
});

test("isSafePresenceId: server-minted ids pass; traversal / control chars rejected (grok HIGH)", () => {
	expect(isSafePresenceId("1416092-mrlo12ud-g87r")).toBe(true); // server-minted shape
	expect(isSafePresenceId("harness-abc123")).toBe(true);
	expect(isSafePresenceId("../../etc/cron.d/x")).toBe(false);
	expect(isSafePresenceId("a/b")).toBe(false);
	expect(isSafePresenceId("..")).toBe(false);
	expect(isSafePresenceId("")).toBe(false);
	expect(isSafePresenceId("x".repeat(65))).toBe(false); // length cap
});

test("POST/DELETE /api/presence reject a path-traversal id with 400", async () => {
	const { url, repo: raw } = await fixture();
	const repo = await registerAndCanonical(url, raw);
	const evil = encodeURIComponent("../../../../tmp/pwned");
	const post = await fetch(`${url}/api/presence`, authed({ method: "POST", body: JSON.stringify({ repo, agent: "x", id: "../../pwned" }) }));
	expect(post.status).toBe(400);
	const del = await fetch(`${url}/api/presence?id=${evil}&repo=${encodeURIComponent(repo)}`, authed({ method: "DELETE" }));
	expect(del.status).toBe(400);
});

test("isReservedIdentity: omp:/squad: are reserved from HTTP write clients (codex)", () => {
	expect(isReservedIdentity("omp:1234")).toBe(true);
	expect(isReservedIdentity("squad:agent-a")).toBe(true);
	expect(isReservedIdentity("glance-cockpit:s1")).toBe(false);
	expect(isReservedIdentity("other")).toBe(false);
});

test("lease POST with a reserved (omp:) session is refused 400 — no agent-lease clobber", async () => {
	const { url, repo: raw } = await fixture();
	const repo = await registerAndCanonical(url, raw);
	const res = await fetch(`${url}/api/leases`, authed({ method: "POST", body: JSON.stringify({ repo, file: "src/x.ts", session: "omp:9999" }) }));
	expect(res.status).toBe(400);
});

test("presence POST with a reserved agent, and DELETE for an unmanaged repo, are refused", async () => {
	const { url, repo: raw } = await fixture();
	const repo = await registerAndCanonical(url, raw);
	const reserved = await fetch(`${url}/api/presence`, authed({ method: "POST", body: JSON.stringify({ repo, agent: "omp:1" }) }));
	expect(reserved.status).toBe(400);
	// DELETE for a path the daemon doesn't manage is scope-gated 403 (codex: DELETE was ungated)
	const del = await fetch(`${url}/api/presence?id=abc&repo=${encodeURIComponent("/tmp/unmanaged")}`, authed({ method: "DELETE" }));
	expect(del.status).toBe(403);
});

test("authz: presence/lease reads are viewer, writes are operator", () => {
	expect(restActionTier("GET", "/api/presence")).toBe("viewer");
	expect(restActionTier("POST", "/api/presence")).toBe("operator");
	expect(restActionTier("DELETE", "/api/presence")).toBe("operator");
	expect(restActionTier("GET", "/api/leases")).toBe("viewer");
	expect(restActionTier("POST", "/api/leases")).toBe("operator");
	expect(restActionTier("DELETE", "/api/leases")).toBe("operator");
});

test("POST /api/presence for a registered project round-trips through GET; DELETE removes it", async () => {
	const { url, repo: raw } = await fixture();
	const repo = await registerAndCanonical(url, raw);

	const claimed = await fetch(`${url}/api/presence`, authed({ method: "POST", body: JSON.stringify({ repo, agent: "glance-cockpit:s1", task: "reviewing" }) })).then((r) => r.json());
	expect(claimed.ok).toBe(true);
	expect(typeof claimed.id).toBe("string");

	const roster = await fetch(`${url}/api/presence?repo=${encodeURIComponent(repo)}`, authed()).then((r) => r.json());
	expect(roster.some((e: { agent: string; source: string }) => e.agent === "glance-cockpit:s1" && e.source === "other")).toBe(true);

	await fetch(`${url}/api/presence?id=${encodeURIComponent(claimed.id)}&repo=${encodeURIComponent(repo)}`, authed({ method: "DELETE" }));
	const after = await fetch(`${url}/api/presence?repo=${encodeURIComponent(repo)}`, authed()).then((r) => r.json());
	expect(after.some((e: { id: string }) => e.id === claimed.id)).toBe(false);
});

test("POST /api/presence for an UNregistered repo is refused 403 (scope gate)", async () => {
	const { url } = await fixture();
	const res = await fetch(`${url}/api/presence`, authed({ method: "POST", body: JSON.stringify({ repo: "/tmp/not-a-project", agent: "glance-cockpit:s1" }) }));
	expect(res.status).toBe(403);
});

test("POST /api/presence with a malformed body is 400", async () => {
	const { url } = await fixture();
	const res = await fetch(`${url}/api/presence`, authed({ method: "POST", body: JSON.stringify({ repo: "/x" }) })); // missing agent
	expect(res.status).toBe(400);
});

test("POST /api/leases for a registered project appears in GET with the right file", async () => {
	const { url, repo: raw } = await fixture();
	const repo = await registerAndCanonical(url, raw);

	const claimed = await fetch(`${url}/api/leases`, authed({ method: "POST", body: JSON.stringify({ repo, file: "src/x.ts", session: "glance-cockpit:s1" }) })).then((r) => r.json());
	expect(claimed.ok).toBe(true);

	const leases = await fetch(`${url}/api/leases?repo=${encodeURIComponent(repo)}`, authed()).then((r) => r.json());
	expect(leases.some((l: { file: string; session: string }) => l.file === "src/x.ts" && l.session === "glance-cockpit:s1")).toBe(true);

	await fetch(`${url}/api/leases?session=${encodeURIComponent("glance-cockpit:s1")}&repo=${encodeURIComponent(repo)}`, authed({ method: "DELETE" }));
	const after = await fetch(`${url}/api/leases?repo=${encodeURIComponent(repo)}`, authed()).then((r) => r.json());
	expect(after.some((l: { file: string }) => l.file === "src/x.ts")).toBe(false);
});
