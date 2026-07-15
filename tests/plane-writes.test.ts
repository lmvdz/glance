/**
 * Plane write primitives — `updatePlaneIssueBody` (application-level clobber protection; Plane has
 * no ETag) and `movePlaneIssueToState` (named-state-or-no-write; never falls through to whatever
 * sorts first in a state group). Both no-op with a typed `multi-org` error in DB mode until Plane
 * config is per-org.
 */

import { afterEach, expect, test } from "bun:test";
import { hashPlaneBody, movePlaneIssueToState, updatePlaneIssueBody } from "../src/plane.ts";

const PLANE_ENV = ["PLANE_API_KEY", "PLANE_API_TOKEN", "PLANE_WORKSPACE", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_MAP", "PLANE_BASE_URL", "PLANE_PROJECT_ID", "PLANE_APP_URL", "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of PLANE_ENV) saved[k] = process.env[k];

afterEach(() => {
	for (const k of PLANE_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const ISSUE_ID = "11111111-1111-1111-1111-111111111111"; // uuid-shaped: resolveIssueId short-circuits, no /issues list fetch needed

function configure(server: ReturnType<typeof Bun.serve>): void {
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`;
	process.env.PLANE_PROJECT_MAP = JSON.stringify({ "/repo/app": "proj-9" });
	delete process.env.DATABASE_URL;
}

test("updatePlaneIssueBody writes description_html when no hash is expected", async () => {
	const seen: { method: string; path: string; body: unknown }[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const body = req.method === "PATCH" ? await req.json() : undefined;
			seen.push({ method: req.method, path: new URL(req.url).pathname, body });
			return Response.json({ ok: true });
		},
	});
	try {
		configure(server);
		const result = await updatePlaneIssueBody("/repo/app", ISSUE_ID, "<p>new body</p>");
		expect(result).toEqual({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0].method).toBe("PATCH");
		expect(seen[0].path).toBe(`/api/v1/workspaces/acme/projects/proj-9/issues/${ISSUE_ID}/`);
		expect(seen[0].body).toEqual({ description_html: "<p>new body</p>" });
	} finally {
		server.stop(true);
	}
});

test("updatePlaneIssueBody refuses with `conflict` and sends zero writes when the live body changed underneath", async () => {
	let patched = false;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			if (req.method === "PATCH") {
				patched = true;
				return Response.json({ ok: true });
			}
			// GET (re-fetch before compare) returns a body that no longer matches the caller's expected hash.
			return Response.json({ description_html: "<p>changed by someone else</p>" });
		},
	});
	try {
		configure(server);
		const staleHash = hashPlaneBody("<p>original body the caller read</p>");
		const result = await updatePlaneIssueBody("/repo/app", ISSUE_ID, "<p>my rewrite</p>", { expectHash: staleHash });
		expect(result).toEqual({ ok: false, error: "conflict" });
		expect(patched).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("updatePlaneIssueBody writes when the caller's expectHash matches the live body", async () => {
	let patchBody: unknown;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			if (req.method === "PATCH") {
				patchBody = await req.json();
				return Response.json({ ok: true });
			}
			return Response.json({ description_html: "<p>original body the caller read</p>" });
		},
	});
	try {
		configure(server);
		const currentHash = hashPlaneBody("<p>original body the caller read</p>");
		const result = await updatePlaneIssueBody("/repo/app", ISSUE_ID, "<p>my rewrite</p>", { expectHash: currentHash });
		expect(result).toEqual({ ok: true });
		expect(patchBody).toEqual({ description_html: "<p>my rewrite</p>" });
	} finally {
		server.stop(true);
	}
});

test("movePlaneIssueToState refuses with `unknown-state` and writes nothing when the name has no exact match", async () => {
	let patched = false;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (req.method === "PATCH") {
				patched = true;
				return Response.json({ ok: true });
			}
			if (url.pathname.endsWith("/states/")) {
				return Response.json({ results: [{ id: "s-todo", name: "Todo", group: "unstarted" }, { id: "s-done", name: "Done", group: "completed" }] });
			}
			return Response.json({ error: "unexpected" }, { status: 404 });
		},
	});
	try {
		configure(server);
		const result = await movePlaneIssueToState("/repo/app", ISSUE_ID, "NoSuchState");
		expect(result).toEqual({ ok: false, error: "unknown-state" });
		expect(patched).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("movePlaneIssueToState writes the state id on an exact name match", async () => {
	let patchBody: unknown;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (req.method === "PATCH") {
				patchBody = await req.json();
				return Response.json({ ok: true });
			}
			if (url.pathname.endsWith("/states/")) {
				return Response.json({ results: [{ id: "s-todo", name: "Todo", group: "unstarted" }, { id: "s-done", name: "Done", group: "completed" }] });
			}
			return Response.json({ error: "unexpected" }, { status: 404 });
		},
	});
	try {
		configure(server);
		const result = await movePlaneIssueToState("/repo/app", ISSUE_ID, "Todo");
		expect(result).toEqual({ ok: true });
		expect(patchBody).toEqual({ state: "s-todo" });
	} finally {
		server.stop(true);
	}
});

test("both writers no-op with a typed `multi-org` error in DB mode, without hitting the network", async () => {
	let hit = false;
	const server = Bun.serve({
		port: 0,
		fetch: async () => {
			hit = true;
			return Response.json({ ok: true });
		},
	});
	try {
		configure(server);
		process.env.DATABASE_URL = "postgres://localhost/test";
		const bodyResult = await updatePlaneIssueBody("/repo/app", ISSUE_ID, "<p>x</p>");
		const stateResult = await movePlaneIssueToState("/repo/app", ISSUE_ID, "Todo");
		expect(bodyResult).toEqual({ ok: false, error: "multi-org" });
		expect(stateResult).toEqual({ ok: false, error: "multi-org" });
		expect(hit).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("updatePlaneIssueBody no-ops with `not-configured` when Plane isn't configured", async () => {
	for (const k of PLANE_ENV) delete process.env[k];
	expect(await updatePlaneIssueBody("/repo/app", ISSUE_ID, "<p>x</p>")).toEqual({ ok: false, error: "not-configured" });
});

test("movePlaneIssueToState no-ops with `not-configured` when Plane isn't configured", async () => {
	for (const k of PLANE_ENV) delete process.env[k];
	expect(await movePlaneIssueToState("/repo/app", ISSUE_ID, "Todo")).toEqual({ ok: false, error: "not-configured" });
});
