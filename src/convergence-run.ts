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
import { arm, clearFailures, disarm, handoffDoc, readFailures, readOracle, writeFailures, writeOracle as persistOracle } from "./convergence-oracle.ts";
import { ratchet } from "./convergence-ratchet.ts";
import { runIteration, runToConvergence, type ConvergenceDeps, type DispatchOutcome, type PlanFrontier } from "./convergence.ts";
import { classifyProbeFailure } from "./classify-probe-failure.ts";
import { detectVerify } from "./intake.ts";
import { errText } from "./err-text.ts";
import { execGatedCommand, gateRunUnrunnable } from "./gate-runner.ts";
import { extractGateFailures } from "./land.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";
import type { FeatureCriterion, VerifiedState } from "./types.ts";

interface RunArgs {
	goal: string;
	fixture: boolean;
	/** Single-iteration mode (S2): run EXACTLY ONE `runIteration` against the current oracle and
	 *  exit. This is the command the Stop hook's re-injected prompt drives each warm turn — real
	 *  `dispatch` is a no-op (the live session did the work between turns), so `runToConvergence`
	 *  spinning in-process is the wrong production driver; `--once` is the right one. Optional at the
	 *  API boundary (default false); `parseArgs` always sets it explicitly. */
	once?: boolean;
	/** Read-only: print the current oracle's `handoffDoc` (the seed prompt the outer `converge.sh`
	 *  passes to a fresh `claude -p` after a context-window handoff), then exit. Never mutates state. */
	handoff?: boolean;
	/** Read-only: print just the current oracle's `decision` word (so the outer loop can gate on
	 *  terminality without parsing the full state), then exit. */
	status?: boolean;
}

function parseArgs(argv: string[]): RunArgs {
	let goal: string | undefined;
	let fixture = false;
	let once = false;
	let handoff = false;
	let status = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--goal") goal = argv[++i];
		else if (argv[i] === "--fixture") fixture = true;
		else if (argv[i] === "--once") once = true;
		else if (argv[i] === "--handoff") handoff = true;
		else if (argv[i] === "--status") status = true;
	}
	if (!goal) throw new Error("usage: bun src/convergence-run.ts --goal <id> [--fixture] [--once] [--handoff] [--status]");
	return { goal, fixture, once, handoff, status };
}

/** The current verified state for the READ-ONLY flags — the persisted oracle, or a fresh continuable
 *  seed at iteration 0 if none exists yet. Deliberately avoids `buildDeps` (which imports the real
 *  Epic 1/3 modules): `--handoff`/`--status` must work before a run has ever started.
 *
 *  `stateDir` is threaded explicitly (not left to the ambient `resolveStateDir()`) so a caller — a
 *  test, or the outer loop — reads the SAME oracle it wrote even when a concurrent process has a
 *  different `GLANCE_STATE_DIR`/`OMP_SQUAD_STATE_DIR` in its environment. The seed's `gap` is a
 *  finite sentinel, not `Infinity`: `Infinity` serializes to `null` in the handoff doc's JSON block
 *  and would make `seedFromHandoff` reject a pre-oracle `--handoff` as unparseable. */
export function currentState(args: RunArgs, stateDir?: string): Promise<VerifiedState> {
	return readOracle(stateDir).then(
		(oracle): VerifiedState =>
			oracle ?? {
				goalId: args.goal,
				iteration: 0,
				gap: Number.MAX_SAFE_INTEGER,
				epsilon: epsilon(),
				pendingEscalation: false,
				budget: { spent: 0, cap: budgetCap() },
				decision: "continue",
				updatedAt: Date.now(),
			},
	);
}

/**
 * The owning session's identity stamped into the arm sentinel (S1). The Stop hook (leaf 04)
 * compares the harness's turn-end `session_id` against this, blocking only on a match — so a
 * shared env flag + sentinel can never hijack an UNRELATED session. Resolved from the operator/
 * session-provided id (`OMP_SQUAD_LOOP_SESSION`, or Claude Code's `CLAUDE_SESSION_ID` when the
 * harness exports it); empty ⇒ the sentinel degrades to presence-gating (still safe, but the
 * identity guard is inert — export one of these to the SAME value the harness reports for the
 * robust guarantee).
 */
function loopSessionId(): string {
	return process.env.OMP_SQUAD_LOOP_SESSION || process.env.CLAUDE_SESSION_ID || "";
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

/**
 * The hardened working-tree diff against HEAD — `git diff HEAD`, i.e. UNCOMMITTED changes only.
 * Kept for `realValidate` below (a repo-level, single-worktree context where HEAD only moves via a
 * genuine land). NOT what Sentinel v0's mid-run drift-confirm sink uses (see `gitDiffSinceBase`
 * below) — a long-running agent commits incrementally, so at confirm time this would read "" and
 * the judge would abstain on every unit of real, committed work.
 */
export async function gitDiffAgainstHead(repo: string): Promise<string> {
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

async function gitOutAt(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
	const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return out.trim();
}

/**
 * Sentinel v0's mid-run drift-confirm diff (plans/sentinel-drift-probe, concern 02) — the agent's
 * FULL change set since its branch forked: committed commits AND uncommitted working-tree edits
 * combined, not just `gitDiffAgainstHead`'s uncommitted-only slice. A long-running agent commits
 * incrementally, so at confirm time `git diff HEAD` is routinely "" even when the unit has done (or
 * undone) substantial work — which would make `scoreAgainstCriteria` abstain on every committed
 * change, systematically under-counting drift.
 *
 * Resolution mirrors validator.ts's `computeLandDiff` upstream fallback: resolve the tracked
 * upstream (`@{u}`) or, absent one, the default remote branch (`origin/HEAD`); merge-base it against
 * HEAD; diff that merge-base against the CURRENT WORKING TREE (no second ref) so both committed and
 * uncommitted changes land in one diff. No upstream/merge-base resolves ⇒ fall back to the
 * uncommitted-only diff (better than empty). Never throws (contained; a failure degrades to the
 * fallback, which itself never throws).
 */
export async function gitDiffSinceBase(worktree: string): Promise<string> {
	try {
		const upstream = (await gitOutAt(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], worktree)) || (await gitOutAt(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], worktree));
		if (upstream) {
			const mergeBase = await gitOutAt(["merge-base", upstream, "HEAD"], worktree);
			if (mergeBase) {
				// Two-dot form (merge-base vs. the working tree, no second ref) — deliberately NOT `mergeBase...HEAD`,
				// which would only see committed commits and miss uncommitted edits still in flight mid-run.
				const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, "diff", "--no-ext-diff", mergeBase], { cwd: worktree, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
				const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
				return out;
			}
		}
	} catch {
		// fall through to the uncommitted-only fallback below — never throw.
	}
	return gitDiffAgainstHead(worktree);
}

/**
 * Real `validate` adapter: score the plan dir's still-open concerns' declared acceptance criteria
 * (Epic 3's `scoreAgainstCriteria`) against the working tree's uncommitted diff. `gap` is the count
 * of unsatisfied criteria — the independent oracle DESIGN.md §3 requires, never raw STATUS.
 *
 * `failures` (the ratchet's regression signal) is deliberately returned empty here — which means
 * THE RATCHET GUARANTEE IS DORMANT in the shipped paths (S3; recorded in DESIGN.md "Known
 * limitations"). `failures` is meant to be an actual verify/test-suite failure set (DESIGN.md §3 —
 * "the same monotonicity logic the post-merge regression gate already uses"), a DIFFERENT signal
 * from "criteria not yet satisfied". Feeding the unmet-criteria list here instead would misfire the
 * ratchet on iteration 1 of any goal that isn't already 100% done (an unmet criterion looks "new"
 * against the empty prior-failures seed) — escalating every fresh multi-criterion goal before it
 * can iterate. A real suite failure-set only exists once real `dispatch` runs (the deferred
 * warm-loop/real-dispatch scope), so the ratchet stays wired + unit-tested (`convergence-ratchet.ts`)
 * but unfed until a real single-iteration `validate` supplies it. Reporting no known regressions is
 * the conservative, safe default until then.
 */
/**
 * Thrown by `suiteFailures` when the suite demonstrably never ran (eap-borrows finding #15) — spawn
 * death, or a nonzero exit whose output carries no parseable test-failure signal (an env failure, not
 * a real red). Caught by `realValidate` (never left to reject `deps.validate`'s documented
 * never-throws contract) and by `runOnceIteration`, which skips the failures-sidecar write entirely
 * for the turn: a synthetic "no failures" entry would poison the NEXT turn's set-diff into a false
 * "new regression" once the environment recovers and the suite is red for a REAL reason.
 */
export class SuiteUnrunnableError extends Error {}

function realValidate(repo: string, prevFailures: string[] | null, onUnrunnable: (reason: string) => void): ConvergenceDeps["validate"] {
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
		try {
			return { gap: unmet.length, confidence: record.confidence, failures: await suiteFailures(repo) };
		} catch (err) {
			if (!(err instanceof SuiteUnrunnableError)) throw err;
			// Escalate WITHOUT rejecting (ConvergenceDeps.validate's documented contract: a dep that can
			// fail resolves to a safe value, e.g. low confidence, rather than reject) — confidence -1 is
			// always below the floor, so `runIteration`'s existing low-confidence branch escalates. The
			// carried-forward PRIOR failure set (never a synthetic new one) is returned so a caller that
			// insists on writing it back writes something real, not a placeholder; `runOnceIteration`
			// skips the write outright via `onUnrunnable` below.
			onUnrunnable(err.message);
			return { gap: unmet.length, confidence: -1, failures: prevFailures ?? [] };
		}
	};
}

/**
 * The repo's CURRENT verify/test-suite failure set — the ratchet's real signal (S3). Runs the same
 * verify command + failure extractor the post-merge regression gate uses (`detectVerify` + gateExec +
 * `extractGateFailures`), so "never undo a verified gain" is the exact monotonicity landing enforces —
 * NOT the unmet-acceptance-criteria list (which would misfire the ratchet on iteration 1). Empty when
 * the repo declares no verify command or the suite is green.
 *
 * FAIL-CLOSED (eap-borrows finding #15): spawn death, or a nonzero exit with no demonstrable test
 * execution (`gateRunUnrunnable` — the SAME classifier the post-merge regression gate uses), THROWS
 * `SuiteUnrunnableError` instead of the OLD best-effort `[]`. `[]` reads as "no known regressions" —
 * exactly wrong for "the suite never ran"; the loop must not treat "couldn't check" as "checked, clean".
 */
async function suiteFailures(repo: string): Promise<string[]> {
	const command = await detectVerify(repo);
	if (!command) return [];
	let run: { code: number; stdout: string; stderr: string };
	try {
		run = await execGatedCommand(command, repo, { mounts: [repo] });
	} catch (err) {
		throw new SuiteUnrunnableError(classifyProbeFailure({ kind: "spawn-error", detail: errText(err) }).reason);
	}
	const output = `${run.stdout}\n${run.stderr}`;
	if (run.code !== 0) {
		const unrunnable = gateRunUnrunnable({ code: run.code, output }, command);
		if (unrunnable) throw new SuiteUnrunnableError(classifyProbeFailure({ kind: "unparseable", detail: unrunnable }).reason);
	}
	return extractGateFailures(output);
}

async function buildDeps(args: RunArgs, repo: string, prevFailures: string[] | null = null, onUnrunnable: (reason: string) => void = () => {}): Promise<ConvergenceDeps> {
	const { plan, dispatch, validate } = args.fixture ? fixtureDeps() : { plan: realPlan(repo), dispatch: noopDispatch, validate: realValidate(repo, prevFailures, onUnrunnable) };
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

/** The fresh initial `VerifiedState` for a not-yet-started goal — a continuable seed at iteration 0. */
function seedState(args: RunArgs, deps: ConvergenceDeps): VerifiedState {
	return {
		goalId: args.goal,
		iteration: 0,
		gap: Number.POSITIVE_INFINITY,
		epsilon: deps.epsilon,
		pendingEscalation: false,
		budget: { spent: 0, cap: deps.budgetCap },
		decision: "continue",
		updatedAt: Date.now(),
	};
}

/** `repo` defaults to `process.cwd()` (the CLI's real usage); tests inject a throwaway repo dir so
 *  the real Epic 1/3 adapters never read or write the actual working tree's `plans/` directory. */
export async function runConvergence(args: RunArgs, repo: string = process.cwd()): Promise<VerifiedState> {
	const deps = await buildDeps(args, repo);
	const initial = seedState(args, deps);

	await arm(undefined, loopSessionId());
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

/**
 * Single-iteration driver (S2) — the command the Stop hook's re-injected prompt runs each warm
 * turn. Reads the current oracle (seeding a fresh continuable state if none exists), runs EXACTLY
 * ONE `runIteration` (real `plan` + real `validate` against the tree the live session just
 * modified), rewrites the oracle, and exits. Unlike `runToConvergence` it never spins in-process —
 * in real mode `dispatch` is a no-op, so one process = one iteration = one turn of work.
 *
 * Sentinel lifecycle across the multi-process hook flow: each `--once` (re)stamps the sentinel with
 * this session's identity so the NEXT turn's Stop hook still sees an armed, identity-matched
 * sentinel; when an iteration reaches a TERMINAL decision, it disarms so the loop cleans up after
 * itself. Idempotent w.r.t. the hook contract: called on an already-terminal oracle it advances
 * nothing (the hook would not have re-injected in that case) and disarms.
 *
 * Prior-iteration `failures` ARE carried across the `--once` process boundary — but via the failures
 * SIDECAR (`readFailures`/`writeFailures`), NOT the oracle, which the cross-process schema deliberately
 * keeps pinned (§1). The first turn reads `null` (no sidecar) → baseline, no ratchet; every later turn
 * ratchets this turn's suite failures against the previous turn's, making the no-regression guarantee
 * live in the real loop (S3 — formerly dormant).
 *
 * Two fail-closed escalation paths (eap-borrows findings #15/#16), both short-circuiting BEFORE any
 * of this turn's real work: a CORRUPT sidecar (#16, distinct from "no sidecar yet") escalates without
 * ever calling `runIteration` — the corrupt file is left on disk untouched for a human to inspect, the
 * oracle is NOT reseeded, and nothing is silently treated as a fresh baseline. A suite that
 * demonstrably never ran this turn (#15, surfaced via `onUnrunnable`) still runs the state machine
 * (so `plan`/`decide` still happen and confidence-floor escalation fires), but the sidecar write is
 * skipped entirely — never a synthetic "no failures" entry.
 */
export async function runOnceIteration(args: RunArgs, repo: string = process.cwd()): Promise<VerifiedState> {
	let prevFailures: string[] | null;
	let sidecarCorrupt: string | undefined;
	try {
		prevFailures = await readFailures();
	} catch (err) {
		prevFailures = null;
		sidecarCorrupt = errText(err);
	}

	let suiteUnrunnable = false;
	const deps = await buildDeps(args, repo, prevFailures, () => {
		suiteUnrunnable = true;
	});
	const current = (await readOracle()) ?? seedState(args, deps);

	// Idempotent: an already-terminal oracle is left untouched (the hook would not have re-injected),
	// and the sentinel + failures sidecar are cleaned up.
	if (current.decision !== "continue") {
		await disarm();
		await clearFailures();
		return current;
	}

	if (sidecarCorrupt) {
		const next: VerifiedState = { ...current, decision: "escalate", pendingEscalation: true, updatedAt: Date.now() };
		await persistOracle(next);
		await disarm();
		console.error(`convergence: failures sidecar corrupt — escalating without ratcheting; sidecar left on disk for inspection: ${sidecarCorrupt}`);
		return next;
	}

	// (Re)arm with this session's identity so the next turn's Stop hook stays gated to us.
	await arm(undefined, loopSessionId());
	const { next, failures } = await runIteration(current, deps, prevFailures);
	// A suite-unrunnable turn (finding #15) skips the write outright — `failures` here is only the
	// carried-forward prior set (see `realValidate`), and even a same-value rewrite is the wrong
	// guarantee: the NEXT turn must compare against the last REAL suite run, not a stand-in.
	if (!suiteUnrunnable) await writeFailures(failures); // hand this turn's set to the next `--once` process
	// A terminal outcome ends the loop — disarm + drop the sidecar so no stale state survives the run.
	if (next.decision !== "continue") {
		await disarm();
		if (!suiteUnrunnable) await clearFailures();
	}
	return next;
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.handoff || args.status) {
		// Read-only handoff/status: never arm, never mutate — the outer converge.sh loop calls these
		// between warm segments to gate on terminality and to seed the next cold session.
		currentState(args)
			.then((state) => {
				console.log(args.status ? state.decision : handoffDoc(state));
				process.exit(0);
			})
			.catch((err) => {
				console.error(err instanceof Error ? err.message : String(err));
				process.exit(1);
			});
	} else {
		const run = args.once ? runOnceIteration(args) : runConvergence(args);
		run
		.then((terminal) => {
			console.log(JSON.stringify(terminal, null, 2));
			// --once is a single step: exit 0 unless it produced a hard-stop (escalate/budget). A
			// still-continuing oracle is a successful step (0). A converged oracle is success (0).
			const ok = terminal.decision === "converged" || terminal.decision === "continue";
			process.exit(ok ? 0 : 1);
		})
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
	}
}
