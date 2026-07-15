/**
 * PR body projection (comprehension lane concern 06) — `src/pr-body.ts`'s pure `buildPrBody`. No git,
 * no `gh`, no manager wiring — the wired path (`squad-manager.ts`'s `prBodyFor`) is exercised through
 * the float-time integration in `tests/land-pr.test.ts`'s adopt-path-repair coverage.
 */
import { expect, test } from "bun:test";
import { buildPrBody, hasModelDeltaMarker, MAX_DELTA_BULLETS, MODEL_DELTA_MARKER, SYMPTOM_MARKER, TESTS_MARKER } from "../src/pr-body.ts";
import type { FeatureDecision } from "../src/types.ts";
import type { SymptomEntry } from "../src/symptoms.ts";

function delta(text: string, evidence?: string[]): FeatureDecision {
	return { id: crypto.randomUUID(), text, source: "model-delta", evidence, createdAt: Date.now() };
}

function symptom(overrides: Partial<SymptomEntry> = {}): SymptomEntry {
	return {
		id: "sym1",
		symptom: "daemon healthy but dispatch stalled",
		whereToLook: ["src/dispatch.ts"],
		repo: "/repo",
		fixedBy: { agentId: "agent-1", runId: "run-1" },
		landedAt: Date.now(),
		...overrides,
	};
}

test("empty deltas render the declared 'no delta recorded' line, never a silently blank section", () => {
	const body = buildPrBody({ deltas: [], testExecutions: [], omitted: [] });
	expect(body).toContain("## Mental model delta");
	expect(body).toContain(MODEL_DELTA_MARKER);
	expect(body).toContain("no delta recorded");
});

test("a delta renders its text with a backtick-wrapped evidence anchor", () => {
	const body = buildPrBody({
		deltas: [delta("Dispatch used to serialize spawns; it now fans out concurrently.", ["src/dispatch.ts:10-40"])],
		testExecutions: [],
		omitted: [],
	});
	expect(body).toContain("- Dispatch used to serialize spawns; it now fans out concurrently. — evidence: `src/dispatch.ts:10-40`");
});

test("a delta with multiple evidence entries joins them into one backtick span", () => {
	const body = buildPrBody({
		deltas: [delta("Two files now cooperate on this.", ["src/a.ts", "src/b.ts:5-9"])],
		testExecutions: [],
		omitted: [],
	});
	expect(body).toContain("evidence: `src/a.ts, src/b.ts:5-9`");
});

test("a delta with no evidence entries renders with no evidence suffix at all", () => {
	const body = buildPrBody({ deltas: [delta("Some plan-sourced decision with no evidence.")], testExecutions: [], omitted: [] });
	expect(body).toContain("- Some plan-sourced decision with no evidence.\n");
	expect(body).not.toContain("evidence:");
});

test("deltas beyond the cap are dropped and counted in Not covered, not itemized", () => {
	const deltas = Array.from({ length: 5 }, (_, i) => delta(`Delta number ${i} changed something real.`, [`src/f${i}.ts`]));
	const body = buildPrBody({ deltas, testExecutions: [], omitted: [] });
	const deltaBullets = body.split("## Verified")[0].split("\n").filter((l) => l.startsWith("- Delta"));
	expect(deltaBullets.length).toBe(MAX_DELTA_BULLETS);
	expect(body).toContain("## Not covered");
	expect(body).toContain("2 additional mental-model deltas — capped at 3 per PR body");
});

test("exactly one dropped delta uses singular phrasing", () => {
	const deltas = Array.from({ length: 4 }, (_, i) => delta(`Delta number ${i} changed something real.`, [`src/f${i}.ts`]));
	const body = buildPrBody({ deltas, testExecutions: [], omitted: [] });
	expect(body).toContain("1 additional mental-model delta — capped at 3 per PR body");
	expect(body).not.toContain("1 additional mental-model deltas");
});

test("no symptom recorded ⇒ the Symptom fixed section is omitted entirely", () => {
	const body = buildPrBody({ deltas: [], testExecutions: [], omitted: [] });
	expect(body).not.toContain("Symptom fixed");
	expect(body).not.toContain(SYMPTOM_MARKER);
});

test("a recorded symptom renders its text and whereToLook, joined", () => {
	const body = buildPrBody({
		deltas: [],
		symptom: symptom({ whereToLook: ["src/dispatch.ts", "src/scheduler.ts"] }),
		testExecutions: [],
		omitted: [],
	});
	expect(body).toContain("## Symptom fixed");
	expect(body).toContain(SYMPTOM_MARKER);
	expect(body).toContain("Symptom: daemon healthy but dispatch stalled");
	expect(body).toContain("Where to look: src/dispatch.ts, src/scheduler.ts");
});

test("observed-only test lines render command, outcome, and source label — transcript vs repository", () => {
	const body = buildPrBody({
		deltas: [],
		testExecutions: [
			{ command: "bun test", outcome: "42 pass", source: "transcript" },
			{ command: "bunx tsc --noEmit", outcome: "clean", source: "repository" },
		],
		omitted: [],
	});
	expect(body).toContain("## Verified");
	expect(body).toContain(TESTS_MARKER);
	expect(body).toContain("- `bun test` — 42 pass (observed in transcript)");
	expect(body).toContain("- `bunx tsc --noEmit` — clean (observed in repository)");
});

test("no observed test executions ⇒ a declared line, never a silently blank Verified section", () => {
	const body = buildPrBody({ deltas: [], testExecutions: [], omitted: [] });
	expect(body).toContain("## Verified");
	expect(body).toContain("no observed test runs recorded");
});

test("caller-supplied omitted entries render in Not covered", () => {
	const body = buildPrBody({ deltas: [], testExecutions: [], omitted: [{ title: "episode narration", reason: "concern 09 not yet landed" }] });
	expect(body).toContain("## Not covered");
	expect(body).toContain("- episode narration — concern 09 not yet landed");
});

test("nothing omitted and no deltas dropped ⇒ the Not covered section is omitted entirely", () => {
	const body = buildPrBody({ deltas: [delta("One real delta, under the cap.", ["src/a.ts"])], testExecutions: [], omitted: [] });
	expect(body).not.toContain("Not covered");
});

test("caller-supplied omitted entries and delta-cap dropouts both land in the same Not covered section", () => {
	const deltas = Array.from({ length: 4 }, (_, i) => delta(`Delta number ${i} changed something real.`, [`src/f${i}.ts`]));
	const body = buildPrBody({ deltas, testExecutions: [], omitted: [{ title: "voice narration", reason: "external PR #186 unmerged" }] });
	const notCovered = body.split("## Not covered\n")[1];
	expect(notCovered).toContain("voice narration — external PR #186 unmerged");
	expect(notCovered).toContain("1 additional mental-model delta — capped at 3 per PR body");
});

test("a digestExcerpt renders as a leading Summary section; absent excerpt omits it", () => {
	const withExcerpt = buildPrBody({ deltas: [], testExecutions: [], omitted: [], digestExcerpt: "- fixed the dispatch stall\n- added a regression test" });
	expect(withExcerpt.startsWith("## Summary\n- fixed the dispatch stall\n- added a regression test")).toBe(true);

	const withoutExcerpt = buildPrBody({ deltas: [], testExecutions: [], omitted: [] });
	expect(withoutExcerpt).not.toContain("## Summary");

	const blankExcerpt = buildPrBody({ deltas: [], testExecutions: [], omitted: [], digestExcerpt: "   " });
	expect(blankExcerpt).not.toContain("## Summary");
});

test("section order is Summary, Mental model delta, Symptom fixed, Verified, Not covered", () => {
	const body = buildPrBody({
		deltas: [delta("A real delta.", ["src/a.ts"])],
		symptom: symptom(),
		testExecutions: [{ command: "bun test", outcome: "green", source: "transcript" }],
		omitted: [{ title: "x", reason: "y" }],
		digestExcerpt: "prior context",
	});
	const order = ["## Summary", "## Mental model delta", "## Symptom fixed", "## Verified", "## Not covered"].map((h) => body.indexOf(h));
	for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
});

// ── hasModelDeltaMarker — the exact check land-pr.ts's adopt-path repair relies on ────────────────

test("hasModelDeltaMarker: true only when the exact versioned marker substring is present", () => {
	expect(hasModelDeltaMarker(buildPrBody({ deltas: [], testExecutions: [], omitted: [] }))).toBe(true);
	expect(hasModelDeltaMarker("a human wrote this PR body by hand")).toBe(false);
	expect(hasModelDeltaMarker(undefined)).toBe(false);
	expect(hasModelDeltaMarker(null)).toBe(false);
	expect(hasModelDeltaMarker("")).toBe(false);
	// A differently-versioned marker (a hypothetical future v2) must NOT satisfy the v1 check —
	// version bumps are meant to be distinguishable, not silently compatible.
	expect(hasModelDeltaMarker("<!-- omp-squad:model-delta:v2 -->")).toBe(false);
});
