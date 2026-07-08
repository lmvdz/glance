import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { "content-type": "application/json", authorization: "Bearer admin", ...init.headers } };
}

async function git(repo: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function fixture() {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "plan-doc-state-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-doc-repo-"));
  await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
  const docRelPath = "plans/ctx/01-spec.md";
  await fs.writeFile(path.join(repo, docRelPath), "## Summary\n\noriginal text\n");
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);
  const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
  const server = new SquadServer(manager, { port: 0, token: "admin" });
  const url = server.start();
  cleanups.push(async () => {
    server.stop();
    await manager.stop();
    await fs.rm(state, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });
  return { url, repo, manager, docRelPath };
}

test("GET /api/plan-doc reads a single doc with its head revision", async () => {
  const { url, repo, docRelPath } = await fixture();
  const res = await fetch(`${url}/api/plan-doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(docRelPath)}`, authed());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(docRelPath);
  expect(body.content).toContain("original text");
  expect(typeof body.sha).toBe("string");
  expect(body.sha.length).toBeGreaterThan(0);
});

test("GET /api/plan-doc 404s for a path outside the repo", async () => {
  const { url, repo } = await fixture();
  const res = await fetch(`${url}/api/plan-doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent("../../etc/passwd")}`, authed());
  expect(res.status).toBe(404);
});

test("GET /api/plan-doc/diff renders the change since a prior revision", async () => {
  const { url, repo, docRelPath } = await fixture();
  const first = await fetch(`${url}/api/plan-doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(docRelPath)}`, authed()).then((r) => r.json());
  const sinceSha = first.sha;

  await fs.writeFile(path.join(repo, docRelPath), "## Summary\n\nupdated text\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "revise"]);

  const res = await fetch(`${url}/api/plan-doc/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(docRelPath)}&since=${encodeURIComponent(sinceSha)}`, authed());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.diff).toContain("-original text");
  expect(body.diff).toContain("+updated text");
  expect(body.sha).not.toBe(sinceSha);
});

test("GET /api/plan-doc/diff degrades to an empty diff for an unrecognized revision", async () => {
  const { url, repo, docRelPath } = await fixture();
  const res = await fetch(`${url}/api/plan-doc/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(docRelPath)}&since=${encodeURIComponent("0".repeat(40))}`, authed());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.diff).toBe("");
});

test("plan annotations accept an optional heading anchor", async () => {
  const { url, repo, docRelPath } = await fixture();
  const feature = await fetch(`${url}/api/features/from-plan`, authed({ method: "POST", body: JSON.stringify({ repo, title: "Design review plan", planDir: "plans/ctx" }) })).then((res) => res.json());

  const saved = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/annotations?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ planPath: docRelPath, heading: "Summary", body: "Tighten this section." }) })).then((res) => res.json());
  expect(saved.kind).toBe("plan-annotation");
  expect(saved.annotation.heading).toBe("Summary");

  const listed = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/annotations?repo=${encodeURIComponent(repo)}`, authed()).then((res) => res.json());
  expect(listed[0].annotation.heading).toBe("Summary");
});
