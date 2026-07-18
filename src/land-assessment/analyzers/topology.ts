/**
 * Topology analyzer (concern 03, `plans/land-assessment/03-topology-analyzer.md`) — pure-git,
 * fully offline-replayable, deterministic. Owns the two incident classes with REAL labeled positives
 * per `incident-taxonomy.ts`'s `CLAIMED_BY` (`git-topology`, `workflow-state`) — the wedge's go/no-go
 * evidence producer (ADR.md's Phase gates; DESIGN.md's "Analyzer sequencing" decision).
 *
 * Four independent detections, each producing its own `SnapshotFact`s + one `AssessmentFinding`:
 *
 *   stacked-base          candidate's fork point disagrees between its declared base and current
 *                         main (`merge-base(candidate, main) !== merge-base(candidate, base)`) — the
 *                         wrong-base class: the declared base has diverged from main's own lineage.
 *   orphaned-merge        commits reachable from `candidateCommit` that are NOT reachable from
 *                         `mainCommit` (`git rev-list candidate --not main`) — the orphaned-merged-PR
 *                         class. Ancestry-based (SHA reachability), deliberately NOT patch-id based —
 *                         that's the next detection, kept separate on purpose.
 *   transplanted-lineage  candidate commits whose PATCH-ID already exists in main under a DIFFERENT
 *                         sha (`git log -p | git patch-id` on both ranges) — cherry-pick/squash
 *                         duplication. Same computation CLASS as `land-pr.ts`'s
 *                         `transplantedCommitsReason`, reimplemented pure here (no daemon deps: no
 *                         `dal/storage`, no `gh`, no state dir) so replay never needs a live daemon.
 *   stale-fork-overlap    candidate forked behind main's current tip AND both sides touched the same
 *                         path(s) since divergence — the `staleBranchReason` class (`land.ts`),
 *                         reimplemented offline the same way.
 *
 * Every join is exact SHA/ref equality on a `path.resolve`d repo path (`computeRepositoryId`). No
 * LLM, no network, no worktree checkout — every detection is read-only `git` plumbing run in the
 * repo's OWN checkout. A detection whose git probe fails (bad ref, corrupt object, shallow clone,
 * ...) degrades to a coverage GAP for that one detection instead of throwing the whole analyzer's
 * `run()` — `plugin.ts#runAnalyzers` applies the same rule one level up, for a whole analyzer crash;
 * this file applies it one level down, per detection, so one bad probe never silences the other
 * three.
 *
 * `ExtractionCoverage.dimension` is fixed by SCHEMA-V0.md to `"syntax" | "resolution" | "type"` — all
 * three are named for the TypeScript structural-delta analyzer's extraction stages. Topology has no
 * TS dimension of its own, so it reports under `"syntax"`, read generically here as "did the raw
 * extraction (the git probe) succeed" — the closest fit the fixed enum offers, and the one dimension
 * every analyzer in this slice can report against uniformly.
 */

import { createHash } from "node:crypto";
import { computeRepositoryId } from "../id.ts";
import { CLAIMED_BY } from "../replay/incident-taxonomy.ts";
import type { AssessmentFinding, EntityLocator, EvidencePointer, ExtractionCoverage, ProducerRef, RepositoryStateRef, SnapshotFact } from "../schema.ts";
import { git, type AnalysisResult, type AnalyzerContext, type AssessmentAnalyzer } from "./plugin.ts";

export const TOPOLOGY_ANALYZER_VERSION = "0.1.0";

const PRODUCER: ProducerRef = { name: "topology", version: TOPOLOGY_ANALYZER_VERSION };

function stableId(...parts: string[]): string {
	return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 20);
}

/** `repo` is ALREADY `computeRepositoryId`-resolved by the time it reaches here (`run()` resolves it
 *  exactly once) — every helper below reuses that same string for both `git`'s `cwd` and every
 *  `repositoryId` field, so a differently-spelled path to the same checkout can never split one
 *  analyzer run's facts across two identities. */
async function stateRefFor(repo: string, commit: string): Promise<RepositoryStateRef> {
	const tree = await git(["rev-parse", `${commit}^{tree}`], repo);
	if (tree.code !== 0 || !tree.stdout) throw new Error(`topology: could not resolve tree for ${commit}: ${tree.stderr || tree.stdout || "no output"}`);
	return { repositoryId: repo, commit, tree: tree.stdout };
}

/** EntityLocator.path is documented as a file path, but a topology fact is about a COMMIT, not a
 *  file — there is no file path to give it. Reusing the resolved repo path here is the closest
 *  non-empty "where does this live" the schema's fixed shape accepts (`isEntityLocator` requires a
 *  non-empty `path`); `kind: "commit"` keeps the locator's meaning unambiguous at read time. */
function commitLocator(repo: string, sha: string): EntityLocator {
	return { qualifiedName: sha, path: repo, kind: "commit" };
}

function commitEvidence(repo: string, sha: string): EvidencePointer {
	return { kind: "commit", repositoryId: repo, commit: sha };
}

function coverageOk(): ExtractionCoverage {
	return { dimension: "syntax", covered: 1, total: 1, gaps: [] };
}

function coverageGap(reason: string): ExtractionCoverage {
	return { dimension: "syntax", covered: 0, total: 1, gaps: [{ reason }] };
}

/** One detection's output: zero-or-one finding (each detection either fires once, over the whole set
 *  of commits/paths it found, or stays silent), its supporting observations, and its own coverage —
 *  merged into the analyzer's aggregate `coverage` in `run()` below. */
interface DetectionOutcome {
	observations: SnapshotFact[];
	findings: AssessmentFinding[];
	coverage: ExtractionCoverage;
}

function silent(coverage: ExtractionCoverage): DetectionOutcome {
	return { observations: [], findings: [], coverage };
}

function nowIso(): string {
	return new Date().toISOString();
}

// ── stacked-base ─────────────────────────────────────────────────────────────────────────────────

async function detectStackedBase(repo: string, ctx: AnalyzerContext): Promise<DetectionOutcome> {
	const mbMain = await git(["merge-base", ctx.candidateCommit, ctx.mainCommit], repo);
	const mbBase = await git(["merge-base", ctx.candidateCommit, ctx.baseCommit], repo);
	if (mbMain.code !== 0 || mbBase.code !== 0) {
		return silent(coverageGap(`stacked-base: merge-base probe failed (${mbMain.stderr || mbBase.stderr || "no output"})`));
	}
	if (!mbMain.stdout || !mbBase.stdout || mbMain.stdout === mbBase.stdout) {
		return silent(coverageOk()); // fork point agrees with the declared base — not stacked-base
	}
	const candidateState = await stateRefFor(repo, ctx.candidateCommit);
	const factAgainstMain: SnapshotFact = {
		factId: stableId("topology", "FORKED_FROM", ctx.candidateCommit, mbMain.stdout, "main"),
		state: candidateState,
		subject: commitLocator(repo, ctx.candidateCommit),
		predicate: "FORKED_FROM",
		object: { kind: "string", value: mbMain.stdout },
		authority: "deterministic",
		observedAt: nowIso(),
		producer: PRODUCER,
		evidence: [commitEvidence(repo, mbMain.stdout)],
	};
	const factAgainstBase: SnapshotFact = {
		factId: stableId("topology", "FORKED_FROM", ctx.candidateCommit, mbBase.stdout, "base"),
		state: candidateState,
		subject: commitLocator(repo, ctx.candidateCommit),
		predicate: "FORKED_FROM",
		object: { kind: "string", value: mbBase.stdout },
		authority: "deterministic",
		observedAt: nowIso(),
		producer: PRODUCER,
		evidence: [commitEvidence(repo, mbBase.stdout)],
	};
	const finding: AssessmentFinding = {
		id: stableId("topology", "stacked-base", ctx.candidateCommit, mbMain.stdout, mbBase.stdout),
		kind: "topology.stacked-base",
		statement:
			`candidate ${ctx.candidateCommit} forks from ${mbBase.stdout} against its declared base but from ${mbMain.stdout} ` +
			`against current main@${ctx.mainCommit} — the wrong-base class (the declared base has diverged from main's own lineage)`,
		semantics: { authority: "deterministic", support: "supported", stateRole: "candidate", attemptDisposition: "pending" },
		coverage: coverageOk(),
		derivedFromObservations: [factAgainstMain.factId, factAgainstBase.factId],
		evidence: [commitEvidence(repo, mbMain.stdout), commitEvidence(repo, mbBase.stdout)],
		producer: PRODUCER,
	};
	return { observations: [factAgainstMain, factAgainstBase], findings: [finding], coverage: coverageOk() };
}

// ── orphaned-merge ───────────────────────────────────────────────────────────────────────────────

async function detectOrphanedMerge(repo: string, ctx: AnalyzerContext): Promise<DetectionOutcome> {
	const unreached = await git(["rev-list", ctx.candidateCommit, "--not", ctx.mainCommit], repo);
	if (unreached.code !== 0) {
		return silent(coverageGap(`orphaned-merge: rev-list probe failed (${unreached.stderr || "no output"})`));
	}
	if (!unreached.stdout) return silent(coverageOk()); // fully reachable from main — not orphaned
	const shas = unreached.stdout.split("\n").filter(Boolean);
	const candidateState = await stateRefFor(repo, ctx.candidateCommit);
	const observations: SnapshotFact[] = shas.map((sha) => ({
		factId: stableId("topology", "UNREACHABLE_FROM", sha, ctx.mainCommit),
		state: candidateState,
		subject: commitLocator(repo, sha),
		predicate: "UNREACHABLE_FROM",
		object: { kind: "string", value: `main@${ctx.mainCommit}` },
		authority: "deterministic",
		observedAt: nowIso(),
		producer: PRODUCER,
		evidence: [commitEvidence(repo, sha)],
	}));
	const shown = shas.slice(0, 5);
	const more = shas.length > shown.length ? ` (+${shas.length - shown.length} more)` : "";
	const finding: AssessmentFinding = {
		id: stableId("topology", "orphaned-merge", ctx.candidateCommit, ctx.mainCommit),
		kind: "topology.orphaned-merge",
		statement:
			`${shas.length} commit(s) reachable from candidate ${ctx.candidateCommit} are not reachable from main@${ctx.mainCommit}: ` +
			`${shown.join(", ")}${more} — the orphaned-merged-PR class`,
		semantics: { authority: "deterministic", support: "supported", stateRole: "candidate", attemptDisposition: "pending" },
		coverage: coverageOk(),
		derivedFromObservations: observations.map((o) => o.factId),
		evidence: observations.flatMap((o) => o.evidence),
		producer: PRODUCER,
	};
	return { observations, findings: [finding], coverage: coverageOk() };
}

// ── transplanted-lineage (patch-id duplicate) ───────────────────────────────────────────────────

interface PatchIdEntry {
	patchId: string;
	sha: string;
}

/** Parse `git patch-id` porcelain output: `<patch-id> <commit-sha>` per line. Pure, no I/O, never
 *  throws on a malformed line — mirrors `orphan-audit.ts#parseCherry`'s tolerance. */
function parsePatchIds(output: string): PatchIdEntry[] {
	const entries: PatchIdEntry[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const m = /^([0-9a-f]{40})\s+([0-9a-f]{7,40})\b/.exec(line);
		if (m) entries.push({ patchId: m[1]!, sha: m[2]! });
	}
	return entries;
}

async function detectTransplantedLineage(repo: string, ctx: AnalyzerContext): Promise<DetectionOutcome> {
	const candidateLog = await git(["log", "-p", "--no-color", `${ctx.baseCommit}..${ctx.candidateCommit}`], repo);
	if (candidateLog.code !== 0) return silent(coverageGap(`transplanted-lineage: git log -p (candidate range) failed (${candidateLog.stderr || "no output"})`));
	const mainLog = await git(["log", "-p", "--no-color", `${ctx.baseCommit}..${ctx.mainCommit}`], repo);
	if (mainLog.code !== 0) return silent(coverageGap(`transplanted-lineage: git log -p (main range) failed (${mainLog.stderr || "no output"})`));
	if (!candidateLog.stdout || !mainLog.stdout) return silent(coverageOk()); // nothing on one side to compare — no duplication possible

	const candidateIds = await git(["patch-id"], repo, { stdin: candidateLog.stdout });
	const mainIds = await git(["patch-id"], repo, { stdin: mainLog.stdout });
	if (candidateIds.code !== 0 || mainIds.code !== 0) {
		return silent(coverageGap(`transplanted-lineage: git patch-id failed (${candidateIds.stderr || mainIds.stderr || "no output"})`));
	}

	const mainByPatchId = new Map(parsePatchIds(mainIds.stdout).map((e) => [e.patchId, e.sha]));
	const duplicates = parsePatchIds(candidateIds.stdout).filter((e) => {
		const mainSha = mainByPatchId.get(e.patchId);
		return mainSha !== undefined && mainSha !== e.sha;
	});
	if (duplicates.length === 0) return silent(coverageOk());

	const candidateState = await stateRefFor(repo, ctx.candidateCommit);
	const observations: SnapshotFact[] = duplicates.map((d) => {
		const mainSha = mainByPatchId.get(d.patchId)!;
		return {
			factId: stableId("topology", "PATCH_ID_DUPLICATE_OF", d.sha, mainSha),
			state: candidateState,
			subject: commitLocator(repo, d.sha),
			predicate: "PATCH_ID_DUPLICATE_OF",
			object: { kind: "string", value: mainSha },
			authority: "deterministic",
			observedAt: nowIso(),
			producer: PRODUCER,
			evidence: [commitEvidence(repo, d.sha), commitEvidence(repo, mainSha)],
		} satisfies SnapshotFact;
	});
	const shown = duplicates.slice(0, 5).map((d) => `${d.sha.slice(0, 8)}→${mainByPatchId.get(d.patchId)!.slice(0, 8)}`);
	const more = duplicates.length > shown.length ? ` (+${duplicates.length - shown.length} more)` : "";
	const finding: AssessmentFinding = {
		id: stableId("topology", "transplanted-lineage", ctx.candidateCommit, ctx.mainCommit),
		kind: "topology.transplanted-lineage",
		statement:
			`${duplicates.length} candidate commit(s) share a patch-id with a DIFFERENT sha already in main: ${shown.join(", ")}${more} ` +
			`— cherry-pick/squash duplication`,
		semantics: { authority: "deterministic", support: "supported", stateRole: "candidate", attemptDisposition: "pending" },
		coverage: coverageOk(),
		derivedFromObservations: observations.map((o) => o.factId),
		evidence: observations.flatMap((o) => o.evidence),
		producer: PRODUCER,
	};
	return { observations, findings: [finding], coverage: coverageOk() };
}

// ── stale-fork-overlap ───────────────────────────────────────────────────────────────────────────

const OVERLAP_LIST_CAP = 8;

async function detectStaleForkOverlap(repo: string, ctx: AnalyzerContext): Promise<DetectionOutcome> {
	const mb = await git(["merge-base", ctx.candidateCommit, ctx.mainCommit], repo);
	if (mb.code !== 0) return silent(coverageGap(`stale-fork-overlap: merge-base probe failed (${mb.stderr || "no output"})`));
	if (!mb.stdout || mb.stdout === ctx.mainCommit) return silent(coverageOk()); // fork point IS main's tip — fresh
	const mainDiff = await git(["diff", "--name-only", mb.stdout, ctx.mainCommit], repo);
	const candidateDiff = await git(["diff", "--name-only", mb.stdout, ctx.candidateCommit], repo);
	if (mainDiff.code !== 0 || candidateDiff.code !== 0) {
		return silent(coverageGap(`stale-fork-overlap: diff probe failed (${mainDiff.stderr || candidateDiff.stderr || "no output"})`));
	}
	const mainFiles = new Set(mainDiff.stdout.split("\n").filter(Boolean));
	const overlap = candidateDiff.stdout.split("\n").filter((f) => f && mainFiles.has(f));
	if (overlap.length === 0) return silent(coverageOk());

	const candidateState = await stateRefFor(repo, ctx.candidateCommit);
	const observations: SnapshotFact[] = overlap.map((p) => ({
		factId: stableId("topology", "OVERLAPS_MAIN_EDIT_OF", ctx.candidateCommit, ctx.mainCommit, p),
		state: candidateState,
		subject: { qualifiedName: ctx.candidateCommit, path: p, kind: "commit" },
		predicate: "OVERLAPS_MAIN_EDIT_OF",
		object: { kind: "string", value: `main@${ctx.mainCommit}` },
		authority: "deterministic",
		observedAt: nowIso(),
		producer: PRODUCER,
		evidence: [commitEvidence(repo, ctx.mainCommit)],
	}));
	const shown = overlap.slice(0, OVERLAP_LIST_CAP);
	const more = overlap.length > shown.length ? ` (+${overlap.length - shown.length} more)` : "";
	const finding: AssessmentFinding = {
		id: stableId("topology", "stale-fork-overlap", ctx.candidateCommit, ctx.mainCommit, mb.stdout),
		kind: "topology.stale-fork-overlap",
		statement:
			`candidate ${ctx.candidateCommit} forked from ${mb.stdout}, behind main@${ctx.mainCommit}, and both sides edited ` +
			`${overlap.length} of the same path(s): ${shown.join(", ")}${more} — the stale-branch class`,
		semantics: { authority: "deterministic", support: "supported", stateRole: "candidate", attemptDisposition: "pending" },
		coverage: coverageOk(),
		derivedFromObservations: observations.map((o) => o.factId),
		evidence: [commitEvidence(repo, mb.stdout), commitEvidence(repo, ctx.mainCommit)],
		producer: PRODUCER,
	};
	return { observations, findings: [finding], coverage: coverageOk() };
}

// ── the analyzer ─────────────────────────────────────────────────────────────────────────────────

export const topologyAnalyzer: AssessmentAnalyzer = {
	name: "topology",
	version: TOPOLOGY_ANALYZER_VERSION,
	claimedClasses: CLAIMED_BY.topology,

	// Always applicable given a well-formed context — topology has no language/file-type precondition
	// (unlike the structural-delta analyzer, which only applies when changed files are TypeScript).
	applicable(ctx: AnalyzerContext): boolean {
		return Boolean(ctx.repo && ctx.baseCommit && ctx.mainCommit && ctx.candidateCommit);
	},

	async run(ctx: AnalyzerContext): Promise<AnalysisResult> {
		const repo = computeRepositoryId(ctx.repo);
		const resolvedCtx: AnalyzerContext = { ...ctx, repo };
		const outcomes = await Promise.all([
			detectStackedBase(repo, resolvedCtx),
			detectOrphanedMerge(repo, resolvedCtx),
			detectTransplantedLineage(repo, resolvedCtx),
			detectStaleForkOverlap(repo, resolvedCtx),
		]);
		const observations = outcomes.flatMap((o) => o.observations).sort((a, b) => a.factId.localeCompare(b.factId));
		const findings = outcomes.flatMap((o) => o.findings).sort((a, b) => a.id.localeCompare(b.id));
		const covered = outcomes.reduce((n, o) => n + o.coverage.covered, 0);
		const total = outcomes.reduce((n, o) => n + o.coverage.total, 0);
		const gaps = outcomes.flatMap((o) => o.coverage.gaps);
		return { observations, findings, coverage: [{ dimension: "syntax", covered, total, gaps }] };
	},
};
