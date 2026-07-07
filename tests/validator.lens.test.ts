import { describe, expect, test } from "bun:test";
import { ompLensJudge, parseLensVerdict } from "../src/validator.ts";

const parse = parseLensVerdict("regression");

describe("parseLensVerdict (guarded, stream-tolerant)", () => {
	test("well-formed accept", () => {
		expect(parse('{"disposition":"accept","severity":"low","claim":""}')).toEqual({ lens: "regression", disposition: "accept", severity: "low", claim: "" });
	});

	test("well-formed high-severity objection", () => {
		expect(parse('{"disposition":"object","severity":"high","claim":"unbounded input read"}')).toEqual({
			lens: "regression",
			disposition: "object",
			severity: "high",
			claim: "unbounded input read",
		});
	});

	test("prose around the JSON is tolerated (whole-blob fallback)", () => {
		expect(parse('here is my verdict:\n{"disposition":"object","severity":"low","claim":"nit"}\nthanks')).toMatchObject({ disposition: "object", severity: "low" });
	});

	test("codex JSONL stream with an embedded verdict in a message field", () => {
		const stream = ['{"type":"item","item":{"text":"{\\"disposition\\":\\"object\\",\\"severity\\":\\"high\\",\\"claim\\":\\"secret logged\\"}"}}'].join("\n");
		expect(parse(stream)).toMatchObject({ disposition: "object", severity: "high", claim: "secret logged" });
	});

	test("severity defaults to low when missing or invalid", () => {
		expect(parse('{"disposition":"object","claim":"x"}')).toMatchObject({ severity: "low" });
		expect(parse('{"disposition":"object","severity":"critical","claim":"x"}')).toMatchObject({ severity: "low" });
	});

	// Fail-open contract: none of these may throw; all must yield undefined (no advisory signal).
	test("garbage / empty / missing-disposition → undefined, never a throw", () => {
		expect(parse("")).toBeUndefined();
		expect(parse("not json at all")).toBeUndefined();
		expect(parse("{ broken json ")).toBeUndefined();
		expect(parse('{"severity":"high","claim":"x"}')).toBeUndefined(); // no disposition
		expect(parse('{"disposition":"maybe"}')).toBeUndefined(); // invalid disposition
	});
});

describe("ompLensJudge", () => {
	test("is a function producing a judge (never throws to construct)", () => {
		expect(typeof ompLensJudge("regression")).toBe("function");
	});
});
