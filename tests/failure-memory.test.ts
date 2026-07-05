/**
 * Recurring-failure memory store (agentic-learning-loop concern 05): a fingerprint-keyed,
 * land-ledger-style JSON file. Corrupt/missing ⇒ empty; a re-annotation overwrites; unrelated
 * fingerprints don't collide.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { failureAnnotation, readFailureAnnotations, recordFailureAnnotation } from "../src/failure-memory.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "failure-memory-"));
}

describe("readFailureAnnotations", () => {
	test("returns {} for a missing store", () => {
		const dir = tmp();
		try {
			expect(readFailureAnnotations(dir)).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns {} for a corrupt store rather than throwing", () => {
		const dir = tmp();
		try {
			writeFileSync(path.join(dir, "failure-annotations.json"), "{not json");
			expect(readFailureAnnotations(dir)).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("recordFailureAnnotation / failureAnnotation", () => {
	test("round-trips one annotation", () => {
		const dir = tmp();
		try {
			recordFailureAnnotation(dir, { fingerprint: "land-failing:squad/a1", repo: "/r", branch: "squad/a1", rootCause: "flaky retry backoff", at: 1000 });
			expect(failureAnnotation(dir, "land-failing:squad/a1")).toEqual({ fingerprint: "land-failing:squad/a1", repo: "/r", branch: "squad/a1", rootCause: "flaky retry backoff", at: 1000 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("re-annotating the same fingerprint overwrites, never duplicates", () => {
		const dir = tmp();
		try {
			recordFailureAnnotation(dir, { fingerprint: "fp1", repo: "/r", branch: "b1", rootCause: "first guess", at: 1 });
			recordFailureAnnotation(dir, { fingerprint: "fp1", repo: "/r", branch: "b1", rootCause: "better guess", at: 2 });
			expect(Object.keys(readFailureAnnotations(dir))).toEqual(["fp1"]);
			expect(failureAnnotation(dir, "fp1")?.rootCause).toBe("better guess");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unrelated fingerprints coexist independently", () => {
		const dir = tmp();
		try {
			recordFailureAnnotation(dir, { fingerprint: "fp1", repo: "/r", branch: "b1", rootCause: "a", at: 1 });
			recordFailureAnnotation(dir, { fingerprint: "fp2", repo: "/r", branch: "b2", rootCause: "b", at: 1 });
			expect(failureAnnotation(dir, "fp1")?.rootCause).toBe("a");
			expect(failureAnnotation(dir, "fp2")?.rootCause).toBe("b");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("failureAnnotation returns undefined for an unseen fingerprint", () => {
		const dir = tmp();
		try {
			expect(failureAnnotation(dir, "nope")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
