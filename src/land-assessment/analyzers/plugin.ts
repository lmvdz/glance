/**
 * The `AssessmentAnalyzer` contract (concern 03, `plans/land-assessment/03-topology-analyzer.md`) —
 * the pluggable-module seam DESIGN.md's Approach describes: an assessment "envelope" at the land
 * boundary whose analyses are swappable, offline-replayable modules. `topology.ts` is the first
 * implementation; the TypeScript structural-delta analyzer (concern 04) is the second, sharing this
 * exact contract.
 *
 * `runAnalyzers()` is the registry: it runs every APPLICABLE analyzer against one `AnalyzerContext`,
 * concatenates their observations/findings, and — the concern's explicit requirement — turns a
 * THROWN analyzer error into an `ExtractionCoverage` gap rather than letting one broken analyzer
 * vanish the whole assessment (or worse, an unhandled rejection). Absence is always a gap, never
 * "safe" (SCHEMA-V0.md's coverage doc), and a crashed analyzer is the starkest case of absence.
 */

import { errText } from "../../err-text.ts";
import { hardenedGit } from "../../git-harden.ts";
import type { TaxonomyClass } from "../replay/incident-taxonomy.ts";
import type { AssessmentFinding, ExtractionCoverage, SnapshotFact } from "../schema.ts";

/**
 * Everything an analyzer needs to assess ONE land attempt, offline-replayable: three commits, no
 * worktree checkout, no daemon state. `repo` is a local git checkout path an analyzer reads with
 * plain, read-only `git` plumbing — it never mutates the checkout (matches DESIGN.md's rejection of
 * detached-worktree checkouts: "every claimed detection class is syntactic/pure-git").
 */
export interface AnalyzerContext {
	repo: string;
	baseCommit: string;
	mainCommit: string;
	candidateCommit: string;
}

/** One analyzer's output for one `AnalyzerContext` — observations are the durable raw material,
 *  findings are re-derivable interpretations (SCHEMA-V0.md's "Observations (the durable product)"),
 *  coverage is per-analyzer-run (an analyzer-level `ExtractionCoverage[]`, distinct from the
 *  per-FINDING `CoverageDescriptor` each `AssessmentFinding.coverage` carries). */
export interface AnalysisResult {
	observations: SnapshotFact[];
	findings: AssessmentFinding[];
	coverage: ExtractionCoverage[];
}

/** One pluggable analysis module. `claimedClasses` ties an analyzer to the fixed nine-class taxonomy
 *  (`incident-taxonomy.ts`) so replay only ever judges an analyzer against the classes it actually
 *  claims — "a stacked-base miss is a topology-analyzer matter, never a structural-delta false
 *  negative" (BRIEF §10.4, restated in DESIGN.md's Approach). */
export interface AssessmentAnalyzer {
	name: string;
	version: string;
	claimedClasses: readonly TaxonomyClass[];
	applicable(ctx: AnalyzerContext): boolean | Promise<boolean>;
	run(ctx: AnalyzerContext): Promise<AnalysisResult>;
}

export interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The shared hardened-git exec every analyzer routes through — mirrors `land.ts`/`land-pr.ts`'s own
 * private `git()` helper (trimmed `hardenedGit` output) so this pure library never re-derives its own
 * hardening args and never risks running an untrusted repo's `core.hooksPath`/`diff.external`/pager.
 * `opts.stdin` exists for the one detection that needs to pipe one git command's stdout into another
 * (`git log -p | git patch-id`, in `topology.ts`'s transplanted-lineage detection) without shelling
 * out to a real pipeline.
 */
export async function git(args: string[], cwd: string, opts?: { stdin?: string }): Promise<GitRun> {
	const r = await hardenedGit(args, { cwd, stdin: opts?.stdin });
	return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function crashGap(analyzerName: string, phase: "applicable" | "run", err: unknown): ExtractionCoverage {
	return { dimension: "syntax", covered: 0, total: 1, gaps: [{ reason: `${analyzerName} analyzer's ${phase}() crashed: ${errText(err)}` }] };
}

/**
 * Execute every APPLICABLE analyzer against `ctx` and merge their output. A thrown error — from
 * either `applicable()` or `run()` — becomes an `ExtractionCoverage` gap for that analyzer instead of
 * rejecting the whole call: one broken analyzer must never silently erase every OTHER analyzer's
 * findings for the same land attempt.
 *
 * Observations and findings are sorted by their own stable id (`factId`/`id`) before returning —
 * DESIGN.md's "Output deterministically sorted" — so the merged result never depends on analyzer
 * registration order or any one analyzer's internal iteration order.
 *
 * @substrate Phase-1 producer (concern 03) with no external caller yet -- the land hook (concern 08)
 * and the offline replay CLI wire this registry up to a real analyzer list in later concerns
 * (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own
 * carve-out).
 */
export async function runAnalyzers(analyzers: readonly AssessmentAnalyzer[], ctx: AnalyzerContext): Promise<AnalysisResult> {
	const observations: SnapshotFact[] = [];
	const findings: AssessmentFinding[] = [];
	const coverage: ExtractionCoverage[] = [];
	for (const analyzer of analyzers) {
		let applicable: boolean;
		try {
			applicable = await analyzer.applicable(ctx);
		} catch (err) {
			coverage.push(crashGap(analyzer.name, "applicable", err));
			continue;
		}
		if (!applicable) continue;
		try {
			const result = await analyzer.run(ctx);
			observations.push(...result.observations);
			findings.push(...result.findings);
			coverage.push(...result.coverage);
		} catch (err) {
			coverage.push(crashGap(analyzer.name, "run", err));
		}
	}
	observations.sort((a, b) => a.factId.localeCompare(b.factId));
	findings.sort((a, b) => a.id.localeCompare(b.id));
	return { observations, findings, coverage };
}
