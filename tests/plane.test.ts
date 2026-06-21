/**
 * Plane outbound — createPlaneIssue turns a spawn into a tracked issue (work→Plane).
 * Tested against a stub Plane API (Bun.serve) so the request shape + response parsing are
 * pinned without touching real Plane. The no-op-when-unconfigured paths are the safety net
 * that keeps the hook inert on a Plane-blind daemon.
 */

import { afterEach, expect, test } from "bun:test";
import { createPlaneIssue } from "../src/plane.ts";

const PLANE_ENV = ["PLANE_API_KEY", "PLANE_WORKSPACE", "PLANE_PROJECT_MAP", "PLANE_BASE_URL", "PLANE_PROJECT_ID"] as const;
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
