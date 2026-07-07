/**
 * Policy-as-data (plans/policy-and-cost-gates/ concern C-STORE) — the pure evaluator + durable store.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { evalPolicy, parsePolicyDoc, PolicyStore, readPolicyDocSync, type PolicyRule } from "../src/policy.ts";

const deny = (id: string, when: PolicyRule["when"]): PolicyRule => ({ id, decision: "deny", when, reason: `denied by ${id}` });
const ask = (id: string, when: PolicyRule["when"]): PolicyRule => ({ id, decision: "ask", when, reason: `ask ${id}` });

test("tool_call: commandMatches deny fires", () => {
	const v = evalPolicy([deny("r1", { seam: "tool_call", commandMatches: "rm -rf /" })], { seam: "tool_call", tool: "bash", command: "rm -rf / --no-preserve-root" });
	expect(v?.decision).toBe("deny");
	expect(v?.ruleId).toBe("r1");
});

test("tool_call: tool-name match", () => {
	expect(evalPolicy([deny("r", { tool: "web_fetch" })], { seam: "tool_call", tool: "web_fetch" })?.decision).toBe("deny");
	expect(evalPolicy([deny("r", { tool: "web_fetch" })], { seam: "tool_call", tool: "bash" })).toBeUndefined();
});

test("DENY wins over ASK regardless of order", () => {
	const rules = [ask("a", { seam: "tool_call" }), deny("d", { seam: "tool_call" })];
	expect(evalPolicy(rules, { seam: "tool_call", tool: "bash" })?.decision).toBe("deny");
	expect(evalPolicy(rules.reverse(), { seam: "tool_call", tool: "bash" })?.decision).toBe("deny");
});

test("first ASK wins when no deny matches", () => {
	const v = evalPolicy([ask("a1", { seam: "tool_call" }), ask("a2", { seam: "tool_call" })], { seam: "tool_call", tool: "bash" });
	expect(v?.ruleId).toBe("a1");
});

test("no match ⇒ undefined (base allow)", () => {
	expect(evalPolicy([deny("r", { commandMatches: "deploy" })], { seam: "tool_call", tool: "bash", command: "ls" })).toBeUndefined();
	expect(evalPolicy([], { seam: "tool_call", tool: "bash" })).toBeUndefined();
});

test("a condition for the wrong seam does not match (rule doesn't govern this subject)", () => {
	// commandMatches is a tool_call dimension; a land subject must not match it.
	expect(evalPolicy([deny("r", { commandMatches: "x" })], { seam: "land", changedFiles: ["a.ts"] })).toBeUndefined();
	// pathMatches is a land dimension; a tool_call subject must not match it.
	expect(evalPolicy([deny("r", { pathMatches: "x" })], { seam: "tool_call", tool: "bash" })).toBeUndefined();
});

test("land: pathMatches + minDiffFiles AND-match", () => {
	const rule = deny("r", { seam: "land", pathMatches: "\\.env$", minDiffFiles: 2 });
	expect(evalPolicy([rule], { seam: "land", changedFiles: [".env", "a.ts"] })?.decision).toBe("deny"); // both hold
	expect(evalPolicy([rule], { seam: "land", changedFiles: [".env"] })).toBeUndefined(); // only 1 file, minDiffFiles fails
	expect(evalPolicy([rule], { seam: "land", changedFiles: ["a.ts", "b.ts"] })).toBeUndefined(); // no .env, pathMatches fails
});

test("land: minCommitsBehind", () => {
	const rule = ask("r", { seam: "land", minCommitsBehind: 5 });
	expect(evalPolicy([rule], { seam: "land", changedFiles: ["a"], commitsBehind: 6 })?.decision).toBe("ask");
	expect(evalPolicy([rule], { seam: "land", changedFiles: ["a"], commitsBehind: 2 })).toBeUndefined();
	expect(evalPolicy([rule], { seam: "land", changedFiles: ["a"] })).toBeUndefined(); // absent commitsBehind = 0
});

test("an uncompilable regex is skipped, never thrown", () => {
	const bad = deny("bad", { commandMatches: "([unclosed" });
	// bad rule never matches; a following good rule still fires
	const good = deny("good", { commandMatches: "ls" });
	expect(evalPolicy([bad, good], { seam: "tool_call", tool: "bash", command: "ls -la" })?.ruleId).toBe("good");
	expect(evalPolicy([bad], { seam: "tool_call", tool: "bash", command: "ls" })).toBeUndefined();
});

test("parsePolicyDoc drops malformed rules, never throws", () => {
	const doc = parsePolicyDoc({ rules: [
		{ id: "ok", decision: "deny", when: { tool: "bash" }, reason: "r" },
		{ id: "no-decision", when: {}, reason: "r" },
		{ decision: "deny", when: {}, reason: "r" }, // no id
		"garbage",
		{ id: "bad-decision", decision: "allow", when: {}, reason: "r" },
	] });
	expect(doc.rules.map((r) => r.id)).toEqual(["ok"]);
	expect(parsePolicyDoc(null)).toEqual({ rules: [] });
	expect(parsePolicyDoc({ rules: "nope" })).toEqual({ rules: [] });
});

// ── Store round-trip ────────────────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "policy-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("PolicyStore save/load/add/remove round-trips; sync reader agrees", async () => {
	const store = new PolicyStore(dir);
	expect(await store.load()).toEqual({ rules: [] }); // missing file → fail-open
	await store.setRules([deny("r1", { tool: "bash" })]);
	expect((await store.load()).rules.map((r) => r.id)).toEqual(["r1"]);
	expect(readPolicyDocSync(dir).rules.map((r) => r.id)).toEqual(["r1"]); // sync agent-process reader
	await store.addRule(deny("r2", { tool: "web_fetch" }));
	expect((await store.load()).rules.map((r) => r.id)).toEqual(["r1", "r2"]);
	await store.addRule(ask("r1", { tool: "bash" })); // same id replaces
	const doc = await store.load();
	expect(doc.rules.find((r) => r.id === "r1")?.decision).toBe("ask");
	await store.removeRule("r2");
	expect((await store.load()).rules.map((r) => r.id)).toEqual(["r1"]);
});

test("readPolicyDocSync fails open on a missing dir", () => {
	expect(readPolicyDocSync("/no/such/dir")).toEqual({ rules: [] });
});
