import { describe, expect, test } from "bun:test";
import {
	adoptBranchName,
	adoptBrief,
	isSafeUntrackedPath,
	parseUntracked,
	sanitizeBranchComponent,
} from "../src/adopt.ts";

describe("sanitizeBranchComponent", () => {
	test("keeps safe chars, collapses the rest", () => {
		expect(sanitizeBranchComponent("claude-code")).toBe("claude-code");
		expect(sanitizeBranchComponent("weird/name space")).toBe("weird-name-space");
		expect(sanitizeBranchComponent("!!!")).toBe("session");
	});
});

describe("adoptBranchName", () => {
	test("deterministic per (sessionId, headSha); differs when either changes", () => {
		const a = adoptBranchName("claude-code", "sess1", "abc123");
		expect(a).toBe(adoptBranchName("claude-code", "sess1", "abc123"));
		expect(a).toMatch(/^adopt\/claude-code-[0-9a-f]{8}$/);
		expect(a).not.toBe(adoptBranchName("claude-code", "sess1", "def456")); // evolved HEAD
		expect(a).not.toBe(adoptBranchName("claude-code", "sess2", "abc123")); // other session
	});
});

describe("adoptBrief", () => {
	test("names the inherited work and tells the unit to continue", () => {
		const b = adoptBrief("claude-code", 2, 1);
		expect(b).toContain("2 changed files");
		expect(b).toContain("1 new file");
		expect(b.toLowerCase()).toContain("continue");
	});
	test("handles zero uncommitted work", () => {
		expect(adoptBrief("codex", 0, 0)).toContain("no uncommitted changes");
	});
});

describe("parseUntracked", () => {
	test("splits, trims, drops blanks", () => {
		expect(parseUntracked("a.ts\nb/c.ts\n\n  d.ts  \n")).toEqual(["a.ts", "b/c.ts", "d.ts"]);
	});
});

describe("isSafeUntrackedPath", () => {
	test("accepts repo-relative paths", () => {
		expect(isSafeUntrackedPath("src/a.ts")).toBe(true);
		expect(isSafeUntrackedPath("a.ts")).toBe(true);
	});
	test("rejects absolute, drive-letter, and traversal paths", () => {
		expect(isSafeUntrackedPath("/etc/passwd")).toBe(false);
		expect(isSafeUntrackedPath("C:/x")).toBe(false);
		expect(isSafeUntrackedPath("../escape")).toBe(false);
		expect(isSafeUntrackedPath("a/../../b")).toBe(false);
		expect(isSafeUntrackedPath("")).toBe(false);
	});
});
