import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isPlanDocPath, planDocDiffSince, planDocHeadRevision, readPlanDoc, resolveSafeDocPath , readUnitPlan } from "../src/plan-doc.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tmpRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-doc-unit-"));
  cleanups.push(() => fs.rm(repo, { recursive: true, force: true }));
  return repo;
}

test("resolveSafeDocPath refuses a path that escapes the repo root", () => {
  const repo = "/tmp/some-repo";
  expect(resolveSafeDocPath(repo, "plans/foo.md")).toBe(path.resolve(repo, "plans/foo.md"));
  expect(resolveSafeDocPath(repo, "../../etc/passwd")).toBeUndefined();
  expect(resolveSafeDocPath(repo, "/etc/passwd")).toBeUndefined();
});

test("isPlanDocPath: the KEYSTONE gate — only plan markdown under plans/ (security review HIGH 1)", () => {
  // Accepted: plan markdown under plans/, any depth.
  expect(isPlanDocPath("plans/foo/01-bar.md")).toBe(true);
  expect(isPlanDocPath("plans/x.md")).toBe(true);
  expect(isPlanDocPath("plans/a/b/c/deep.MD")).toBe(true); // case-insensitive extension
  // Rejected: source/config files a passing vote must NEVER be able to commit.
  expect(isPlanDocPath("src/server.ts")).toBe(false);
  expect(isPlanDocPath("package.json")).toBe(false);
  expect(isPlanDocPath("plans/evil.ts")).toBe(false); // under plans/ but not markdown
  expect(isPlanDocPath("plans/../src/server.ts.md")).toBe(false); // traversal out of plans/
  expect(isPlanDocPath("plans/../../etc/passwd.md")).toBe(false);
  expect(isPlanDocPath("notplans/x.md")).toBe(false); // not rooted at plans/
  expect(isPlanDocPath("plansX/x.md")).toBe(false); // prefix, not the plans/ dir
  expect(isPlanDocPath("plans")).toBe(false); // the dir itself, not a doc
  expect(isPlanDocPath("plans/")).toBe(false);
  expect(isPlanDocPath("/abs/plans/x.md")).toBe(false); // absolute
  expect(isPlanDocPath("")).toBe(false);
  expect(isPlanDocPath("plans/./x.md")).toBe(false); // current-dir segment
});

test("readPlanDoc returns undefined for a missing file, not a throw", async () => {
  const repo = await tmpRepo();
  expect(await readPlanDoc(repo, "plans/missing.md")).toBeUndefined();
});

test("planDocHeadRevision is empty string when the dir isn't a git repo", async () => {
  const repo = await tmpRepo();
  await fs.mkdir(path.join(repo, "plans"), { recursive: true });
  await fs.writeFile(path.join(repo, "plans", "a.md"), "# A\n");
  expect(await planDocHeadRevision(repo, "plans/a.md")).toBe("");
});

test("planDocDiffSince degrades to an empty diff when `since` is blank", async () => {
  const repo = await tmpRepo();
  await fs.mkdir(path.join(repo, "plans"), { recursive: true });
  await fs.writeFile(path.join(repo, "plans", "a.md"), "# A\n");
  const result = await planDocDiffSince(repo, "plans/a.md", "");
  expect(result.diff).toBe("");
});

test("readUnitPlan reads a unit's own plan, and refuses to leave its worktree", async () => {
	// Found by using the product: an "Approve plan" gate arrived carrying only a title and two
	// buttons, while the plan sat in the unit's worktree as plan.md.
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unit-plan-"));
	await fs.writeFile(path.join(dir, "plan.md"), "# the plan\n1. do the thing\n");
	const doc = await readUnitPlan(dir);
	expect(doc?.path).toBe("plan.md");
	expect(doc?.content).toContain("do the thing");

	// No worktree is "no plan", never a read of somewhere else.
	expect(await readUnitPlan(undefined)).toBeUndefined();
	expect(await readUnitPlan("")).toBeUndefined();

	// A unit with no plan file gets an honest absence rather than the nearest markdown.
	const empty = await fs.mkdtemp(path.join(os.tmpdir(), "unit-noplan-"));
	await fs.writeFile(path.join(empty, "NOTES.md"), "not a plan");
	expect(await readUnitPlan(empty)).toBeUndefined();
});
