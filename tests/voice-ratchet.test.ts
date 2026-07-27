import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { explains, explainsRatherThanLabels, statesBlastRadius, statesConsequence } from "../scripts/voice.ts";

/**
 * Concern 10's enforcement. The design's first law — a string states a fact AND what it means — cannot
 * survive a twelve-thousand-line manager on good intentions, because every emit site is a chance to
 * write "land attempt finished · wren · ok" and move on. That string is true and tells a person nothing.
 *
 * Ratcheted rather than demanded all at once: a rule that requires a large rewrite before it can land
 * is a rule that never lands. The count may only go down.
 */
const BASELINE = 7;

function emittedStrings(): string[] {
	const src = readFileSync(path.join(import.meta.dir, "..", "src", "squad-manager.ts"), "utf8");
	const found = [...src.matchAll(/emitUnitTranscriptEvent\([^,]+,\s*[A-Z_]+,\s*`([^`]+)`/g)].map((m) => m[1]!);
	return [...new Set(found)];
}

test("ratchet: card strings that only name a state stay at/under baseline", () => {
	const strings = emittedStrings();
	// A scan that finds nothing would pass this test while proving nothing — the same fail-open the
	// gate ratchets in this repo already guard against.
	expect(strings.length).toBeGreaterThan(5);
	const labels = strings.filter((text) => !explains(text.replace(/\$\{[^}]*\}/g, "X")));
	if (labels.length > BASELINE) {
		throw new Error(
			`voice: ${labels.length} emitted strings name a state without saying what it means, baseline is ${BASELINE} (+${labels.length - BASELINE}).\n` +
				`A new card was added whose text is fields joined by separators. State the fact and then what follows from it.\n` +
				labels.map((text) => `  ${explainsRatherThanLabels(text.replace(/\$\{[^}]*\}/g, "X")).why}`).join("\n"),
		);
	}
	expect(labels.length).toBeLessThanOrEqual(BASELINE);
});

test("the strings that INTERRUPT a person all explain themselves", () => {
	// The room-projecting classes are the ones that reach a human. Whatever the ratchet tolerates
	// elsewhere, these are held to the rule outright.
	const strings = emittedStrings();
	const interrupting = strings.filter((text) => /needs you|is on main|The gate says|\$\{this\.safeEventLabel\(request\.title\)\}/.test(text));
	expect(interrupting.length).toBeGreaterThan(2);
	for (const text of interrupting) {
		const verdict = explainsRatherThanLabels(text.replace(/\$\{[^}]*\}/g, "X"));
		expect(verdict.explains).toBe(true);
	}
});

test("an interruption states what is NOT affected", () => {
	const strings = emittedStrings();
	const needsYou = strings.filter((text) => text.includes("stopped rather than guess"));
	expect(needsYou.length).toBeGreaterThan(0);
	for (const text of needsYou) expect(statesBlastRadius(text)).toBe(true);
	// And a merge, which is the least reversible thing the fleet does, says so plainly.
	const landed = strings.filter((text) => text.includes("is on main"));
	expect(landed.length).toBeGreaterThan(0);
	for (const text of landed) {
		expect(statesBlastRadius(text)).toBe(true);
		expect(text).toContain("revert would be a new change, not an undo");
	}
});

test("the rule itself distinguishes a label from an explanation", () => {
	// Guarding the guard: a lint that accepts everything ratchets nothing.
	expect(explains("blocked")).toBe(false);
	expect(explains("land attempt finished · wren · ok")).toBe(false);
	expect(explains("")).toBe(false);
	expect(explains("Waiting on you — Wren stopped rather than guess. Everything else is still moving.")).toBe(true);
	expect(explainsRatherThanLabels("queued").why).toContain("names a state and stops");
	expect(explainsRatherThanLabels("a · b · c").why).toContain("fields joined by separators");
});

test("consequence and blast-radius helpers are not trivially true", () => {
	expect(statesConsequence("Land it")).toBe(false);
	expect(statesConsequence("Four files land on main. Wren then moves straight on without asking again.")).toBe(true);
	expect(statesBlastRadius("The gate failed.")).toBe(false);
	expect(statesBlastRadius("The gate failed. Nothing else in the fleet is affected.")).toBe(true);
});
