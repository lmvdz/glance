import { expect, test } from "bun:test";
import { BASELINE, scan } from "../scripts/dead-exports.ts";

/**
 * The dead-export ratchet — see scripts/dead-exports.ts's module doc for the reference-universe
 * definition (src/+webapp/, tests deliberately excluded) and exemption rules (`@substrate`,
 * src/index.ts, src/*-main.ts). Locks the CURRENT count of exported function/const-arrow-fn
 * candidates with no reference outside their own defining file as a ceiling: a PR that adds a new
 * dead export fails this suite; wiring one up (or annotating a genuinely deliberate one with
 * `@substrate`) and lowering BASELINE in the same PR is how the ceiling comes down. See
 * `bun scripts/dead-exports.ts --files` for the live, full inventory.
 */
test(`ratchet: dead exports stay at/under baseline (${BASELINE})`, () => {
	const { dead } = scan();
	if (dead.length > BASELINE) {
		const added = dead.slice(-(dead.length - BASELINE)).map((d) => `${d.file}:${d.line} ${d.name}`);
		throw new Error(
			`dead-exports: ${dead.length} exported symbols with no reference outside their own file, baseline is ${BASELINE} ` +
				`(+${dead.length - BASELINE}).\nA new export was added with no caller outside its defining file (tests don't count) — ` +
				`either wire it up, or mark it deliberate substrate with an "@substrate <reason>" line in its doc comment.\n` +
				`Recent hits: ${added.join(", ")}`,
		);
	}
	expect(dead.length).toBeLessThanOrEqual(BASELINE);
}, 15_000);

test("ratchet: dead-export scan finds candidates (the check itself isn't silently no-op)", () => {
	const { total } = scan();
	expect(total).toBeGreaterThan(0);
});
