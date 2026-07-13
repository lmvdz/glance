import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER, harnessLineage, modelLineage, resolveProvider } from "../src/model-lineage.ts";
import { modelFamily } from "../src/omp-graph/attribution.ts";

describe("modelLineage", () => {
	test("provider-qualified specs (the poll-backfill shape) map by provider", () => {
		expect(modelLineage("anthropic/claude-sonnet-4-5")).toBe("anthropic");
		expect(modelLineage("openai/gpt-5")).toBe("openai");
		expect(modelLineage("google-vertex/gemini-2.5-pro")).toBe("google");
		expect(modelLineage("google/gemini-2.5-flash")).toBe("google");
	});

	test("bare families map to vendor lineage", () => {
		expect(modelLineage("sonnet")).toBe("anthropic");
		expect(modelLineage("opus")).toBe("anthropic");
		expect(modelLineage("haiku")).toBe("anthropic");
		expect(modelLineage("fable")).toBe("anthropic"); // claude-fable-* is Anthropic, not its own vendor
		expect(modelLineage("gpt-5.2")).toBe("openai");
		expect(modelLineage("gemini-2.5-pro")).toBe("google");
	});

	test("a raw string that IS ALREADY a family name (research-sirvir/02's family-keyed namespace) resolves directly", () => {
		// `modelFamily("openai")` itself returns `"other"` (its keyword match looks for "gpt"/"codex",
		// not the literal string "openai") — a naive `FAMILY_LINEAGE[modelFamily(raw)]` lookup would
		// wrongly answer "unknown" for the family's own name. This is exactly the shape
		// `smart-spawn.ts`'s `eligibleCandidates` cross-provider guard and the family-keyed scoreboard
		// pass around, so it must resolve correctly.
		expect(modelLineage("openai")).toBe("openai");
		expect(modelLineage("gemini")).toBe("google");
	});

	test("unreadable / unknown never guesses", () => {
		expect(modelLineage(undefined)).toBe("unknown");
		expect(modelLineage("")).toBe("unknown");
		expect(modelLineage("   ")).toBe("unknown");
		expect(modelLineage("mistral/large")).toBe("unknown"); // unknown provider → honest unknown
		expect(modelLineage("some-random-model")).toBe("unknown");
	});

	test("drift guard: every modelFamily output maps to a defined lineage", () => {
		// The family keywords modelFamily can emit; if it grows one, add it here AND in FAMILY_LINEAGE.
		const probes: Record<string, string> = {
			fable: "claude-fable-5",
			opus: "claude-opus-4-8",
			sonnet: "claude-sonnet-4-5",
			haiku: "claude-haiku-4-5",
			openai: "gpt-5.5",
			gemini: "gemini-2.5-pro",
			xai: "grok-4.5",
			other: "mistral-large",
			unknown: "",
		};
		const seen = new Set(Object.values(probes).map((m) => modelFamily(m)));
		expect(seen).toEqual(new Set(["fable", "opus", "sonnet", "haiku", "openai", "gemini", "xai", "other", "unknown"]));
		for (const m of Object.values(probes)) {
			expect(["anthropic", "openai", "google", "xai", "unknown"]).toContain(modelLineage(m));
		}
	});

	test("xai/grok: both provider spellings, the bare family, and concrete model ids", () => {
		// openrouter's catalog ships `x-ai/…`; xAI's first-party spec is `xai/…`. Both are real.
		expect(modelLineage("x-ai/grok-4.5")).toBe("xai");
		expect(modelLineage("xai/grok-4.5")).toBe("xai");
		// bare family name (the family-keyed scoreboard shape) and concrete ids
		expect(modelLineage("grok")).toBe("xai");
		expect(modelLineage("grok-4.5")).toBe("xai");
		expect(modelLineage("grok-composer-2.5-fast")).toBe("xai");
	});

	test("'grok' is matched as a TOKEN, not a substring — an English verb must not fabricate a vendor", () => {
		// This family feeds the rate-limit bucket: mis-mapping a vendor routes a unit around its real
		// provider's cap. `includes("grok")` would have called all of these xAI.
		expect(modelFamily("ollama/my-grokking-model")).toBe("other");
		expect(modelLineage("ollama/my-grokking-model")).toBe("unknown");
		expect(modelLineage("mistral/grokking-experiment")).toBe("unknown");
		expect(modelLineage("some-grokked-model")).toBe("unknown");
		// ...while every real xAI id shape still resolves.
		expect(modelLineage("x-ai/grok-4.5")).toBe("xai");
		expect(modelLineage("grok_4_5")).toBe("xai"); // underscore is a token boundary too
	});
});

describe("harnessLineage", () => {
	test("vendor-pinned harnesses only", () => {
		expect(harnessLineage("gemini")).toBe("google");
		expect(harnessLineage("claude-code")).toBe("anthropic");
		expect(harnessLineage("codex")).toBe("openai");
		// grok's CLI serves only xAI models, so the harness name alone is a sound vendor claim.
		expect(harnessLineage("grok")).toBe("xai");
		expect(harnessLineage("GROK")).toBe("xai"); // case-insensitive, like the others
	});
	test("multi-model runtimes do not imply a vendor", () => {
		expect(harnessLineage("omp")).toBe("unknown");
		expect(harnessLineage("pi")).toBe("unknown");
		expect(harnessLineage("opencode")).toBe("unknown");
		expect(harnessLineage(undefined)).toBe("unknown");
	});
});

describe("resolveProvider (degradation ladder, concern 06)", () => {
	test("prefers the explicit model spec over the harness", () => {
		expect(resolveProvider("openai/gpt-5", "claude-code")).toBe("openai");
		expect(resolveProvider("sonnet", "codex")).toBe("anthropic");
	});
	test("falls back to the harness's static vendor pin only when the model is unreadable", () => {
		expect(resolveProvider(undefined, "claude-code")).toBe("anthropic");
		expect(resolveProvider("", "gemini")).toBe("google");
		expect(resolveProvider("mistral/large", "codex")).toBe("openai"); // unknown-provider model spec falls back too
	});
	test("multi-model harness + no model spec ⇒ honestly unknown (never guessed)", () => {
		expect(resolveProvider(undefined, "omp")).toBe("unknown");
		expect(resolveProvider(undefined, undefined)).toBe("unknown");
	});
	test("DEFAULT_PROVIDER is the fleet's dominant subscription vendor (anthropic)", () => {
		expect(DEFAULT_PROVIDER).toBe("anthropic");
	});
});
