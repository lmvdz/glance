import { expect, test } from "bun:test";
import { PATTERNS, scan } from "../scripts/defect-ratchet.ts";

/**
 * The defect-class ratchet — see scripts/defect-ratchet.ts's module doc for why this is a sibling to
 * effect-ratchet.test.ts rather than folded into it. Each pattern is locked at a baseline count; this
 * fails if a change ADDS a new occurrence (no backsliding). When you fix some away (or wire up /
 * `@substrate`-annotate a case that turns out deliberate), lower the pattern's `baseline` in
 * scripts/defect-ratchet.ts in the same PR — the number only ratchets down. See that file for the
 * rationale and for `bun scripts/defect-ratchet.ts` (the live inventory report).
 */
const findings = scan();

for (const { pattern, count, files } of findings) {
	test(`ratchet: ${pattern.id} stays at/under baseline (${pattern.baseline})`, () => {
		if (count > pattern.baseline) {
			const added = files.slice(-(count - pattern.baseline)).map((f) => `${f.file}:${f.line}`);
			throw new Error(
				`${pattern.id}: ${count} occurrences, baseline is ${pattern.baseline} (+${count - pattern.baseline}).\n` +
					`New defect-class pattern introduced — fix it instead of adding it.\n${pattern.description}\n` +
					`Recent hits: ${added.join(", ")}`,
			);
		}
		expect(count).toBeLessThanOrEqual(pattern.baseline);
	});
}

// Note: when a fix lands and a count drops below its baseline, that is NOT a failure —
// `bun scripts/defect-ratchet.ts` prints a "tighten baseline to N" hint, and you lower it in the
// fixing PR. The suite gate is the ceiling only, so a fix never has to be interleaved with a
// re-baseline to keep tests green.
test("ratchet: at least one defect-class pattern is tracked", () => {
	expect(PATTERNS.length).toBeGreaterThan(0);
});
