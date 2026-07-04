/**
 * Done-write gating (concern 04): plan-sync's ⇒done branch is gated on a DoneProof (concern 01's
 * ledger). Plane-completed WITH proof writes the bare `done` token; WITHOUT proof it writes
 * `done (unproven — closed in Plane without land proof)` and surfaces the concern in
 * `result.unproven` — a legitimate human override, allowed but never invisible.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isClosedConcernStatus, concernDocStatus } from "../src/features.ts";
import { syncPlanStatuses } from "../src/plan-sync.ts";
import type { IssueRef } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function planRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plansync-proof-"));
	tmps.push(repo);
	const dir = path.join(repo, "plans", "demo");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "00-overview.md"), "# Overview — demo\n\nSTATUS: open\n");
	await fs.writeFile(path.join(dir, "01-proven.md"), "# Proven concern\nSTATUS: open\nPRIORITY: p1\nPLANE: OMPSQ-200\n\n## Goal\nx\n");
	await fs.writeFile(path.join(dir, "02-unproven.md"), "# Unproven concern\nSTATUS: open\nPLANE: OMPSQ-201\n\n## Goal\ny\n");
	return repo;
}

const issue = (identifier: string, state: string): IssueRef => ({ id: identifier, identifier, name: identifier, state });

test("Plane-completed WITH a DoneProof writes the bare `done` token", async () => {
	const repo = await planRepo();
	const result = await syncPlanStatuses({
		repo,
		listIssues: async () => [issue("OMPSQ-200", "completed")],
		hasProof: (id) => id === "OMPSQ-200",
	});

	expect(result.updated).toEqual([{ path: "plans/demo/01-proven.md", planeId: "OMPSQ-200", from: "open", to: "done" }]);
	expect(result.unproven).toEqual([]);
	const text = await fs.readFile(path.join(repo, "plans/demo/01-proven.md"), "utf8");
	expect(text).toContain("STATUS: done");
	expect(text).not.toContain("unproven");
});

test("Plane-completed WITHOUT a DoneProof writes the unproven marker and surfaces it in result.unproven", async () => {
	const repo = await planRepo();
	const result = await syncPlanStatuses({
		repo,
		listIssues: async () => [issue("OMPSQ-201", "completed")],
		hasProof: () => false,
	});

	expect(result.unproven).toEqual([{ path: "plans/demo/02-unproven.md", planeId: "OMPSQ-201" }]);
	const text = await fs.readFile(path.join(repo, "plans/demo/02-unproven.md"), "utf8");
	expect(text).toContain("STATUS: done (unproven — closed in Plane without land proof)");
	expect(result.updated).toEqual([{ path: "plans/demo/02-unproven.md", planeId: "OMPSQ-201", from: "open", to: "done (unproven — closed in Plane without land proof)" }]);
});

test("a subsequent sync tick against the now-terminal unproven doc makes no further write (one-way transition)", async () => {
	const repo = await planRepo();
	const listIssues = async () => [issue("OMPSQ-201", "completed")];
	const first = await syncPlanStatuses({ repo, listIssues, hasProof: () => false });
	expect(first.unproven).toHaveLength(1);

	const second = await syncPlanStatuses({ repo, listIssues, hasProof: () => false });
	expect(second.updated).toEqual([]);
	expect(second.unproven).toEqual([]);
});

test("the unproven marker still parses as closed via concernDocStatus + isClosedConcernStatus (read-path is unaffected)", async () => {
	const repo = await planRepo();
	await syncPlanStatuses({ repo, listIssues: async () => [issue("OMPSQ-201", "completed")], hasProof: () => false });

	const status = await concernDocStatus(repo, "plans/demo/02-unproven.md");
	expect(status).toBe("done"); // the parenthetical is a human-legible annotation only — the token is still "done"
	expect(isClosedConcernStatus(status ?? "")).toBe(true);
});
