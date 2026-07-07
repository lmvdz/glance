import { describe, expect, test } from "bun:test";
import { harnessLineage, modelLineage } from "../src/model-lineage.ts";
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
			other: "mistral-large",
			unknown: "",
		};
		const seen = new Set(Object.values(probes).map((m) => modelFamily(m)));
		expect(seen).toEqual(new Set(["fable", "opus", "sonnet", "haiku", "openai", "gemini", "other", "unknown"]));
		for (const m of Object.values(probes)) {
			expect(["anthropic", "openai", "google", "unknown"]).toContain(modelLineage(m));
		}
	});
});

describe("harnessLineage", () => {
	test("vendor-pinned harnesses only", () => {
		expect(harnessLineage("gemini")).toBe("google");
		expect(harnessLineage("claude-code")).toBe("anthropic");
		expect(harnessLineage("codex")).toBe("openai");
	});
	test("multi-model runtimes do not imply a vendor", () => {
		expect(harnessLineage("omp")).toBe("unknown");
		expect(harnessLineage("pi")).toBe("unknown");
		expect(harnessLineage("opencode")).toBe("unknown");
		expect(harnessLineage(undefined)).toBe("unknown");
	});
});
