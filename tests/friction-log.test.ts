/**
 * Friction ledger (plans/daily-dogfood-engine/01) — `src/friction-log.ts`'s record/recent/
 * hydrateAll round trip (JsonlLog's own torn-line tolerance is NOT re-tested here), the
 * `/api/friction` REST surface (authz tiers + POST→GET round trip through a live server),
 * and the TUI's slash parsing seam (`parseSlash`).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { restActionTier } from "../src/authz.ts";
import { FrictionLog, frictionPath } from "../src/friction-log.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import { parseSlash } from "../src/tui.ts";
import type { FrictionEntry } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/** JsonlLog spools fire-and-forget; poll the file until the expected line count lands. */
async function waitForLines(file: string, count: number, timeoutMs = 2000): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const lines = await fs
			.readFile(file, "utf8")
			.then((t) => t.split("\n").filter((l) => l.trim()))
			.catch(() => [] as string[]);
		if (lines.length >= count) return lines;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`friction.jsonl never reached ${count} line(s)`);
}

// ---------------------------------------------------------------------------
// FrictionLog — the single write path
// ---------------------------------------------------------------------------

test("FrictionLog.record: mints id+ts, trims the gripe, includes context/agentId only when present", async () => {
	const dir = await tmpDir("friction-");
	const log = new FrictionLog(dir);

	const bare = log.record({ repo: "/repo", gripe: "  spawn takes forever  " });
	expect(bare.gripe).toBe("spawn takes forever");
	expect(bare.repo).toBe("/repo");
	expect(bare.id).toMatch(/^[0-9a-f-]{36}$/);
	expect(bare.ts).toBeGreaterThan(0);
	expect("context" in bare).toBe(false);
	expect("agentId" in bare).toBe(false);

	const full = log.record({ repo: "/repo", gripe: "g2", context: "tui", agentId: "agent-1" });
	expect(full.context).toBe("tui");
	expect(full.agentId).toBe("agent-1");

	// recent(): newest-LAST ring order, limit honored from the tail.
	expect(log.recent().map((e) => e.gripe)).toEqual(["spawn takes forever", "g2"]);
	expect(log.recent(1).map((e) => e.gripe)).toEqual(["g2"]);
});

test("FrictionLog.record: refuses an empty/whitespace gripe (fail-closed — nothing appended)", async () => {
	const dir = await tmpDir("friction-empty-");
	const log = new FrictionLog(dir);
	expect(() => log.record({ repo: "/repo", gripe: "   " })).toThrow(/gripe required/);
	expect(log.recent()).toEqual([]);
});

test("FrictionLog: persists to <stateDir>/friction.jsonl; a fresh instance hydrates both ring and full history", async () => {
	const dir = await tmpDir("friction-persist-");
	const log = new FrictionLog(dir);
	log.record({ repo: "/repo", gripe: "first" });
	log.record({ repo: "/repo", gripe: "second" });
	await waitForLines(frictionPath(dir), 2);

	const reopened = new FrictionLog(dir);
	expect(reopened.recent().map((e) => e.gripe)).toEqual(["first", "second"]); // ring re-seeded from tail
	expect((await reopened.hydrateAll()).map((e) => e.gripe)).toEqual(["first", "second"]); // full file read
});

// ---------------------------------------------------------------------------
// REST surface
// ---------------------------------------------------------------------------

test("restActionTier: POST /api/friction is operator (default mutation tier), GET is viewer", () => {
	expect(restActionTier("POST", "/api/friction")).toBe("operator");
	expect(restActionTier("GET", "/api/friction")).toBe("viewer");
});

async function liveServer(): Promise<{ url: string; tokens: { admin: string; operator: string; viewer: string }; dir: string }> {
	const dir = await tmpDir("friction-srv-");
	const tokens = { admin: "admin-token-friction1", operator: "operator-token-frict1", viewer: "viewer-token-frictio1" };
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token: tokens.admin, roleTokens: { operator: tokens.operator, viewer: tokens.viewer } });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
	});
	return { url, tokens, dir };
}

const authed = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

test("REST /api/friction: POST then GET round-trips the entry; viewer can read but not write", async () => {
	const { url, tokens, dir } = await liveServer();

	// Viewer is stopped at the single REST gate (mutation ⇒ operator).
	const denied = await fetch(`${url}/api/friction`, { method: "POST", headers: authed(tokens.viewer), body: JSON.stringify({ repo: "/r", gripe: "nope" }) });
	expect(denied.status).toBe(403);

	// Operator capture — the CLI's exact body shape.
	const post = await fetch(`${url}/api/friction`, {
		method: "POST",
		headers: authed(tokens.operator),
		body: JSON.stringify({ repo: "/home/me/proj", context: "cli", gripe: "grr the spinner lies" }),
	});
	expect(post.status).toBe(200);
	const saved = (await post.json()) as FrictionEntry;
	expect(saved.gripe).toBe("grr the spinner lies");
	expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);

	// A second entry, then GET: newest-FIRST for display, viewer-readable.
	await fetch(`${url}/api/friction`, { method: "POST", headers: authed(tokens.operator), body: JSON.stringify({ repo: "/other", gripe: "second gripe", agentId: "chat-1" }) });
	const got = await fetch(`${url}/api/friction`, { headers: authed(tokens.viewer) });
	expect(got.status).toBe(200);
	const { entries } = (await got.json()) as { entries: FrictionEntry[] };
	expect(entries.map((e) => e.gripe)).toEqual(["second gripe", "grr the spinner lies"]);
	expect(entries[0].agentId).toBe("chat-1");

	// ?repo= filters; ?limit= caps.
	const byRepo = await fetch(`${url}/api/friction?repo=${encodeURIComponent("/other")}`, { headers: authed(tokens.viewer) });
	expect(((await byRepo.json()) as { entries: FrictionEntry[] }).entries.map((e) => e.gripe)).toEqual(["second gripe"]);
	const limited = await fetch(`${url}/api/friction?limit=1`, { headers: authed(tokens.viewer) });
	expect(((await limited.json()) as { entries: FrictionEntry[] }).entries.map((e) => e.gripe)).toEqual(["second gripe"]);

	// Durable: the entries reached <stateDir>/friction.jsonl, not just the ring.
	const lines = await waitForLines(frictionPath(dir), 2);
	expect(lines.length).toBe(2);
});

test("REST POST /api/friction: 400 on a missing or empty-after-trim gripe — nothing recorded", async () => {
	const { url, tokens } = await liveServer();
	const missing = await fetch(`${url}/api/friction`, { method: "POST", headers: authed(tokens.operator), body: JSON.stringify({ repo: "/r" }) });
	expect(missing.status).toBe(400);
	const empty = await fetch(`${url}/api/friction`, { method: "POST", headers: authed(tokens.operator), body: JSON.stringify({ repo: "/r", gripe: "   " }) });
	expect(empty.status).toBe(400);
	const malformed = await fetch(`${url}/api/friction`, { method: "POST", headers: authed(tokens.operator), body: "not json" });
	expect(malformed.status).toBe(400);

	const got = await fetch(`${url}/api/friction`, { headers: authed(tokens.viewer) });
	expect(((await got.json()) as { entries: FrictionEntry[] }).entries).toEqual([]);
});

test("SquadManager.recordFriction/frictionRecent: the in-process write path (TUI) lands in the same stateDir ledger", async () => {
	const dir = await tmpDir("friction-mgr-");
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	cleanups.push(() => mgr.stop());

	const entry = mgr.recordFriction({ repo: "/repo", gripe: "tui gripe", context: "tui", agentId: "agent-9" });
	expect(entry.gripe).toBe("tui gripe");
	expect(mgr.frictionRecent().map((e) => e.id)).toEqual([entry.id]);
	expect(() => mgr.recordFriction({ repo: "/repo", gripe: " " })).toThrow(/gripe required/);

	// Same file POST /api/friction reads/writes — one ledger, two doors.
	const lines = await waitForLines(frictionPath(dir), 1);
	expect(JSON.parse(lines[0]).id).toBe(entry.id);
});

// ---------------------------------------------------------------------------
// TUI slash parsing (the /grr seam)
// ---------------------------------------------------------------------------

test("parseSlash: verb lowercased, arg keeps its own casing and internal spacing", () => {
	expect(parseSlash("/stop")).toEqual({ verb: "stop", arg: "" });
	expect(parseSlash("/GRR The Spinner LIES  badly")).toEqual({ verb: "grr", arg: "The Spinner LIES  badly" });
	expect(parseSlash("/grr")).toEqual({ verb: "grr", arg: "" });
	expect(parseSlash("/ grr text")).toEqual({ verb: "grr", arg: "text" });
});
