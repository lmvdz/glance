import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { planDocDiffSince, planDocHeadRevision, readPlanDoc, resolveSafeDocPath } from "../src/plan-doc.ts";

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
