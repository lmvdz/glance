/**
 * PR body projection (comprehension lane, concern 06) — pure rendering of ALREADY-RECORDED teaching
 * content into a fleet PR's body. Nothing here writes anything, calls `gh`, or touches git; nothing
 * here is ever parsed back out of a PR body (`prReconcileTick` stays untouched — DESIGN.md's
 * record-then-render architecture rule). Wiring that resolves a unit's inputs (its feature's
 * `source:"model-delta"` decisions, a matching `SymptomEntry`, observed test executions, a digest
 * excerpt) lives in `squad-manager.ts`'s `prBodyFor`; this module only turns those inputs into markdown.
 *
 * Markers are versioned HTML comments (`<!-- omp-squad:<kind>:v1 -->`) so a future tooling pass can
 * locate a section without depending on the surrounding prose, and `land-pr.ts`'s adopt-path repair
 * can tell "this body was already rendered by us" from "a human wrote this" without parsing anything
 * beyond a literal substring check — `hasModelDeltaMarker` is that one check, exported for reuse.
 *
 * Honesty rules enforced here (DESIGN.md "a signal is named by what it measures"):
 *  - An empty mental-model-delta list renders the declared line "no delta recorded" — never a silently
 *    blank section, and never omitted (contrast with the symptom section, which genuinely doesn't
 *    apply to most units and is omitted rather than padded).
 *  - The symptom section is omitted ENTIRELY when no symptom was recorded — most units fix nothing
 *    worth a symptom card, and a placeholder line would be worse than no section.
 *  - The Verified section only ever lists test executions the caller asserts were ACTUALLY OBSERVED
 *    (`testExecutions`); an empty list renders the declared line "no observed test runs recorded",
 *    mirroring the delta section's never-silent contract — this is the section blind-review keeps
 *    catching fabricated in other summaries, so it gets the same treatment as deltas rather than the
 *    softer omit-when-absent treatment symptoms get.
 *  - Deltas are capped at `MAX_DELTA_BULLETS`; anything dropped is COUNTED (not itemized — DESIGN.md
 *    "cap deltas at 3 (drop extras, count them in Not covered)") in the Not-covered section, folded in
 *    alongside whatever the caller already knows it omitted.
 */

import type { FeatureDecision } from "./types.ts";
import type { SymptomEntry } from "./symptoms.ts";

export const MODEL_DELTA_MARKER = "<!-- omp-squad:model-delta:v1 -->";
export const SYMPTOM_MARKER = "<!-- omp-squad:symptom:v1 -->";
export const TESTS_MARKER = "<!-- omp-squad:tests:v1 -->";

/** At most this many delta bullets render; the rest are counted in Not-covered (DESIGN.md). */
export const MAX_DELTA_BULLETS = 3;

export interface TestExecutionEntry {
	command: string;
	outcome: string;
	/** Where the observation came from — rendered as "(observed in transcript)" / "(observed in
	 *  repository)"; never a third value, so the rendered claim always names its own source. */
	source: "transcript" | "repository";
}

export interface OmittedEntry {
	title: string;
	reason: string;
}

export interface BuildPrBodyInput {
	/** Every `source:"model-delta"` decision on the unit's feature — NOT pre-filtered/pre-capped; this
	 *  function owns the cap and the drop-accounting. */
	deltas: FeatureDecision[];
	/** The symptom card this run recorded, if any — omit the field (not an empty object) when none. */
	symptom?: SymptomEntry;
	/** Test runs the caller can prove were actually observed (receipts/transcript), never inferred. */
	testExecutions: TestExecutionEntry[];
	/** Caller-supplied "we know about this and chose not to include it" entries — folded together
	 *  with this function's own delta-cap accounting into one Not-covered section. */
	omitted: OmittedEntry[];
	/** An already-extractive excerpt (e.g. a digest's own Summary section) — never raw transcript text.
	 *  Rendered as a leading Summary section; omitted when absent or blank. */
	digestExcerpt?: string;
}

/** True iff `body` already carries the model-delta marker — the ONE check `land-pr.ts`'s adopt-path
 *  repair uses to decide whether to touch an existing PR's body at all. A marker present means a
 *  prior float (or an earlier daemon version) already rendered this body — possibly with human edits
 *  layered around it since — and it must never be overwritten. */
export function hasModelDeltaMarker(body: string | undefined | null): boolean {
	return typeof body === "string" && body.includes(MODEL_DELTA_MARKER);
}

/** Agent-authored free prose lands verbatim in GitHub PR bodies and weekly-episode markdown, where
 *  it has two live powers an agent must not hold (cross-batch audit finding 8; code-review findings
 *  1/9/10): GitHub-active tokens (`@user` pings a person, `fixes #N` auto-closes an issue at merge)
 *  and STRUCTURE (an embedded newline lets a bullet fabricate a whole `## Verified` section byte-
 *  identical to the honest renderer's output). A zero-width space after `@`/inside `#N` renders
 *  identically but never tokenizes; collapsing `[\r\n\t]+` to a space keeps every prose field a
 *  single inert line. Record-time validators reject multiline input too — this is the render-side
 *  half of the same rule, so pre-hardening stored records stay safe. Evidence anchors and
 *  whereToLook are floor-validated paths/commands, not prose, and are rendered inside code spans. */
export function sanitizeAgentProse(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/@(?=\w)/g, "@​")
		.replace(/#(?=\d)/g, "#​")
		.trim();
}

function formatDelta(d: FeatureDecision): string {
	const evidence = (d.evidence ?? []).filter((e) => e.trim().length > 0);
	const anchor = evidence.length > 0 ? ` — evidence: \`${evidence.join(", ")}\`` : "";
	return `- ${sanitizeAgentProse(d.text)}${anchor}`;
}

function renderDeltaSection(deltas: FeatureDecision[]): { section: string; droppedCount: number } {
	const capped = deltas.slice(0, MAX_DELTA_BULLETS);
	const droppedCount = Math.max(0, deltas.length - capped.length);
	const body = capped.length > 0 ? capped.map(formatDelta).join("\n") : "no delta recorded";
	return { section: `## Mental model delta\n${MODEL_DELTA_MARKER}\n${body}`, droppedCount };
}

function renderSymptomSection(symptom: SymptomEntry | undefined): string | undefined {
	if (!symptom) return undefined;
	return `## Symptom fixed\n${SYMPTOM_MARKER}\nSymptom: ${sanitizeAgentProse(symptom.symptom)}\nWhere to look: ${symptom.whereToLook.join(", ")}`;
}

function renderTestsSection(testExecutions: TestExecutionEntry[]): string {
	const lines =
		testExecutions.length > 0
			? testExecutions
					.map((t) => `- \`${t.command}\` — ${t.outcome} (observed in ${t.source === "transcript" ? "transcript" : "repository"})`)
					.join("\n")
			: "no observed test runs recorded";
	return `## Verified\n${TESTS_MARKER}\n${lines}`;
}

function renderNotCoveredSection(omitted: OmittedEntry[], droppedDeltaCount: number): string | undefined {
	const all = [...omitted];
	if (droppedDeltaCount > 0) {
		all.push({
			title: `${droppedDeltaCount} additional mental-model delta${droppedDeltaCount === 1 ? "" : "s"}`,
			reason: `capped at ${MAX_DELTA_BULLETS} per PR body`,
		});
	}
	if (all.length === 0) return undefined;
	return `## Not covered\n${all.map((o) => `- ${o.title} — ${o.reason}`).join("\n")}`;
}

/**
 * Pure projection: recorded teaching → PR body markdown. Every section is either present-with-real-
 * content, present-with-a-declared-empty-line, or entirely omitted — never silently blank. See the
 * module doc for which sections use which rule.
 */
export function buildPrBody(input: BuildPrBodyInput): string {
	const { section: deltaSection, droppedCount } = renderDeltaSection(input.deltas);
	const sections: string[] = [];
	const excerpt = input.digestExcerpt?.trim();
	if (excerpt) sections.push(`## Summary\n${excerpt}`);
	sections.push(deltaSection);
	const symptomSection = renderSymptomSection(input.symptom);
	if (symptomSection) sections.push(symptomSection);
	sections.push(renderTestsSection(input.testExecutions));
	const notCovered = renderNotCoveredSection(input.omitted, droppedCount);
	if (notCovered) sections.push(notCovered);
	return sections.join("\n\n");
}
