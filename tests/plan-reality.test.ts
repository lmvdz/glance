/**
 * Unit tests for the pure plan-vs-reality assembler (OMPSQ-448). Fabricated concerns + DoneProof, no
 * git/Plane/daemon — proves the planned×implemented×proof join, the per-concern reality-state logic,
 * blocked detection, and scope-drift math.
 */

import { expect, test } from "bun:test";
import { assemblePlanReality, type PlanRealityInputs } from "../src/plan-reality.ts";
import type { PlanConcern } from "../src/features.ts";
import type { DoneProof } from "../src/done-proof.ts";

function concern(over: Partial<PlanConcern> & { file: string; title: string; status: string }): PlanConcern {
	return {
		path: `plans/x/${over.file}`,
		priority: undefined,
		complexity: undefined,
		planeId: undefined,
		open: !["done", "landed", "merged", "closed", "complete", "completed"].includes(over.status.toLowerCase()),
		acceptanceCriteria: [],
		prerequisites: [],
		decisions: [],
		touches: [],
		content: "",
		...over,
	};
}

const proof = (over: Partial<DoneProof> = {}): DoneProof => ({
	branch: "squad/x",
	repo: "github.com/acme/x",
	mode: "pr",
	commit: "aaaa1111",
	mergeCommit: "bbbb2222",
	baseRef: "origin/main",
	verified: "green",
	detail: "",
	provenAt: 1000,
	prNumber: 42,
	...over,
});

function inputs(over: Partial<PlanRealityInputs>): PlanRealityInputs {
	return {
		feature: { id: "plan:acme:plans/x", title: "X", repo: "/repo/x", planDir: "plans/x" },
		concerns: [],
		now: 5000,
		...over,
	};
}

test("assembles planned fields per concern and a plan-level rollup", () => {
	const out = assemblePlanReality(
		inputs({
			concerns: [
				concern({ file: "01-a.md", title: "A", status: "done", priority: "p1", complexity: "medium", touches: ["src/a.ts"] }),
				concern({ file: "02-b.md", title: "B", status: "planned", touches: ["src/b.ts"] }),
			],
		}),
	);
	expect(out.rollup.totalConcerns).toBe(2);
	expect(out.rollup.done).toBe(1);
	expect(out.rollup.open).toBe(1);
	expect(out.concerns[0].priority).toBe("p1");
	expect(out.concerns[0].complexity).toBe("medium");
	expect(out.generatedAt).toBe(5000);
});

test("reality-state: a closed concern with a present, reachable proof is done-proven", () => {
	const out = assemblePlanReality(inputs({ concerns: [concern({ file: "01-a.md", title: "A", status: "done" })], proof: proof(), proofReachable: true }));
	expect(out.concerns[0].realityState).toBe("done-proven");
	expect(out.rollup.doneProven).toBe(1);
	expect(out.proof.present).toBe(true);
	expect(out.proof.reachable).toBe(true);
	expect(out.proof.verified).toBe("green");
	expect(out.proof.prNumber).toBe(42);
});

test("reality-state: a closed concern whose proof is STALE (not reachable) is done-stale", () => {
	const out = assemblePlanReality(inputs({ concerns: [concern({ file: "01-a.md", title: "A", status: "done" })], proof: proof(), proofReachable: false }));
	expect(out.concerns[0].realityState).toBe("done-stale");
	expect(out.rollup.doneStale).toBe(1);
	expect(out.proof.reachable).toBe(false);
});

test("reality-state: a closed concern with NO proof at all is done-unproven — the red flag", () => {
	const out = assemblePlanReality(inputs({ concerns: [concern({ file: "01-a.md", title: "A", status: "done" })] }));
	expect(out.concerns[0].realityState).toBe("done-unproven");
	expect(out.rollup.doneUnproven).toBe(1);
	expect(out.proof.present).toBe(false);
	expect(out.proof.reachable).toBeNull();
});

test("blocked: an OPEN concern is blocked when a sibling it depends on is not yet closed", () => {
	const out = assemblePlanReality(
		inputs({
			concerns: [
				concern({ file: "01-a.md", title: "A", status: "planned" }), // dep, still open
				concern({ file: "02-b.md", title: "B", status: "planned", prerequisites: ["Blocked by 01"] }),
				concern({ file: "03-c.md", title: "C", status: "planned", prerequisites: ["Blocked by 01"] }),
			],
		}),
	);
	// B and C are blocked by the still-open 01; A itself is not blocked.
	expect(out.concerns.find((c) => c.file === "01-a.md")!.blocked).toBe(false);
	expect(out.concerns.find((c) => c.file === "02-b.md")!.blocked).toBe(true);
	expect(out.rollup.blocked).toBe(2);
});

test("blocked: dependency satisfied (the sibling is done) ⇒ not blocked", () => {
	const out = assemblePlanReality(
		inputs({
			concerns: [
				concern({ file: "01-a.md", title: "A", status: "done" }),
				concern({ file: "02-b.md", title: "B", status: "planned", prerequisites: ["Blocked by 01"] }),
			],
		}),
	);
	expect(out.concerns.find((c) => c.file === "02-b.md")!.blocked).toBe(false);
	expect(out.rollup.blocked).toBe(0);
});

test("scope drift: planned-not-touched and touched-not-planned are computed against the REAL landed diff", () => {
	const out = assemblePlanReality(
		inputs({
			concerns: [
				concern({ file: "01-a.md", title: "A", status: "done", touches: ["src/a.ts", "src/planned-only.ts"] }),
				concern({ file: "02-b.md", title: "B", status: "done", touches: ["src/b.ts"] }),
			],
			proof: proof(),
			proofReachable: true,
			actualChangedFiles: ["src/a.ts", "src/b.ts", "src/surprise.ts"],
		}),
	);
	expect(out.rollup.scopeDrift.plannedTouches).toBe(3);
	expect(out.rollup.scopeDrift.actualChangedFiles).toBe(3);
	expect(out.rollup.scopeDrift.plannedNotTouched).toEqual(["src/planned-only.ts"]); // declared, never changed
	expect(out.rollup.scopeDrift.touchedNotPlanned).toEqual(["src/surprise.ts"]); // changed, never declared
});

test("scope drift is null-safe when the actual diff couldn't be computed", () => {
	const out = assemblePlanReality(inputs({ concerns: [concern({ file: "01-a.md", title: "A", status: "done", touches: ["src/a.ts"] })], proof: proof(), actualChangedFiles: null }));
	expect(out.rollup.scopeDrift.actualChangedFiles).toBeNull();
	expect(out.rollup.scopeDrift.plannedNotTouched).toEqual([]);
	expect(out.rollup.scopeDrift.touchedNotPlanned).toEqual([]);
});

test("a planned directory prefix in touches matches actual files nested under it", () => {
	const out = assemblePlanReality(
		inputs({
			concerns: [concern({ file: "01-a.md", title: "A", status: "done", touches: ["src/feature"] })],
			proof: proof(),
			proofReachable: true,
			actualChangedFiles: ["src/feature/impl.ts", "src/feature/impl.test.ts"],
		}),
	);
	expect(out.rollup.scopeDrift.plannedNotTouched).toEqual([]); // the dir was touched
	expect(out.rollup.scopeDrift.touchedNotPlanned).toEqual([]); // both files fall under the declared dir
});

test("live Plane state is surfaced per concern when a PLANE id resolves", () => {
	const out = assemblePlanReality(
		inputs({
			concerns: [concern({ file: "01-a.md", title: "A", status: "in-progress", planeId: "OMPSQ-343" })],
			planeStates: { "OMPSQ-343": "started" },
		}),
	);
	expect(out.concerns[0].planeState).toBe("started");
});
