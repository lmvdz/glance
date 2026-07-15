import { describe, expect, test } from "bun:test";
import {
	CONSOLE_SYSTEM_PROMPT,
	isConsolePrompt,
	stripConsolePrompt,
} from "../src/console-prompt.ts";

// The console segment is joined into a composite appendSystemPrompt with "\n\n"; these mirror the
// createWithId join `[profile.memory, toolGrants, membrane, CONSOLE].join("\n\n")`.
const PROFILE = "You are a senior reviewer. Remember: prefer small diffs.";
const TOOLGRANTS = "Tools granted: read, write, bash.";

describe("isConsolePrompt — identity, not mere presence", () => {
	test("true when the composite carries the console prompt", () => {
		expect(isConsolePrompt(CONSOLE_SYSTEM_PROMPT)).toBe(true);
		expect(
			isConsolePrompt([PROFILE, TOOLGRANTS, CONSOLE_SYSTEM_PROMPT].join("\n\n")),
		).toBe(true);
	});
	test("false for a non-console prompt (a profile bundle is NOT a console unit)", () => {
		expect(isConsolePrompt([PROFILE, TOOLGRANTS].join("\n\n"))).toBe(false);
		expect(isConsolePrompt(undefined)).toBe(false);
		expect(isConsolePrompt("")).toBe(false);
	});
});

describe("stripConsolePrompt — remove ONLY the console segment", () => {
	test("preserves profile memory + tool grants, drops the console rule", () => {
		const composite = [PROFILE, TOOLGRANTS, CONSOLE_SYSTEM_PROMPT].join("\n\n");
		const out = stripConsolePrompt(composite);
		expect(out).toBeDefined();
		expect(out).toContain(PROFILE);
		expect(out).toContain(TOOLGRANTS);
		expect(out).not.toContain("interactive console agent");
		// no dangling blank-line seam left by the excision
		expect(out).not.toMatch(/\n{3,}/);
		expect(out).toBe([PROFILE, TOOLGRANTS].join("\n\n"));
	});
	test("console-only composite strips to undefined", () => {
		expect(stripConsolePrompt(CONSOLE_SYSTEM_PROMPT)).toBeUndefined();
	});
	test("undefined stays undefined; a non-console prompt is returned intact", () => {
		expect(stripConsolePrompt(undefined)).toBeUndefined();
		expect(stripConsolePrompt(PROFILE)).toBe(PROFILE);
	});
	test("console segment in the MIDDLE is excised without joining neighbours", () => {
		const composite = [PROFILE, CONSOLE_SYSTEM_PROMPT, TOOLGRANTS].join("\n\n");
		const out = stripConsolePrompt(composite);
		expect(out).toBe([PROFILE, TOOLGRANTS].join("\n\n"));
	});
});
