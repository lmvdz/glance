/**
 * Auto-supervisor — deterministic decision helpers only. The live paths (`decide`
 * spawns omp; `startSupervisor` opens a WebSocket) are exercised against a real
 * daemon, never here: no network, no model tokens, no process spawn.
 */

import { expect, test } from "bun:test";
import { chooseFallback, formatRequestPrompt, parseDecision } from "../src/supervisor.ts";
import type { PendingRequest } from "../src/types.ts";

function req(kind: string, extra: Partial<PendingRequest> = {}): PendingRequest {
	return { id: "r1", source: kind === "confirm" || kind === "select" || kind === "input" || kind === "editor" ? "ui" : "tool", kind, title: "Do the thing", createdAt: 0, ...extra };
}

test("chooseFallback biases to approve/advance per kind", () => {
	expect(chooseFallback(req("confirm"))).toBe("yes");
	expect(chooseFallback(req("select", { options: ["Cancel", "Approve"] }))).toBe("Approve");
	expect(chooseFallback(req("select", { options: ["foo", "bar"] }))).toBe("foo");
	expect(chooseFallback(req("select", { options: [] }))).toBe("");
	expect(chooseFallback(req("input")).length).toBeGreaterThan(0);
	expect(chooseFallback(req("editor")).length).toBeGreaterThan(0);
	expect(chooseFallback(req("read_file"))).toBe("");
});

test("parseDecision reads strict JSON {value} for a confirm", () => {
	expect(parseDecision('{"value":"yes"}', req("confirm"))).toBe("yes");
});

test("parseDecision tolerates a fenced ```json block on a select", () => {
	const raw = '```json\n{"value":"Approve"}\n```';
	expect(parseDecision(raw, req("select", { options: ["Approve", "Deny"] }))).toBe("Approve");
});

test("parseDecision snaps a case-insensitive select value to the real option", () => {
	expect(parseDecision('{"value":"approve"}', req("select", { options: ["Approve", "Deny"] }))).toBe("Approve");
});

test("parseDecision never returns an out-of-options value for a select", () => {
	const out = parseDecision('{"value":"banana"}', req("select", { options: ["Approve", "Deny"] }));
	expect(["Approve", "Deny"]).toContain(out);
	expect(out).not.toBe("banana");
});

test("parseDecision falls back to approve on garbage with no JSON (confirm)", () => {
	expect(parseDecision("lol no json", req("confirm"))).toBe("yes");
});

test("parseDecision normalizes a non-truthy confirm value to no", () => {
	expect(parseDecision('{"value":"absolutely not"}', req("confirm"))).toBe("no");
});

test("formatRequestPrompt includes the title and every option string", () => {
	const prompt = formatRequestPrompt(req("select", { title: "Pick a path", options: ["Apply migration", "Skip migration"] }), "[user] go");
	expect(prompt).toContain("Pick a path");
	expect(prompt).toContain("Apply migration");
	expect(prompt).toContain("Skip migration");
});
