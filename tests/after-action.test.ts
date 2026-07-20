import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AfterActionInput, composeAfterAction, listAfterActions, readAfterAction, saveAfterAction, selectTerminalReaps, type TerminalReapCandidate } from "../src/after-action.ts";

const NOW = 1_784_500_000_000;

function input(over: Partial<AfterActionInput> = {}): AfterActionInput {
	return {
		id: "ompsq-447-abc",
		name: "ompsq-447",
		repo: "/tmp/repo",
		branch: "squad/ompsq-447",
		issueIdentifier: "OMPSQ-447",
		issueUrl: "https://plane.example/OMPSQ-447",
		goal: "DoneProof records are never re-validated",
		terminalReason: 'node "escalate" exceeded its visit cap (2)',
		terminalAt: NOW - 3 * 86_400_000,
		trajectory: ["Implement", "Verify", "Fixup", "Verify", "Escalate", "Verify"],
		visits: { implement: 1, verify: 7, fixup: 3, escalate: 2 },
		gateTail: "3012 pass\n1 fail\nerror: script \"test\" exited with code 1",
		commitsAhead: 0,
		dirtyFiles: 0,
		now: NOW,
		...over,
	};
}

test("compose: a unit that left nothing behind classifies as environment — the gate was red at the fork point", () => {
	const r = composeAfterAction(input());
	expect(r.classification).toBe("environment");
	expect(r.markdown).toContain("belongs to the base branch");
	expect(r.markdown).toContain("OMPSQ-447");
	expect(r.markdown).toContain('node "escalate" exceeded its visit cap (2)');
	expect(r.markdown).toContain("Implement → Verify → Fixup");
	expect(r.markdown).toContain("no commits ahead of base, no uncommitted edits");
});

test("compose: a unit with a work product classifies as implementation and points at glance diff", () => {
	const r = composeAfterAction(input({ commitsAhead: 2, dirtyFiles: 1 }));
	expect(r.classification).toBe("implementation");
	expect(r.markdown).toContain("glance diff ompsq-447-abc");
	expect(r.markdown).toContain("2 commit(s) ahead of base, 1 uncommitted file(s)");
});

test("compose: unknown evidence (-1) refuses a fault call instead of guessing", () => {
	const r = composeAfterAction(input({ commitsAhead: -1 }));
	expect(r.classification).toBe("unknown");
	expect(r.markdown).toContain("no fault call is made");
});

test("compose: the gate tail is redacted and capped, and a secret never survives into the markdown", () => {
	const secret = "sk-ant-api03-verysecretvalue1234567890abcdefghijklmnop";
	const r = composeAfterAction(input({ gateTail: `${"x".repeat(5_000)}\nAPI_KEY=${secret}\nfinal line` }));
	expect(r.markdown).not.toContain(secret);
	expect(r.markdown).toContain("final line");
	const fenced = r.markdown.split("```")[1] ?? "";
	expect(fenced.length).toBeLessThanOrEqual(2_100);
});

function candidate(over: Partial<TerminalReapCandidate> = {}): TerminalReapCandidate {
	return { id: "u1", terminalAt: NOW - 86_400_000, commitsAhead: 0, dirtyFiles: 0, hasReport: true, ...over };
}

const GRACE = 21_600_000;

test("reap policy: a reported, empty-handed corpse past grace reaps", () => {
	const { reap, held } = selectTerminalReaps({ candidates: [candidate()], now: NOW, graceMs: GRACE });
	expect(reap).toEqual(["u1"]);
	expect(held).toEqual([]);
});

test("reap policy: no report ⇒ held — the post-mortem is the precondition for disposal", () => {
	const { reap, held } = selectTerminalReaps({ candidates: [candidate({ hasReport: false })], now: NOW, graceMs: GRACE });
	expect(reap).toEqual([]);
	expect(held[0]?.reason).toContain("report");
});

test("reap policy: within grace ⇒ held, so a fresh death stays visible for a working day", () => {
	const { reap } = selectTerminalReaps({ candidates: [candidate({ terminalAt: NOW - GRACE + 1 })], now: NOW, graceMs: GRACE });
	expect(reap).toEqual([]);
});

test("reap policy: salvageable or UNKNOWN work fails closed — exact-zero equality, never reap what we couldn't verify", () => {
	const cases: Partial<TerminalReapCandidate>[] = [{ commitsAhead: 1 }, { commitsAhead: -1 }, { dirtyFiles: 3 }, { dirtyFiles: -1 }];
	for (const over of cases) {
		const { reap, held } = selectTerminalReaps({ candidates: [candidate(over)], now: NOW, graceMs: GRACE });
		expect(reap).toEqual([]);
		expect(held).toHaveLength(1);
	}
});

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aar-test-"));
afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

test("persistence: save → read → list round-trips through the Schema, and a corrupt record is skipped not fatal", async () => {
	const report = composeAfterAction(input());
	expect(await saveAfterAction(tmp, report)).toBe(true);
	expect(await readAfterAction(tmp, report.id)).toEqual(report);
	await fs.writeFile(path.join(tmp, "after-action", "corrupt.json"), "{not json");
	await fs.writeFile(path.join(tmp, "after-action", "wrong-shape.json"), JSON.stringify({ id: 1 }));
	const list = await listAfterActions(tmp);
	expect(list).toEqual([report]);
});

test("persistence: a path-traversal id cannot escape the after-action dir", async () => {
	const evil = composeAfterAction(input({ id: "../../escape" }));
	expect(await saveAfterAction(tmp, evil)).toBe(true);
	const names = await fs.readdir(path.join(tmp, "after-action"));
	expect(names.some((n) => n.includes(".._"))).toBe(true);
	await expect(fs.stat(path.join(tmp, "escape.json"))).rejects.toThrow();
});
