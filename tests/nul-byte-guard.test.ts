import { Glob } from "bun";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Guards against a literal NUL byte landing in a TypeScript source file — the same defect class as
 * the historical PR #284 incident, and the one this exact fix found lurking a second time in
 * src/server.ts, src/harness-hooks.ts, and src/resident-planner.ts. All three used a raw `0x00` byte
 * as a hash/dedup-key separator (`` `${a}${b}` `` with an invisible NUL between the placeholders)
 * instead of the `\0` escape sequence — functionally identical at runtime (both produce a NUL in the
 * resulting string), but a raw byte sitting in the FILE ITSELF is invisible in diffs, invisible in an
 * editor, and the exact shape of the original incident. `voice-call-projection.ts`'s own
 * `` `${entry.role}\0${entry.turn}` `` shows the right way to write it.
 *
 * The fix is always the same: write the escape, never the byte. This test scans every real
 * TypeScript source file under src/ and webapp/src/ so a THIRD occurrence trips this suite instead
 * of waiting for a human reviewer to notice an invisible character.
 */
const REPO_ROOT = path.join(import.meta.dir, "..");

function sourceFiles(): string[] {
	const patterns = ["src/**/*.ts", "webapp/src/**/*.ts", "webapp/src/**/*.tsx"];
	const files = new Set<string>();
	for (const pattern of patterns) for (const f of new Glob(pattern).scanSync(REPO_ROOT)) files.add(f);
	return [...files].sort();
}

test("no src/**/*.ts or webapp/src/**/*.ts(x) file contains a raw NUL byte", () => {
	const files = sourceFiles();
	// A scan that finds nothing to scan would pass this test while proving nothing — same fail-open
	// this repo's other ratchets already guard against (dead-exports-ratchet.test.ts, defect-ratchet.test.ts).
	expect(files.length).toBeGreaterThan(100);
	const offenders: string[] = [];
	for (const rel of files) {
		const buf = readFileSync(path.join(REPO_ROOT, rel));
		if (buf.includes(0)) offenders.push(rel);
	}
	if (offenders.length) {
		throw new Error(
			`raw NUL byte found in: ${offenders.join(", ")}\n` +
				`Use the "\\0" escape sequence inside the string/template literal instead of a literal byte — ` +
				`identical runtime value, visible and diffable in the source. See src/voice-call-projection.ts's ` +
				"`${entry.role}\\0${entry.turn}` for the pattern to follow.",
		);
	}
	expect(offenders).toEqual([]);
});
