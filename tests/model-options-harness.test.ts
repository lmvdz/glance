import { expect, test } from "bun:test";
import { listHarnesses, listHarnessTiers } from "../src/harness-registry.ts";
import { harnessDefaultModelOptions, mergeModelOptions } from "../src/server.ts";

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

// ── harnessDefaultModelOptions (post-ship harness-dropdown fix) ──────────────────────────────────
// `manager.modelOptions()` can only ask a harness that already has a LIVE agent connected — a
// chicken-and-egg gap at the exact moment the create-agent surface needs an answer: before any agent
// exists. This is the static, harness-registry-backed fallback that fixes the production symptom
// (the webapp's model/harness picker showing nothing but a placeholder default) independent of
// whether any agent happens to be running.

test("harnessDefaultModelOptions offers exactly one blank-value default entry per harness that is both listed (verified, or unverified under the env escape hatch) AND bin-detected right now — never a harness whose binary isn't actually on PATH", () => {
  const options = harnessDefaultModelOptions();
  const available = new Set(listHarnesses().map((h) => h.name));
  const detected = new Set(listHarnessTiers().filter((t) => t.binDetected).map((t) => t.name));
  for (const option of options) {
    expect(option.value).toBe("");
    expect(option.harness).toBeDefined();
    expect(available.has(option.harness!)).toBe(true);
    expect(detected.has(option.harness!)).toBe(true);
  }
  // omp ships as a devDependency of this very repo, so it is always both verified and bin-detected
  // here — the sanity check that this isn't vacuously empty.
  expect(options.find((o) => o.harness === "omp")).toEqual({ label: "omp default", value: "", harness: "omp" });
});

test("harnessDefaultModelOptions merges additively alongside live-reported models for the SAME harness — never replaces a real model list with just the default", () => {
  const merged = mergeModelOptions(harnessDefaultModelOptions(), [{ label: "Real Omp Model", value: "anthropic/claude-opus-4-5", harness: "omp" }]);
  const ompEntries = merged.filter((o) => o.harness === "omp");
  expect(ompEntries.map((o) => o.value).sort()).toEqual(["", "anthropic/claude-opus-4-5"]);
});
