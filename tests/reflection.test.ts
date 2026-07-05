/**
 * Reflexion module (agentic-learning-loop concern 04): reflect() never throws, refutation framing,
 * and the per-worktree JSONL store (append/read, tolerant of a torn trailing line).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendReflection, hashOutput, latestReflection, reflect, renderReflectionNote, renderRefutationNote, type Reflection } from "../src/reflection.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "reflection-"));
}

describe("hashOutput", () => {
	test("is deterministic and distinguishes different outputs", () => {
		expect(hashOutput("same")).toBe(hashOutput("same"));
		expect(hashOutput("a")).not.toBe(hashOutput("b"));
	});
});

describe("reflect", () => {
	test("returns a Reflection with the output's hash when the llm answers", async () => {
		const r = await reflect({ output: "TypeError: x is not a function" }, async () => ({ rootCause: "wrong arity", whatToDoDifferently: "check the call site" }));
		expect(r).toEqual({ rootCause: "wrong arity", whatToDoDifferently: "check the call site", outputHash: hashOutput("TypeError: x is not a function") });
	});

	test("never throws when the llm rejects — resolves null", async () => {
		const r = await reflect({ output: "boom" }, async () => {
			throw new Error("llm unreachable");
		});
		expect(r).toBeNull();
	});

	test("resolves null when the llm returns undefined (no rootCause)", async () => {
		const r = await reflect({ output: "x" }, async () => undefined);
		expect(r).toBeNull();
	});

	test("resolves null when the llm returns an empty rootCause", async () => {
		const r = await reflect({ output: "x" }, async () => ({ rootCause: "" }));
		expect(r).toBeNull();
	});

	test("whatToDoDifferently defaults to empty string when omitted", async () => {
		const r = await reflect({ output: "x" }, async () => ({ rootCause: "some cause" }));
		expect(r?.whatToDoDifferently).toBe("");
	});

	test("passes the prior hypothesis through to the llm (for refutation framing upstream)", async () => {
		let seenPrior: Reflection | undefined;
		await reflect({ output: "x", prior: { rootCause: "old guess", whatToDoDifferently: "", outputHash: "h" } }, async (input) => {
			seenPrior = input.prior;
			return { rootCause: "new guess" };
		});
		expect(seenPrior?.rootCause).toBe("old guess");
	});
});

describe("render helpers", () => {
	test("renderReflectionNote includes both root cause and next step when present", () => {
		const note = renderReflectionNote({ rootCause: "off-by-one", whatToDoDifferently: "check the loop bound", outputHash: "h" });
		expect(note).toContain("off-by-one");
		expect(note).toContain("check the loop bound");
	});

	test("renderReflectionNote omits the next-step line when absent", () => {
		const note = renderReflectionNote({ rootCause: "off-by-one", whatToDoDifferently: "", outputHash: "h" });
		expect(note).toContain("off-by-one");
		expect(note).not.toContain("Try instead");
	});

	test("renderRefutationNote names the prior hypothesis as having failed", () => {
		const note = renderRefutationNote({ rootCause: "wrong config key", whatToDoDifferently: "", outputHash: "h" });
		expect(note).toContain("did NOT fix this");
		expect(note).toContain("wrong config key");
	});
});

describe("per-worktree store", () => {
	test("appendReflection then latestReflection round-trips the most recent entry", async () => {
		const dir = tmp();
		try {
			await appendReflection(dir, "/repo", "/repo/.worktrees/a", { rootCause: "first", whatToDoDifferently: "", outputHash: "h1", at: 1 });
			await appendReflection(dir, "/repo", "/repo/.worktrees/a", { rootCause: "second", whatToDoDifferently: "", outputHash: "h2", at: 2 });
			const latest = await latestReflection(dir, "/repo", "/repo/.worktrees/a");
			expect(latest?.rootCause).toBe("second");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("latestReflection returns undefined for a worktree with no store yet", async () => {
		const dir = tmp();
		try {
			expect(await latestReflection(dir, "/repo", "/nope")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("different worktrees under the same repo get independent stores", async () => {
		const dir = tmp();
		try {
			await appendReflection(dir, "/repo", "/repo/.worktrees/a", { rootCause: "a's cause", whatToDoDifferently: "", outputHash: "h", at: 1 });
			await appendReflection(dir, "/repo", "/repo/.worktrees/b", { rootCause: "b's cause", whatToDoDifferently: "", outputHash: "h", at: 1 });
			expect((await latestReflection(dir, "/repo", "/repo/.worktrees/a"))?.rootCause).toBe("a's cause");
			expect((await latestReflection(dir, "/repo", "/repo/.worktrees/b"))?.rootCause).toBe("b's cause");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a torn trailing line is skipped, falling back to the last valid entry", async () => {
		const dir = tmp();
		try {
			await appendReflection(dir, "/repo", "/wt", { rootCause: "valid", whatToDoDifferently: "", outputHash: "h1", at: 1 });
			// Simulate a crash mid-write: locate the store's own file (nested under a repo-hash dir) and
			// append an unparseable trailing line directly.
			const fsMod = await import("node:fs");
			const files = fsMod.readdirSync(dir, { recursive: true }) as string[];
			const jsonl = files.find((f) => f.toString().endsWith(".jsonl"));
			expect(jsonl).toBeDefined();
			appendFileSync(path.join(dir, jsonl as string), "{not valid json\n");
			const latest = await latestReflection(dir, "/repo", "/wt");
			expect(latest?.rootCause).toBe("valid");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
