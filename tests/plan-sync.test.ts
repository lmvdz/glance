import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { statusForPlaneState, syncPlanStatuses } from "../src/plan-sync.ts";
import type { IssueRef } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

test("statusForPlaneState: closes and starts, never reopens, ignores backlog", () => {
	expect(statusForPlaneState("completed", "open")).toBe("done");
	expect(statusForPlaneState("completed", "in_progress")).toBe("done");
	expect(statusForPlaneState("completed", "done")).toBeUndefined(); // already right
	expect(statusForPlaneState("cancelled", "open")).toBe("cancelled");
	expect(statusForPlaneState("started", "open")).toBe("in_progress");
	expect(statusForPlaneState("started", "diverged")).toBeUndefined(); // only from open-ish
	expect(statusForPlaneState("started", "done")).toBeUndefined(); // NEVER auto-reopen
	expect(statusForPlaneState("backlog", "open")).toBeUndefined();
	expect(statusForPlaneState(undefined, "open")).toBeUndefined();
});

async function planRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plansync-"));
	tmps.push(repo);
	const dir = path.join(repo, "plans", "demo");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "00-overview.md"), "# Overview — demo\n\nSTATUS: open\n");
	await fs.writeFile(path.join(dir, "01-landed.md"), "# Landed concern\nSTATUS: open\nPRIORITY: p1\nPLANE: OMPSQ-100\n\n## Goal\nx\n");
	await fs.writeFile(path.join(dir, "02-started.md"), "# Started concern\nSTATUS: open\nPLANE: OMPSQ-101\n\n## Goal\ny\n");
	await fs.writeFile(path.join(dir, "03-human-done.md"), "# Human says done\nSTATUS: done\nPLANE: OMPSQ-102\n\n## Goal\nz\n");
	await fs.writeFile(path.join(dir, "04-unlinked.md"), "# No tracker pointer\nSTATUS: open\n\n## Goal\nw\n");
	return repo;
}

const issue = (identifier: string, state: string): IssueRef => ({ id: identifier, identifier, name: identifier, state });

test("syncPlanStatuses reconciles PLANE-linked concerns, surfaces terminal conflicts, leaves the rest alone", async () => {
	const repo = await planRepo();
	const logs: string[] = [];
	const result = await syncPlanStatuses({
		repo,
		listIssues: async () => [issue("OMPSQ-100", "completed"), issue("OMPSQ-101", "started"), issue("OMPSQ-102", "started")],
		log: (m) => logs.push(m),
	});

	expect(result.updated.map((u) => `${u.planeId}:${u.from}→${u.to}`).sort()).toEqual(["OMPSQ-100:open→done", "OMPSQ-101:open→in_progress"]);
	expect(await fs.readFile(path.join(repo, "plans/demo/01-landed.md"), "utf8")).toContain("STATUS: done");
	expect(await fs.readFile(path.join(repo, "plans/demo/02-started.md"), "utf8")).toContain("STATUS: in_progress");
	// The doc a human marked done is NOT reopened; the drift is surfaced instead.
	expect(await fs.readFile(path.join(repo, "plans/demo/03-human-done.md"), "utf8")).toContain("STATUS: done");
	expect(result.conflicts).toEqual([{ path: "plans/demo/03-human-done.md", planeId: "OMPSQ-102", doc: "done", plane: "started" }]);
	// Unlinked concern untouched.
	expect(await fs.readFile(path.join(repo, "plans/demo/04-unlinked.md"), "utf8")).toContain("STATUS: open");
	expect(logs.some((l) => l.includes("not auto-reopening"))).toBe(true);
});

test("syncPlanStatuses changes nothing when the tracker is unreachable", async () => {
	const repo = await planRepo();
	const result = await syncPlanStatuses({ repo, listIssues: async () => null });
	expect(result.updated).toEqual([]);
	expect(await fs.readFile(path.join(repo, "plans/demo/01-landed.md"), "utf8")).toContain("STATUS: open");
});

test("syncPlanStatuses is idempotent — a second pass is a no-op", async () => {
	const repo = await planRepo();
	const issues = async () => [issue("OMPSQ-100", "completed"), issue("OMPSQ-101", "started")];
	await syncPlanStatuses({ repo, listIssues: issues });
	const second = await syncPlanStatuses({ repo, listIssues: issues });
	expect(second.updated).toEqual([]);
});
