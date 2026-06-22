import { describe, expect, test } from "bun:test";
import { extractJsonObject, ompOneShot } from "../src/omp-call.ts";

describe("extractJsonObject", () => {
	test("parses a plain object", () => {
		expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
	});

	test("strips surrounding prose and ```json fences", () => {
		const raw = 'Sure, here:\n```json\n{"process":"verify","effort":"low"}\n```\nthanks';
		expect(extractJsonObject(raw)).toEqual({ process: "verify", effort: "low" });
	});

	test("takes the outermost braces (last } wins) across nested objects", () => {
		expect(extractJsonObject('noise {"a":{"b":2}} tail')).toEqual({ a: { b: 2 } });
	});

	test("returns undefined when no braces are present", () => {
		expect(extractJsonObject("no json here")).toBeUndefined();
	});

	test("returns undefined for malformed JSON between braces", () => {
		expect(extractJsonObject("{not valid}")).toBeUndefined();
	});

	test("returns undefined for a JSON array (not an object)", () => {
		expect(extractJsonObject("[1,2,3]")).toBeUndefined();
	});
});

describe("ompOneShot", () => {
	test("never throws — a missing binary degrades to a non-zero code", async () => {
		const { out, code } = await ompOneShot(["-p", "x"], { bin: "omp-squad-nonexistent-binary-xyz" });
		expect(code).not.toBe(0);
		expect(out).toBe("");
	});
});
