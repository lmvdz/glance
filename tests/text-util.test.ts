/**
 * Equivalence proof for the four truncate locals (land.ts:214, validator.ts:42, squad-manager.ts:8481,
 * flue-service-driver.ts:238) collapsing onto text-util.ts's `truncate`/`truncateLabel` (concern 05
 * does the call-site swap; this only proves the shared implementations are byte-identical to what
 * they replace), plus stripAnsi's move from observer.ts.
 */

import { describe, expect, test } from "bun:test";
import { stripAnsi, truncate, truncateLabel } from "../src/text-util.ts";

// ── Original inline definitions, copied verbatim for comparison — NOT imported, so a future edit to
// text-util.ts that silently changes behavior fails this file instead of trivially passing. ──────────

function originalTruncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function originalTruncateLabel(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function originalStripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, "");
}

const CASES = [
	"",
	"short",
	"exactly ten",
	"a".repeat(500),
	"line one\nline two\nline three",
	"  leading and trailing whitespace   \n\t",
	"multi\n\n\nline\t\tgaps   here",
	"unicode: café 日本語 emoji 🎉",
	"\x1b[31mred\x1b[0m plain \x1b[1mbold\x1b[0m",
];

describe("truncate ≡ land.ts/validator.ts's former local", () => {
	for (const s of CASES) {
		for (const n of [0, 1, 5, 10, 50, 1000]) {
			test(`s=${JSON.stringify(s.slice(0, 20))}… n=${n}`, () => {
				expect(truncate(s, n)).toBe(originalTruncate(s, n));
			});
		}
	}

	test("passthrough when within budget", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	test("exact-length input is untouched (no ellipsis)", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	test("cuts and appends the ellipsis when over budget", () => {
		expect(truncate("hello world", 5)).toBe("hello…");
	});

	test("preserves internal whitespace/newlines — does NOT flatten", () => {
		const s = "line one\nline two\nline three";
		expect(truncate(s, 13)).toBe("line one\nline…");
	});
});

describe("truncateLabel ≡ squad-manager.ts/flue-service-driver.ts's former local", () => {
	for (const s of CASES) {
		for (const n of [0, 1, 5, 10, 50, 1000]) {
			test(`s=${JSON.stringify(s.slice(0, 20))}… n=${n}`, () => {
				expect(truncateLabel(s, n)).toBe(originalTruncateLabel(s, n));
			});
		}
	}

	test("flattens whitespace runs (including newlines) to a single space", () => {
		expect(truncateLabel("line one\n\n  line two", 100)).toBe("line one line two");
	});

	test("trims leading/trailing whitespace", () => {
		expect(truncateLabel("   padded   ", 100)).toBe("padded");
	});

	test("cuts flattened text and appends ellipsis when over budget", () => {
		expect(truncateLabel("this is a long label", 10)).toBe("this is a…");
	});
});

describe("stripAnsi ≡ observer.ts's former local", () => {
	for (const s of CASES) {
		test(`s=${JSON.stringify(s.slice(0, 30))}…`, () => {
			expect(stripAnsi(s)).toBe(originalStripAnsi(s));
		});
	}

	test("strips CSI sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	test("strips bold/reset around plain text", () => {
		expect(stripAnsi("\x1b[1mbold\x1b[0m plain")).toBe("bold plain");
	});

	test("no-op on text with no escape sequences", () => {
		expect(stripAnsi("plain text, nothing to strip")).toBe("plain text, nothing to strip");
	});
});
