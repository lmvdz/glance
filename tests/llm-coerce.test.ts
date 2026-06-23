/**
 * Characterization tests for the highest-risk LLM-output coercers — the ones
 * feeding the auto-approval and auto-land gates. These PIN the current behavior
 * (the parity gate for the decideTyped refactor); they change nothing. No
 * network, no model calls. Every expected value is derived from the current
 * code, not from docstrings (the intake "last balanced JSON object" docstring is
 * stale — extraction is outermost like everyone else).
 */

import { expect, test } from "bun:test";
import { asApproval, asThinking, parsePlanJson } from "../src/smart-spawn.ts";
import { chooseFallback, parseDecision } from "../src/supervisor.ts";
import { parseApproval } from "../src/land.ts";
import type { PendingRequest } from "../src/types.ts";

function req(kind: string, extra: Partial<PendingRequest> = {}): PendingRequest {
	return { id: "r1", source: kind === "confirm" || kind === "select" || kind === "input" || kind === "editor" ? "ui" : "tool", kind, title: "Do the thing", createdAt: 0, ...extra };
}

test("snapToOption runs exact-over-ALL-options before substring (overlapping options)", () => {
	const overlap = req("select", { options: ["bort", "abort"] });
	// exact "abort" must win even though "abort".includes("bort") — a single-pass
	// find(exact||substring) would wrongly return "bort".
	expect(parseDecision('{"value":"abort"}', overlap)).toBe("abort");
	expect(parseDecision('{"value":"bort"}', overlap)).toBe("bort");
});

test("select never returns an out-of-options value: snaps to chooseFallback", () => {
	const r = req("select", { options: ["Approve", "Deny"] });
	// "zzz" matches no option (exact or substring) → chooseFallback → APPROVE_RE → "Approve".
	expect(parseDecision('{"value":"zzz"}', r)).toBe(chooseFallback(r));
	expect(parseDecision('{"value":"zzz"}', r)).toBe("Approve");
});

test("asApproval is exact and case-sensitive (security-relevant)", () => {
	expect(asApproval("ask")).toBeUndefined(); // MUST NOT snap to "always-ask"
	expect(asApproval("always-ask")).toBe("always-ask");
	expect(asApproval("YOLO")).toBeUndefined(); // case-sensitive
	expect(asApproval("yolo")).toBe("yolo");
});

test("asThinking is exact", () => {
	expect(asThinking("hi")).toBeUndefined();
	expect(asThinking("high")).toBe("high");
});

test("parsePlanJson trims fields and drops empty owns entries; non-array owns → undefined", () => {
	const plan = parsePlanJson('{"repo":" /x ","owns":[" src/web ","","\\t","a"]}');
	expect(plan?.repo).toBe("/x");
	expect(plan?.owns).toEqual(["src/web", "a"]);
	expect(parsePlanJson('{"repo":"/x","owns":"src/web"}')?.owns).toBeUndefined();
});

test("parseApproval: APPROVE token wins, REJECT is a negative guard, JSON not required", () => {
	expect(parseApproval("APPROVE")).toBe(true);
	expect(parseApproval("approve")).toBe(true); // case-insensitive
	expect(parseApproval("looks fine")).toBe(false); // no token
	expect(parseApproval("APPROVE the safe parts but REJECT the migration")).toBe(false); // negative guard
	expect(parseApproval('{"verdict":"approve"}')).toBe(true); // substring word-search — JSON is NOT required (why land is excluded from decideTyped)
});

test("confirm normalizes truthy value to 'yes'; input passes value verbatim (not trimmed)", () => {
	expect(parseDecision('{"value":"YES"}', req("confirm"))).toBe("yes");
	expect(parseDecision('{"value":" keep  spaces "}', req("input"))).toBe(" keep  spaces ");
});
