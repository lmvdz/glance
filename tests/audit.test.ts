/**
 * Append-only JSONL audit log (src/audit.ts) — deterministic, no model tokens.
 * Covers monotonic ids, entry normalization, append/read round-trip, newest-first
 * order, exact-match filters, the limit cap, and torn-trailing-line tolerance.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendAudit, makeAuditEntry, nextAuditId, readAudit } from "../src/audit.ts";

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "audit-"));
}

test("nextAuditId strictly increases even within the same millisecond", () => {
	const a = nextAuditId(1000);
	const b = nextAuditId(1000); // same clock value ⇒ must bump
	const c = nextAuditId(1000);
	expect(b).toBeGreaterThan(a);
	expect(c).toBeGreaterThan(b);
});

test("makeAuditEntry normalizes the actor object to its id and defaults outcome", () => {
	const e = makeAuditEntry({
		actor: { id: "u1", displayName: "User One", origin: "local" },
		action: "prompt",
		target: "agent-x",
	});
	expect(e.actor).toBe("u1");
	expect(e.outcome).toBe("ok");
	expect(e.target).toBe("agent-x");
	expect(typeof e.id).toBe("number");
	// A string actor passes straight through; null target stays null.
	const e2 = makeAuditEntry({ actor: "raw-id", action: "kill" });
	expect(e2.actor).toBe("raw-id");
	expect(e2.target).toBeNull();
});

test("append/read round-trips newest-first", async () => {
	const dir = await tmpDir();
	await appendAudit(dir, makeAuditEntry({ actor: "a", action: "create", target: "t1" }, 1));
	await appendAudit(dir, makeAuditEntry({ actor: "b", action: "prompt", target: "t2" }, 2));
	const out = await readAudit(dir);
	expect(out.map((e) => e.action)).toEqual(["prompt", "create"]); // newest first
});

test("readAudit on a missing log returns empty, not a throw", async () => {
	const dir = await tmpDir();
	expect(await readAudit(dir)).toEqual([]);
});

test("exact-match filters and the limit cap", async () => {
	const dir = await tmpDir();
	await appendAudit(dir, makeAuditEntry({ actor: "a", action: "create", target: "t1" }, 1));
	await appendAudit(dir, makeAuditEntry({ actor: "a", action: "prompt", target: "t1" }, 2));
	await appendAudit(dir, makeAuditEntry({ actor: "b", action: "prompt", target: "t2" }, 3));

	expect((await readAudit(dir, { action: "prompt" })).map((e) => e.actor)).toEqual(["b", "a"]);
	expect((await readAudit(dir, { actor: "a" })).length).toBe(2);
	expect((await readAudit(dir, { target: "t2" })).map((e) => e.action)).toEqual(["prompt"]);
	expect((await readAudit(dir, { limit: 1 }))[0].actor).toBe("b"); // newest, capped to 1
	expect((await readAudit(dir, { limit: 0 })).length).toBe(3); // <=0 ⇒ no cap
});

test("a torn trailing line is skipped, not fatal", async () => {
	const dir = await tmpDir();
	await appendAudit(dir, makeAuditEntry({ actor: "a", action: "create", target: "t1" }, 1));
	await fs.appendFile(path.join(dir, "audit.jsonl"), '{"id":2,"partial'); // crash mid-write
	const out = await readAudit(dir);
	expect(out.length).toBe(1);
	expect(out[0].action).toBe("create");
});
