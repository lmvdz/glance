import { describe, expect, test } from "bun:test";
import { decideTyped, extractJsonObject, ompOneShot } from "../src/omp-call.ts";
import { gitNoSignEnv } from "../src/git-harden.ts";

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

	test("disables git signing for one-shot supervisor calls", async () => {
		const { out, code } = await ompOneShot([], { bin: "env" });
		expect(code).toBe(0);
		const env = Object.fromEntries(out.trim().split("\n").map((line) => line.split("=", 2))) as Record<string, string>;
		const key = Object.entries(env).find(([, v]) => v === "commit.gpgsign")?.[0];
		expect(key).toBeDefined();
		const slot = key!.slice("GIT_CONFIG_KEY_".length);
		expect(env[`GIT_CONFIG_VALUE_${slot}`]).toBe("false");
	});

	test("gitNoSignEnv preserves existing GIT_CONFIG entries", () => {
		expect(gitNoSignEnv({ GIT_CONFIG_COUNT: "1" })).toEqual({
			GIT_CONFIG_COUNT: "3",
			GIT_CONFIG_KEY_1: "commit.gpgsign",
			GIT_CONFIG_VALUE_1: "false",
			GIT_CONFIG_KEY_2: "tag.gpgsign",
			GIT_CONFIG_VALUE_2: "false",
		});
	});
});

describe("decideTyped", () => {
	const NONEXIST = "omp-squad-nonexistent-binary-xyz";

	test("returns the parsed value on a clean run", async () => {
		const v = await decideTyped<string>({ args: ["hello"], bin: "echo", parse: (out) => out.trim() || undefined, fallback: "FB" });
		expect(v).toBe("hello");
	});

	test("non-zero exit → fallback", async () => {
		const v = await decideTyped<string>({ args: ["x"], bin: NONEXIST, parse: () => "PARSED", fallback: "FB" });
		expect(v).toBe("FB");
	});

	test("empty output → fallback", async () => {
		const v = await decideTyped<string>({ args: [], bin: "true", parse: () => "PARSED", fallback: "FB" });
		expect(v).toBe("FB");
	});

	test("parse → undefined → fallback", async () => {
		const v = await decideTyped<string>({ args: ["hello"], bin: "echo", parse: () => undefined, fallback: "FB" });
		expect(v).toBe("FB");
	});

	test("retries re-attempts once before succeeding", async () => {
		let calls = 0;
		const parse = (out: string): string | undefined => (++calls >= 2 ? out.trim() : undefined);
		const v = await decideTyped<string>({ args: ["hello"], bin: "echo", retries: 1, parse, fallback: "FB" });
		expect(v).toBe("hello");
		expect(calls).toBe(2);
	});

	test("retries:0 (default) makes a single attempt → fallback on a parse miss", async () => {
		let calls = 0;
		const parse = (out: string): string | undefined => (++calls >= 2 ? out.trim() : undefined);
		const v = await decideTyped<string>({ args: ["hello"], bin: "echo", parse, fallback: "FB" });
		expect(v).toBe("FB");
		expect(calls).toBe(1);
	});
});
