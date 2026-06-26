import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { SquadEvent } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { "content-type": "application/json", authorization: "Bearer admin", ...init.headers } };
}

async function fixture() {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "plan-ann-state-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-ann-repo-"));
  await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
  await fs.writeFile(path.join(repo, "plans", "ctx", "01-spec.md"), "# Spec\n\n| Field | Value |\n|---|---|\n| Scope | Original |\n");
  const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
  const server = new SquadServer(manager, { port: 0, token: "admin" });
  const url = server.start();
  cleanups.push(async () => {
    server.stop();
    await manager.stop();
    await fs.rm(state, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });
  return { url, repo, manager };
}

test("feature plan annotations preserve anchors and list through the feature route", async () => {
  const { url, repo } = await fixture();
  const feature = await fetch(`${url}/api/features/from-plan`, authed({ method: "POST", body: JSON.stringify({ repo, title: "Collaborative plan", planDir: "plans/ctx" }) })).then((res) => res.json());

  const saved = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/annotations?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ planPath: "plans/ctx/01-spec.md", lineStart: 3, lineEnd: 5, quote: "| Field | Value |", body: "Change scope to explicit acceptance criteria." }) })).then((res) => res.json());
  expect(saved.kind).toBe("plan-annotation");
  expect(saved.annotation.lineStart).toBe(3);

  const listed = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/annotations?repo=${encodeURIComponent(repo)}`, authed()).then((res) => res.json());
  expect(listed).toHaveLength(1);
  expect(listed[0].annotation.planPath).toBe("plans/ctx/01-spec.md");
});

test("plan annotations broadcast live comment events", async () => {
  const { manager, repo } = await fixture();
  const events: SquadEvent[] = [];
  manager.on("event", (event) => events.push(event as SquadEvent));

  const comment = await manager.addComment({ repo, subject: "feat", body: "tighten plan", kind: "plan-annotation", annotation: { planPath: "plans/ctx/01-spec.md", lineStart: 1 } }, "tester");
  await manager.resolveComment(comment.id, "tester");

  expect(events.some((event) => event.type === "comment" && event.comment.id === comment.id)).toBe(true);
  expect(events.some((event) => event.type === "comment-resolved" && event.id === comment.id)).toBe(true);
});
