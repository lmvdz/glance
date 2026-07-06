/**
 * Session handoff across the context-window seam (Epic 7, leaf 06). The outer scripts/converge.sh
 * relaunches a fresh `claude -p "$(convergence-run --handoff)"` per warm segment; this covers the
 * pieces that make that safe: the handoff doc (seed for the cold session), its round-trip, and the
 * `--status`/`--handoff` read-only CLI the outer loop gates on. The on-disk oracle persisting across
 * the seam is the leaf 01 contract (already tested); here we prove the doc carries the mid-progress
 * state so a cold session resumes from ONLY it, with no verified gain lost.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handoffDoc, seedFromHandoff, writeOracle } from "../src/convergence-oracle.ts";
import { currentState } from "../src/convergence-run.ts";
import type { VerifiedState } from "../src/types.ts";

const state = (over: Partial<VerifiedState> = {}): VerifiedState => ({
	goalId: "plans/demo",
	iteration: 3,
	gap: 2,
	epsilon: 0,
	pendingEscalation: false,
	budget: { spent: 3, cap: 50 },
	decision: "continue",
	updatedAt: 0,
	...over,
});

describe("handoffDoc / seedFromHandoff", () => {
	test("round-trips the verified-state summary a cold session resumes from", () => {
		const s = state({ iteration: 7, gap: 4, budget: { spent: 7, cap: 20 } });
		const recovered = seedFromHandoff(handoffDoc(s));
		expect(recovered).toEqual({ goalId: s.goalId, iteration: 7, gap: 4, budget: { spent: 7, cap: 20 }, decision: "continue" });
	});

	test("the doc is a real continuation prompt (names the goal, the --once command, and 'resume')", () => {
		const doc = handoffDoc(state());
		expect(doc).toContain("plans/demo");
		expect(doc).toContain("--goal plans/demo --once");
		expect(doc.toLowerCase()).toContain("resume");
		expect(doc).toContain("do NOT restart"); // it explicitly instructs the cold session not to start over
	});

	test("seedFromHandoff returns null on a doc with no valid state block", () => {
		expect(seedFromHandoff("just some prose, no json here")).toBeNull();
		expect(seedFromHandoff("```json\n{not valid}\n```")).toBeNull();
	});
});

describe("currentState — what the read-only --status/--handoff flags resolve and the outer loop gates on", () => {
	// The `--status`/`--handoff` CLI is a thin dispatch over `currentState`: `--status` prints
	// `state.decision`, `--handoff` prints `handoffDoc(state)`. We drive `currentState` directly with
	// an explicit stateDir — the same read path the CLI takes — so the assertions cover the real logic
	// without a subprocess (a subprocess would inherit a sibling test's GLANCE_STATE_DIR from the
	// shared process env and read the wrong oracle under parallel load).
	const args = { goal: "plans/demo", fixture: undefined, once: false, handoff: true, status: false };

	test("before any oracle exists, resolves a continuable seed whose handoff doc still round-trips", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-handoff-a-"));
		try {
			const seed = await currentState(args, dir);
			expect(seed.decision).toBe("continue"); // what --status would print for a not-yet-started goal
			// A pre-oracle --handoff must still emit a machine-parseable doc (gap is a finite sentinel,
			// not Infinity, which would serialize to null and break seedFromHandoff).
			expect(seedFromHandoff(handoffDoc(seed))?.goalId).toBe("plans/demo");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("reads back the mid-progress oracle a prior warm segment persisted (state survives the cold seam)", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-handoff-b-"));
		try {
			// A prior warm segment persisted this; a FRESH cold segment resolves it from disk alone.
			await writeOracle(state({ iteration: 5, gap: 3, decision: "continue" }), dir);
			const resumed = await currentState(args, dir);
			expect(resumed.decision).toBe("continue"); // --status → continue → outer loop relaunches
			const recovered = seedFromHandoff(handoffDoc(resumed)); // --handoff → the seed doc
			expect(recovered?.iteration).toBe(5); // the cold session carries the mid-progress state
			expect(recovered?.gap).toBe(3);

			// A terminal oracle → --status reports it so the outer loop stops relaunching.
			await writeOracle(state({ decision: "converged", gap: 0 }), dir);
			expect((await currentState(args, dir)).decision).toBe("converged");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
