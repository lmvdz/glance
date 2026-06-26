import { expect, test } from "bun:test";
import { mergeModelOptions, modelOptionsFromEnv } from "../src/server.ts";
import { modelOptionsFromRuntime, profileOptionsFromEnv } from "../src/squad-manager.ts";

test("modelOptionsFromEnv exposes default plus unique configured specs", () => {
	const models = modelOptionsFromEnv({ OMP_SQUAD_MODELS: " anthropic/opus,openai/gpt-5.2\nanthropic/opus " });
	expect(models).toEqual([
		{ label: "omp default", value: "" },
		{ label: "anthropic/opus", value: "anthropic/opus" },
		{ label: "openai/gpt-5.2", value: "openai/gpt-5.2" },
	]);
});

test("mergeModelOptions adds live omp models after configured models", () => {
	expect(mergeModelOptions(
		modelOptionsFromEnv({ OMP_SQUAD_MODELS: "anthropic/claude-opus-4-5" }),
		[{ label: "anthropic/claude-sonnet-4-5", value: "anthropic/claude-sonnet-4-5" }],
		[{ label: "duplicate", value: "anthropic/claude-opus-4-5" }],
	)).toEqual([
		{ label: "omp default", value: "" },
		{ label: "anthropic/claude-opus-4-5", value: "anthropic/claude-opus-4-5" },
		{ label: "anthropic/claude-sonnet-4-5", value: "anthropic/claude-sonnet-4-5" },
	]);
});

test("modelOptionsFromRuntime maps omp provider models", () => {
	expect(modelOptionsFromRuntime([
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "openai", id: "gpt-5.2" },
	])).toEqual([
		{ label: "anthropic/claude-sonnet-4-5", value: "anthropic/claude-sonnet-4-5" },
		{ label: "openai/gpt-5.2", value: "openai/gpt-5.2" },
	]);
});

test("profileOptionsFromEnv exposes default or configured profiles", () => {
	expect(profileOptionsFromEnv({ OMP_SQUAD_PROFILES: "" })[0]).toMatchObject({ id: "default", runtime: "omp-operator" });
	expect(profileOptionsFromEnv({
		OMP_SQUAD_PROFILES: JSON.stringify([{ id: "review", name: "Reviewer", model: "anthropic/opus", approvalMode: "write", capabilities: ["read"] }]),
	})).toEqual([
		{ id: "review", name: "Reviewer", runtime: "omp-operator", model: "anthropic/opus", approvalMode: "write", capabilities: ["read"], memory: undefined, description: undefined, default: false },
	]);
});
