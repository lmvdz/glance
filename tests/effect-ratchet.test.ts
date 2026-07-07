import { expect, test } from "bun:test";
import { PATTERNS, scan } from "../scripts/effect-migration.ts";

/**
 * The Effect-migration ratchet. Each legacy pattern is locked at a baseline count;
 * this fails if a change ADDS a new occurrence (no backsliding). When you migrate
 * some away, lower the pattern's `baseline` in scripts/effect-migration.ts in the
 * same PR — the number only ratchets down. See that file for the rationale and for
 * `bun scripts/effect-migration.ts` (the live inventory report).
 */
const findings = scan();

for (const { pattern, count, files } of findings) {
	test(`ratchet: ${pattern.id} stays at/under baseline (${pattern.baseline})`, () => {
		if (count > pattern.baseline) {
			const added = files.slice(-(count - pattern.baseline)).map((f) => `${f.file}:${f.line}`);
			throw new Error(
				`${pattern.id}: ${count} occurrences, baseline is ${pattern.baseline} (+${count - pattern.baseline}).\n` +
					`New legacy pattern introduced — migrate it instead of adding it.\n${pattern.description}\n` +
					`Recent hits: ${added.join(", ")}`,
			);
		}
		expect(count).toBeLessThanOrEqual(pattern.baseline);
	});
}

// Note: when a migration lands and a count drops well below its baseline, that is NOT
// a failure — `bun scripts/effect-migration.ts` prints a "tighten baseline to N" hint,
// and you lower it in the migrating PR. The suite gate is the ceiling only, so a
// migration never has to be interleaved with a re-baseline to keep tests green.
test("ratchet: at least one pattern is tracked", () => {
	expect(PATTERNS.length).toBeGreaterThan(0);
});
