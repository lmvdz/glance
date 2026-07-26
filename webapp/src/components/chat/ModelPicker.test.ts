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
