/**
 * Convergence-run entrypoint (Epic 7, leaf 05) — what an operator actually runs to start a
 * convergence loop:
 *
 *   bun src/convergence-run.ts --goal <id> [--fixture]
 *
 * Builds the real `ConvergenceDeps` (leaf 02) — `ratchet` from `src/convergence-ratchet.ts` (leaf
 * 03), `writeOracle` from `src/convergence-oracle.ts` (leaf 01), and `plan`/`validate` adapters
 * over the now-landed Epic 1 (`src/planner.ts`) / Epic 3 (`src/validator.ts`) modules — arms the
 * sentinel, runs `runToConvergence` (leaf 02), and disarms in a `finally` so a crash never leaves
 * the Stop hook (leaf 04) live for an unrelated future session. `--fixture` swaps in a deterministic
 * fake planner+validator over a tiny 3-criterion meta-goal whose gap closes in 3 cycles, so the
 * whole pipeline (leaves 01-04) is exercisable end-to-end without an LLM/fleet in the loop.
 *
 * DISPATCH NOTE (DESIGN.md's warm-loop premise): the actual "do the work" step is the LIVE Claude
 * Code session driven by the Stop hook's re-injected continuation prompt — the session uses its own
 * tools between hook turns, it is not this process spawning/awaiting a sub-fleet synchronously. So
 * `dispatch` here is a documented no-op in BOTH modes: fixture (nothing to dispatch, the fake
 * validator's gap schedule stands in for "work happened") and real (the driving session already did
 * the work in the turn that led to this iteration; wiring an actual synchronous spawn-and-await of
 * Epic 2's fleet is out of this leaf's scope — see DESIGN.md §2's ConvergenceDeps comment: "Epic
 * 2/existing fleet").
 */

import "./env-compat.ts"; // GLANCE_* ↔ OMP_SQUAD_* aliasing — must run before any env read
import * as path from "node:path";
import { arm, disarm, writeOracle as persistOracle } from "./convergence-oracle.ts";
import { ratchet } from "./convergence-ratchet.ts";
import { runToConvergence, type ConvergenceDeps, type DispatchOutcome, type PlanFrontier } from "./convergence.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";
import type { FeatureCriterion, VerifiedState } from "./types.ts";

interface RunArgs {
	goal: string;
	fixture: boolean;
}

function parseArgs(argv: string[]): RunArgs {
	let goal: string | undefined;
	let fixture = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--goal") goal = argv[++i];
		else if (argv[i] === "--fixture") fixture = true;
	}
	if (!goal) throw new Error("usage: bun src/convergence-run.ts --goal <id> [--fixture]");
	return { goal, fixture };
}

function envNumber(key: string, fallback: number): number {
	const raw = Number(process.env[key]);
	return Number.isFinite(raw) && process.env[key] !== undefined ? raw : fallback;
}

/** Epic 5 (HITL safeguards) default confidence floor — mirrors `confidenceFloor()` in
 *  `src/squad-manager.ts:265` (same env var, same 0.4 default; not imported directly since that
 *  function is module-private and additionally reads the Epic 6 threshold tuner, which is a
 *  daemon-lifecycle concern out of scope for a standalone convergence run). */
function confidenceFloor(): number {
	return envNumber("OMP_SQUAD_CONFIDENCE_FLOOR", 0.4);
}

function budgetCap(): number {
	return envNumber("OMP_SQUAD_CONVERGENCE_BUDGET_CAP", 50);
}

function epsilon(): number {
	return envNumber("OMP_SQUAD_CONVERGENCE_EPSILON", 0);
}

// ── Fixture adapter — a tiny 3-criterion meta-goal whose gap closes 3→2→1→0 over 3 iterations ──

/** No-op in both modes: the actual "do the work" step is the LIVE session's own tool calls between
 *  Stop-hook turns, not a synchronous spawn-and-await inside this process (see module doc). */
async function noopDispatch(): Promise<DispatchOutcome> {
	return { settled: true };
}

function fixtureDeps(): Pick<ConvergenceDeps, "plan" | "dispatch" | "validate"> {
	const gaps = [3, 2, 1, 0];
	let call = 0;
	return {
		plan: async (): Promise<PlanFrontier> => ({ ids: ["fixture-criterion-a", "fixture-criterion-b", "fixture-criterion-c"] }),
		dispatch: noopDispatch,
		validate: async () => {
			const gap = gaps[Math.min(call, gaps.length - 1)];
			call++;
			return { gap, confidence: 0.95, failures: [] };
		},
	};
}

// ── Real adapters — Epic 1 (planner.ts) / Epic 3 (validator.ts), guarded by a dynamic import ──

/** `goalId` maps onto the resident-planner convention: a repo-relative plan dir, e.g. "plans/demo"
 *  (a bare "demo" is treated as "plans/demo"). */
function planDirFor(goalId: string): string {
	return goalId.startsWith("plans/") || goalId.startsWith("plans" + path.sep) ? goalId : path.join("plans", goalId);
}

async function importPlannerModules() {
	try {
		const [planner, features, writer, intake] = await Promise.all([import("./planner.ts"), import("./features.ts"), import("./plan-writer.ts"), import("./intake.ts")]);
		return { planner, features, writer, intake };
	} catch (err) {
		throw new Error(`Epic 1 (src/planner.ts) not landed — run with --fixture (${err instanceof Error ? err.message : String(err)})`);
	}
}

async function importValidatorModule() {
	try {
		return await import("./validator.ts");
	} catch (err) {
		throw new Error(`Epic 3 (src/validator.ts) not landed — run with --fixture (${err instanceof Error ? err.message : String(err)})`);
	}
}

/** Real `plan` adapter: refresh the frontier against the plan dir's on-disk concerns (Epic 1's
 *  `parsePlanConcerns`); if none are open, ask `decompose` (Epic 1's `planner.ts`) to draft fresh
 *  work off `OBJECTIVE.md`, using the real `ompClassify` LLM call, and write it via `writeConcernDrafts`. */
function realPlan(repo: string): ConvergenceDeps["plan"] {
	return async (goalId: string): Promise<PlanFrontier> => {
		const { planner, features, writer, intake } = await importPlannerModules();
		const planDir = planDirFor(goalId);
		const existing = await features.parsePlanConcerns(repo, planDir);
		const open = existing.filter((c) => c.open);
		if (open.length > 0) return { ids: open.map((c) => c.file) };

		const objective = await Bun.file(path.join(repo, planDir, "OBJECTIVE.md"))
			.text()
			.catch(() => "");
		if (!objective.trim()) return { ids: [] }; // nothing planned, nothing to decompose from

		const verified = existing
			.filter((c) => !c.open)
			.map((c) => ({ num: features.concernNumFromFile(c.file) ?? undefined, title: c.title, planeId: c.planeId }));
		const drafts = await planner.decompose({
			objective,
			verified,
			existing: [],
			classify: intake.ompClassify(process.env.OMP_BIN ?? "omp", planner.DECOMPOSE_TIMEOUT_MS),
		});
		if (drafts.length === 0) return { ids: [] };
		const result = await writer.writeConcernDrafts(repo, planDir, drafts);
		if (!result.ok) return { ids: [] };
		const written = await features.parsePlanConcerns(repo, planDir);
		return { ids: written.filter((c) => c.open).map((c) => c.file) };
	};
}

async function gitDiffAgainstHead(repo: string): Promise<string> {
	try {
		// --no-ext-diff is load-bearing: GIT_HARDEN_ENV sets diff.external="", which otherwise makes
		// git try to exec "" as an external differ and return EMPTY output for every diff.
		const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, "diff", "--no-ext-diff", "HEAD"], { cwd: repo, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
		const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return out;
	} catch {
		return "";
	}
}

/**
 * Real `validate` adapter: score the plan dir's still-open concerns' declared acceptance criteria
 * (Epic 3's `scoreAgainstCriteria`) against the working tree's uncommitted diff. `gap` is the count
 * of unsatisfied criteria — the independent oracle DESIGN.md §3 requires, never raw STATUS.
 *
 * `failures` (the ratchet's regression signal) is deliberately returned empty here: it is meant to
 * be an actual verify/test-suite failure set (DESIGN.md §3 — "the same monotonicity logic the
 * post-merge regression gate already uses"), which is a DIFFERENT signal from "criteria not yet
 * satisfied". Conflating the two would make the ratchet fire on iteration 1 of any goal that isn't
 * already 100% done (an unmet criterion looks "new" against the empty prior-failures seed
 * `runToConvergence` starts with) — escalating every fresh multi-criterion goal before it ever gets
 * a chance to iterate, which defeats the loop's purpose. Wiring a real per-iteration suite run here
 * would also mean re-running this repo's FULL verify command every cycle, which is out of this
 * leaf's declared scope (leaf 05 only requires the plan/validate ADAPTERS; leaf 03 already delivers
 * the pure `ratchet()`/`ratchetFromOutput()` functions a caller with real suite output can use).
 * Reporting no known regressions here is the conservative, safe default until that wiring lands.
 */
function realValidate(repo: string): ConvergenceDeps["validate"] {
	return async (goalId: string) => {
		const validator = await importValidatorModule();
		const { parsePlanConcerns } = await import("./features.ts");
		const planDir = planDirFor(goalId);
		const concerns = await parsePlanConcerns(repo, planDir);
		const open = concerns.filter((c) => c.open);
		if (open.length === 0) return { gap: 0, confidence: 1, failures: [] };

		const criteria: FeatureCriterion[] = open.flatMap((c) => c.acceptanceCriteria.map((text, i): FeatureCriterion => ({ id: `${c.file}#${i}`, text, completed: false, source: "plan" })));
		if (criteria.length === 0) return { gap: open.length, confidence: 0, failures: [] };

		const diff = await gitDiffAgainstHead(repo);
		const record = await validator.scoreAgainstCriteria(criteria, diff);
		const unmet = record.perCriterion.filter((p) => !p.satisfied).map((p) => p.id);
		return { gap: unmet.length, confidence: record.confidence, failures: [] };
	};
}

async function buildDeps(args: RunArgs, repo: string): Promise<ConvergenceDeps> {
	const { plan, dispatch, validate } = args.fixture ? fixtureDeps() : { plan: realPlan(repo), dispatch: noopDispatch, validate: realValidate(repo) };
	return {
		plan,
		dispatch,
		validate,
		ratchet,
		writeOracle: (s: VerifiedState) => persistOracle(s),
		confidenceFloor: confidenceFloor(),
		budgetCap: budgetCap(),
		epsilon: epsilon(),
	};
}

/** `repo` defaults to `process.cwd()` (the CLI's real usage); tests inject a throwaway repo dir so
 *  the real Epic 1/3 adapters never read or write the actual working tree's `plans/` directory. */
export async function runConvergence(args: RunArgs, repo: string = process.cwd()): Promise<VerifiedState> {
	const deps = await buildDeps(args, repo);
	const initial: VerifiedState = {
		goalId: args.goal,
		iteration: 0,
		gap: Number.POSITIVE_INFINITY,
		epsilon: deps.epsilon,
		pendingEscalation: false,
		budget: { spent: 0, cap: deps.budgetCap },
		decision: "continue",
		updatedAt: Date.now(),
	};

	await arm();
	// Belt with the sentinel (DESIGN.md §5) — set for this process AND any child turn it spawns.
	process.env.OMP_SQUAD_LOOP_ARMED = "1";
	try {
		return await runToConvergence(initial, deps);
	} finally {
		// A crash must never leave the sentinel armed — an orphaned sentinel plus a stale env flag
		// in some OTHER future session would be the exact immortal-session failure mode this guards.
		await disarm();
	}
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	runConvergence(args)
		.then((terminal) => {
			console.log(JSON.stringify(terminal, null, 2));
			process.exit(terminal.decision === "converged" ? 0 : 1);
		})
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
