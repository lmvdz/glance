import { expect, test } from "bun:test";
import { modelDisplayName, modelDisplayNames, providerOf } from "./ModelPicker";

test("an id becomes the name a person would say", () => {
  expect(modelDisplayName("anthropic/claude-3-5-sonnet-20240620")).toBe("Claude 3.5 Sonnet");
  expect(modelDisplayName("openai/gpt-5-6-sol")).toBe("Gpt 5.6 Sol");
  expect(modelDisplayName("")).toBe("default");
});

test("shortening never LOSES — colliding names keep what distinguishes them", () => {
  // The defect this pins, seen on screen: stripping release dates produced two entries both reading
  // "Claude 3.5 Sonnet". Two different models looking like the same one is worse than the long id it
  // replaced, because the reader cannot tell them apart at all.
  const names = modelDisplayNames([
    "anthropic/claude-3-5-sonnet-20240620",
    "anthropic/claude-3-5-sonnet-20241022",
    "anthropic/claude-3-opus-20240229",
  ]);
  const collided = [names.get("anthropic/claude-3-5-sonnet-20240620"), names.get("anthropic/claude-3-5-sonnet-20241022")];
  expect(collided[0]).not.toBe(collided[1]);
  expect(collided[0]).toContain("2024-06-20");
  expect(collided[1]).toContain("2024-10-22");
  // A name that is already unique stays short.
  expect(names.get("anthropic/claude-3-opus-20240229")).toBe("Claude 3 Opus");
});

test("provider is inferred from the id, so grouping needs no extra plumbing", () => {
  expect(providerOf("anthropic/claude-3-opus")).toBe("anthropic");
  expect(providerOf("openai-codex/gpt-5.6-terra")).toBe("openai");
  expect(providerOf("grok-4.5")).toBe("xai");
  expect(providerOf("")).toBe("default");
});

test("grouping follows the DECLARED harness, not a provider guessed from the id", async () => {
  const { groupOf, groupLabel } = await import("./ModelPicker");
  // The giveaway that provider-grouping was wrong: the same model reached through two harnesses.
  const viaOmp = { value: "anthropic/claude-opus-4-5", harness: "omp" };
  const viaClaudeCode = { value: "claude-opus-4-5", harness: "claude-code" };
  expect(groupOf(viaOmp)).toBe("omp");
  expect(groupOf(viaClaudeCode)).toBe("claude-code");
  expect(groupOf(viaOmp)).not.toBe(groupOf(viaClaudeCode));
  expect(groupLabel("omp")).toBe("omp");
});

test("an inferred group says it is inferred", async () => {
  const { groupOf, groupLabel } = await import("./ModelPicker");
  // A guess presented as a fact is exactly what was wrong. When the daemon told us nothing, the
  // heading admits it rather than claiming knowledge it does not have.
  const untagged = { value: "anthropic/claude-3-opus" };
  expect(groupOf(untagged)).toBe("~anthropic");
  expect(groupLabel(groupOf(untagged))).toBe("Anthropic · inferred");
});

test("the same model in two harnesses is not a name collision", async () => {
  const { modelDisplayNames } = await import("./ModelPicker");
  // Disambiguating by date here would suggest a difference that is not there: it is one model, in two
  // places. Collisions are resolved WITHIN a harness, which is where a real ambiguity lives.
  const withinOne = modelDisplayNames(["anthropic/claude-3-5-sonnet-20240620", "anthropic/claude-3-5-sonnet-20241022"]);
  expect(new Set(withinOne.values()).size).toBe(2);
  const acrossHarnesses = modelDisplayNames(["claude-opus-4-5"]);
  expect(acrossHarnesses.get("claude-opus-4-5")).toBe("Claude Opus 4.5");
});
