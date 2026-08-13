/**
 * Acceptance criteria for a SELF-LAND (glance#391, R1 gap G3 — the ship blocker).
 *
 * `scoreAgainstCriteria` returns `"skipped"` for an empty criteria list (validator.ts:496) and
 * `withFreshReviewerPrecision` leaves a skipped record unstamped (validator.ts:839), so a land with
 * no declared criteria writes a `landed:true, precision:absent` index row that `isMeasuredLand`
 * counts as UNMEASURED — a fully green-looking land that contributes ZERO evidence to the dogfood
 * window. A hand-opened glance PR has neither a `featureId` nor an `opts.criteria`, so that is
 * exactly what every self-land would produce.
 *
 * This module is the criteria SOURCE that closes the hole. Two, and only two, honest sources:
 *  1. The PR body's own declared acceptance section — a `## Acceptance` (or `Acceptance criteria` /
 *     `Acceptance tests`) heading followed by a markdown CHECKLIST. Structure, not prose: only
 *     `- [ ]` / `- [x]` items count.
 *  2. Criteria supplied explicitly at call time by whoever routed the land.
 *
 * Anything else — prose under the heading, a checklist with no heading, a "What/Gates" section —
 * yields NOTHING, and `selfLand` then REFUSES rather than landing unmeasured. Inferring criteria
 * from arbitrary prose is precisely the "invent criteria to grade against" move DESIGN §4 forbids,
 * and it would be worse here than an empty list: a fabricated criterion produces a real-looking
 * verdict with no declared intent behind it.
 */

import type { FeatureCriterion } from "../../types.ts";

/** Bound what reaches the judge prompt: a PR body is untrusted human text. */
const MAX_CRITERIA = 20;
const MAX_TEXT = 500;

/** `## Acceptance`, `### Acceptance criteria`, `## Acceptance tests (all must hold)`, `## Criteria`. */
const ACCEPTANCE_HEADING = /^\s{0,3}#{1,6}\s+(acceptance\b.*|criteria\b.*)$/i;
const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

/**
 * The declared acceptance criteria carried by a PR body, or `[]` when the body declares none.
 * Pure and total: no body, no heading, or a heading with no checklist all mean "none declared".
 *
 * Ids are positional (`ac1`…) — stable for one body, and `validatorGate`'s cache key hashes
 * `id=text` pairs, so an edited criterion re-judges rather than re-serving the old verdict.
 */
export function acceptanceCriteriaFromPrBody(body: string | undefined): FeatureCriterion[] {
	if (!body?.trim()) return [];
	const lines = body.split(/\r?\n/);
	const out: FeatureCriterion[] = [];
	let inSection = false;
	for (const line of lines) {
		if (ANY_HEADING.test(line)) {
			// A new heading always closes the current section; entering an acceptance heading opens one.
			// The FIRST acceptance section that actually yields items wins — a later "## Acceptance" in a
			// review comment quoted into the body cannot append to (or overwrite) it.
			if (inSection && out.length > 0) break;
			inSection = ACCEPTANCE_HEADING.test(line);
			continue;
		}
		if (!inSection) continue;
		const m = CHECKLIST_ITEM.exec(line);
		if (!m) continue;
		const text = m[2]!.trim().slice(0, MAX_TEXT);
		if (!text) continue;
		out.push({ id: `ac${out.length + 1}`, text, completed: m[1]!.toLowerCase() === "x", source: "ticket" });
		if (out.length >= MAX_CRITERIA) break;
	}
	return out;
}

/**
 * Criteria supplied at call time (the route's `criteria: string[]`, or an operator's own list).
 * Blank entries are dropped rather than becoming an empty criterion the judge would grade as
 * unsatisfiable. Same bounds as the PR-body path — one shape reaches the judge, whatever the source.
 */
export function criteriaFromTexts(texts: readonly string[]): FeatureCriterion[] {
	const out: FeatureCriterion[] = [];
	for (const raw of texts) {
		const text = typeof raw === "string" ? raw.trim().slice(0, MAX_TEXT) : "";
		if (!text) continue;
		out.push({ id: `ac${out.length + 1}`, text, completed: false, source: "manual" });
		if (out.length >= MAX_CRITERIA) break;
	}
	return out;
}
