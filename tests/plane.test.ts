/**
 * Plane outbound — createPlaneIssue turns a spawn into a tracked issue (work→Plane).
 * Tested against a stub Plane API (Bun.serve) so the request shape + response parsing are
 * pinned without touching real Plane. The no-op-when-unconfigured paths are the safety net
 * that keeps the hook inert on a Plane-blind daemon.
 */

import { afterEach, expect, test } from "bun:test";
import { createPlaneIssue, parseBlockedBy, planeConfigured, startPlaneIssue } from "../src/plane.ts";

const PLANE_ENV = ["PLANE_API_KEY", "PLANE_API_TOKEN", "PLANE_WORKSPACE", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_MAP", "PLANE_BASE_URL", "PLANE_PROJECT_ID", "PLANE_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of PLANE_ENV) saved[k] = process.env[k];

afterEach(() => {
	for (const k of PLANE_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

test("createPlaneIssue posts to the mapped project and parses the ref", async () => {
	let seen: { path: string; key: string | null; body: unknown } | undefined;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			seen = { path: new URL(req.url).pathname, key: req.headers.get("x-api-key"), body: await req.json() };
			return Response.json({ id: "iss-1", name: "Do the thing", sequence_id: 42, project_detail: { identifier: "OMPSQ" } }, { status: 201 });
		},
	});
	try {
		process.env.PLANE_API_KEY = "secret";
		process.env.PLANE_WORKSPACE = "acme";
		process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`;
		process.env.PLANE_PROJECT_MAP = JSON.stringify({ "/repo/app": "proj-9" });

		const ref = await createPlaneIssue("/repo/app", "Do the thing");

		expect(ref?.id).toBe("iss-1");
		expect(ref?.identifier).toBe("OMPSQ-42");
		expect(ref?.projectId).toBe("proj-9");
		expect(seen?.path).toBe("/api/v1/workspaces/acme/projects/proj-9/issues/");
		expect(seen?.key).toBe("secret");
		expect(seen?.body).toEqual({ name: "Do the thing" });
	} finally {
		server.stop(true);
	}
});

test("createPlaneIssue no-ops (null) when Plane is unconfigured", async () => {
	for (const k of PLANE_ENV) delete process.env[k];
	expect(await createPlaneIssue("/repo/app", "x")).toBeNull();
});

test("createPlaneIssue no-ops (null) when the repo maps to no project", async () => {
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	delete process.env.PLANE_PROJECT_MAP;
	delete process.env.PLANE_PROJECT_ID;
	expect(await createPlaneIssue("/repo/unmapped", "x")).toBeNull();
});

test("readConfig accepts the alternate cred names (PLANE_API_TOKEN / PLANE_WORKSPACE_SLUG)", () => {
	for (const k of PLANE_ENV) delete process.env[k];
	expect(planeConfigured()).toBe(false); // neither pair set
	process.env.PLANE_API_TOKEN = "tok";
	process.env.PLANE_WORKSPACE_SLUG = "acme";
	expect(planeConfigured()).toBe(true); // alternates alone configure Plane
});

test("readConfig strips a trailing /api/v1 from PLANE_BASE_URL (no double suffix)", async () => {
	let seenPath: string | undefined;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			seenPath = new URL(req.url).pathname;
			return Response.json({ id: "iss-1", name: "x" }, { status: 201 });
		},
	});
	try {
		process.env.PLANE_API_KEY = "secret";
		process.env.PLANE_WORKSPACE = "acme";
		process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}/api/v1`; // suffix already present
		process.env.PLANE_PROJECT_MAP = JSON.stringify({ "/repo/app": "proj-9" });

		await createPlaneIssue("/repo/app", "x");
		// Stripped → exactly one /api/v1, not /api/v1/api/v1.
		expect(seenPath).toBe("/api/v1/workspaces/acme/projects/proj-9/issues/");
	} finally {
		server.stop(true);
	}
});

test("startPlaneIssue PATCHes the issue to the project's started-group state", async () => {
	let patch: { path: string; state?: string } | undefined;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname.endsWith("/states/")) {
				return Response.json({ results: [{ id: "s-backlog", group: "backlog" }, { id: "s-started", group: "started" }] });
			}
			if (req.method === "PATCH") {
				const body: unknown = await req.json();
				const state = body && typeof body === "object" && "state" in body && typeof body.state === "string" ? body.state : undefined;
				patch = { path: url.pathname, state };
				return Response.json({ ok: true });
			}
			return new Response("no", { status: 404 });
		},
	});
	try {
		process.env.PLANE_API_KEY = "secret";
		process.env.PLANE_WORKSPACE = "acme";
		process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`;

		const ok = await startPlaneIssue({ id: "iss-1", name: "x", projectId: "proj-9" });

		expect(ok).toBe(true);
		expect(patch?.path).toBe("/api/v1/workspaces/acme/projects/proj-9/issues/iss-1/");
		expect(patch?.state).toBe("s-started"); // picked the started group, not backlog
	} finally {
		server.stop(true);
	}
});

test("startPlaneIssue no-ops (false) when the issue carries no projectId", async () => {
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	expect(await startPlaneIssue({ id: "iss-1", name: "x" })).toBe(false);
});

test("createPlaneIssue deep-links to the app host, not the API base host", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: async () => Response.json({ id: "iss-1", name: "x", sequence_id: 7, project_detail: { identifier: "OMPSQ" } }, { status: 201 }),
	});
	try {
		process.env.PLANE_API_KEY = "secret";
		process.env.PLANE_WORKSPACE = "acme";
		process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`; // API host issues are fetched from
		process.env.PLANE_APP_URL = "https://app.acme.test"; // distinct app host deep links must use
		process.env.PLANE_PROJECT_MAP = JSON.stringify({ "/repo/app": "proj-9" });

		const ref = await createPlaneIssue("/repo/app", "x");

		// OMPSQ-31: the deep link points at the app host, never the API base host.
		expect(ref?.url).toBe("https://app.acme.test/acme/projects/proj-9/issues/iss-1");
		expect(ref?.url.includes(`127.0.0.1:${server.port}`)).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("parseBlockedBy extracts blocker ids from a /relations/ response", () => {
	expect(parseBlockedBy({ blocked_by: ["id-a", "id-b"], blocking: [], relates_to: [] })).toEqual(["id-a", "id-b"]);
});

test("parseBlockedBy tolerates missing / odd shapes", () => {
	expect(parseBlockedBy({ blocking: ["x"] })).toEqual([]); // no blocked_by key
	expect(parseBlockedBy({ blocked_by: "nope" })).toEqual([]); // not an array
	expect(parseBlockedBy({ blocked_by: ["ok", 42, null] })).toEqual(["ok"]); // drops non-strings
	expect(parseBlockedBy(null)).toEqual([]);
	expect(parseBlockedBy("garbage")).toEqual([]);
});
