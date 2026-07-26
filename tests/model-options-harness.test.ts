import { expect, test } from "bun:test";
import { mergeModelOptions } from "../src/server.ts";

test("merging keys on harness AND value, so one model in two harnesses survives as two", () => {
  // Deduping on value alone collapsed them into one entry, which would have quietly undone the whole
  // reason harness is carried: reaching `claude-opus-4-5` through omp and through claude-code are two
  // different destinations for a prompt, not one option listed twice.
  const merged = mergeModelOptions(
    [{ label: "Opus", value: "claude-opus-4-5", harness: "omp" }],
    [{ label: "Opus", value: "claude-opus-4-5", harness: "claude-code" }],
  );
  expect(merged).toHaveLength(2);
  expect(merged.map((option) => option.harness).sort()).toEqual(["claude-code", "omp"]);
});

test("the same model from the same harness is still one entry", () => {
  const merged = mergeModelOptions(
    [{ label: "Opus", value: "claude-opus-4-5", harness: "omp" }],
    [{ label: "Opus", value: "claude-opus-4-5", harness: "omp" }],
  );
  expect(merged).toHaveLength(1);
});

test("untagged options still merge, so an older daemon is not broken by this", () => {
  // Absence of a harness is not a distinct harness — it is one bucket, the same as before.
  const merged = mergeModelOptions([{ label: "A", value: "a" }], [{ label: "A", value: "a" }], [{ label: "B", value: "b" }]);
  expect(merged.map((option) => option.value)).toEqual(["a", "b"]);
});

test("every harness is asked, not just whichever agent answered first", async () => {
  // The deeper bug: modelOptions() returned the FIRST live agent's list and stopped, so a fleet
  // running two harnesses showed one and silently hid the other. One agent per harness is asked —
  // the answer is a property of the harness, and querying forty units for it would be forty round
  // trips for one answer.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { SquadManager } = await import("../src/squad-manager.ts");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "models-harness-"));
  const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "models-harness-wt-"));
  const mgr = new SquadManager({ stateDir, worktreeBase });
  await mgr.start();

  const host = mgr as unknown as { agents: Map<string, unknown> };
  const asked: string[] = [];
  // The runtime shape is `{ id, provider }` — and `provider/id` is exactly where a value like
  // "anthropic/claude-opus-4-5" comes from, which is the string that made provider-grouping look
  // plausible in the first place.
  const fake = (id: string, harness: string, models: Array<{ id: string; provider?: string }>) => [id, {
    dto: { id, name: id, harness, status: "working", pending: [] },
    options: { harness },
    transcript: [],
    agent: {
      isAlive: true,
      async getAvailableModels() { asked.push(harness); return { models }; },
    },
  }] as const;

  host.agents.set(...fake("a1", "omp", [{ id: "claude-opus-4-5", provider: "anthropic" }]));
  host.agents.set(...fake("a2", "omp", [{ id: "claude-opus-4-5", provider: "anthropic" }]));
  host.agents.set(...fake("b1", "claude-code", [{ id: "claude-opus-4-5" }, { id: "claude-sonnet-5" }]));

  const options = await mgr.modelOptions();
  // Both harnesses answered, and the duplicate agent on `omp` was not asked twice.
  expect(asked.sort()).toEqual(["claude-code", "omp"]);
  expect(options.filter((option) => option.harness === "omp")).toHaveLength(1);
  expect(options.filter((option) => option.harness === "claude-code")).toHaveLength(2);
  // The SAME model, reached two ways: omp namespaces it `anthropic/…`, claude-code does not. Both are
  // present, and the harness tag is what tells them apart — the ids alone never could.
  expect(options.find((option) => option.harness === "omp")?.value).toBe("anthropic/claude-opus-4-5");
  expect(options.filter((option) => option.harness === "claude-code").map((o) => o.value).sort()).toEqual(["claude-opus-4-5", "claude-sonnet-5"]);

  await mgr.stop();
  for (const dir of [stateDir, worktreeBase]) await fs.rm(dir, { recursive: true, force: true });
});

test("a harness that cannot be asked does not silence the others", async () => {
  // Absence-as-answer: one failing harness used to be indistinguishable from no models at all.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { SquadManager } = await import("../src/squad-manager.ts");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "models-harness-fail-"));
  const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "models-harness-fail-wt-"));
  const mgr = new SquadManager({ stateDir, worktreeBase });
  await mgr.start();
  const host = mgr as unknown as { agents: Map<string, unknown> };
  host.agents.set("broken", {
    dto: { id: "broken", name: "broken", harness: "grok", status: "working", pending: [] },
    options: { harness: "grok" }, transcript: [],
    agent: { isAlive: true, async getAvailableModels() { throw new Error("harness down"); } },
  });
  host.agents.set("fine", {
    dto: { id: "fine", name: "fine", harness: "omp", status: "working", pending: [] },
    options: { harness: "omp" }, transcript: [],
    agent: { isAlive: true, async getAvailableModels() { return { models: [{ id: "x" }] }; } },
  });

  const options = await mgr.modelOptions();
  expect(options.map((option) => option.harness)).toEqual(["omp"]);
  await mgr.stop();
  for (const dir of [stateDir, worktreeBase]) await fs.rm(dir, { recursive: true, force: true });
});
