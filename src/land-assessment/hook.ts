/**
 * Observe-only land hook (concern 08, `plans/land-assessment/08-observe-only-land-hook.md`) — the
 * Phase-2 wiring that records a `LandAttemptEvent` for EVERY land attempt, EVERY rejection, and EVERY
 * landed terminal, while remaining observe-only BY CONSTRUCTION: the manager calls every method here
 * fire-and-forget (`void`), and every method is internally try/caught, so nothing on this path can throw
 * into a land, change a land decision, alter a return value, or add blocking I/O beyond the sub-second
 * SHA reads `beginAttempt` does. When in doubt this module records LESS and stays invisible rather than
 * risk influencing a land — the invariant that gates the whole concern.
 *
 * `attemptId` is minted exactly ONCE per land, in `beginAttempt`, before any of `land()`'s early
 * returns; `SquadManager.land()` threads that id to the terminal recording and `autoLandWorkflow` never
 * mints its own (it only calls `land()`), so an auto-land emits exactly one `attempt-started`.
 *
 * Because every call is fire-and-forget, the analyzer assessment ALWAYS runs in the background and can
 * never block the land regardless of how long it takes — so the concern's "race a 10s budget then
 * background" is unnecessary here (it is always backgrounded). The candidate commit is pinned under
 * `refs/land-assessment/<attemptId>/<sha>` for the duration of that background analysis so a concurrent
 * rebase / branch delete / gc can't prune the subject mid-run; the ref is dropped in `finally`.
 */

import { createHash } from "node:crypto";
import { errText } from "../err-text.ts";
import { git, runAnalyzers, type AnalyzerContext } from "./analyzers/plugin.ts";
import { topologyAnalyzer } from "./analyzers/topology.ts";
import { structuralDeltaAnalyzer, structuralDeltaEnvironmentFingerprint } from "./analyzers/typescript-structural-delta.ts";
import { repairContinuity } from "./continuity.ts";
import { computeAssessmentKey, computeEventId, computeOutputHash, computeRepositoryId, mintAttemptId } from "./id.ts";
import { writeObservationBatch } from "./replay/synthetic-timeline.ts";
import { SCHEMA_VERSION, type EvidencePointer, type LandAttemptEvent, type LandAttemptStage, type ProducerRef, type RepositoryStateRef } from "./schema.ts";
import { appendLandAssessmentSnapshot, appendLandAttemptEvent } from "./store.ts";

const HOOK_PRODUCER: ProducerRef = { name: "land-assessment-hook", version: "0.1.0" };

type Logger = (level: "info" | "warn", msg: string) => void;

interface AppendSpec {
	attemptId: string;
	repositoryId: string;
	stage: LandAttemptStage;
	assessmentKey?: string;
	previousAssessmentKey?: string;
	resultCommit?: string;
	resultTree?: string;
	reason?: { code: string; detail: string };
	candidateCommit?: string;
}

export class LandAssessmentHook {
	private readonly seqByAttempt = new Map<string, number>();

	constructor(
		private readonly stateDir: string,
		private readonly log: Logger = () => {},
	) {}

	/** Mint the attempt id, record `attempt-started`, and fire off the background analysis. Returns the
	 *  minted id, or `undefined` if anything failed — in which case the caller records nothing further and
	 *  the land proceeds completely untouched. NEVER throws; the SHA reads are the only synchronous cost. */
	async beginAttempt(repo: string, branch: string | undefined): Promise<string | undefined> {
		try {
			if (!branch) return undefined; // a branchless unit has no candidate to assess
			const candidate = await this.stateRef(repo, branch);
			if (!candidate) return undefined;
			const attemptId = mintAttemptId(this.stateDir, repo, branch, candidate.commit);
			await this.append({ attemptId, repositoryId: candidate.repositoryId, stage: "attempt-started", candidateCommit: candidate.commit });
			void this.assess(attemptId, repo, branch, candidate); // background; never awaited on the land path
			return attemptId;
		} catch (err) {
			this.log("warn", `land-assessment beginAttempt failed (assessment skipped, land unaffected): ${errText(err)}`);
			return undefined;
		}
	}

	/** Record a `rejected` terminal with its reason code. No-op when `attemptId` is undefined (the mint
	 *  failed) so the caller never has to branch on it. */
	async recordRejection(attemptId: string | undefined, repo: string, code: string, detail: string): Promise<void> {
		if (!attemptId) return;
		try {
			await this.append({ attemptId, repositoryId: computeRepositoryId(repo), stage: "rejected", reason: { code, detail } });
		} catch (err) {
			this.log("warn", `land-assessment recordRejection failed: ${errText(err)}`);
		}
	}

	/** Record a `landed` terminal carrying the landed result R (`resultCommit`/`resultTree`, the C→R
	 *  transition), and trigger concern-11 accepted-state extraction from R (fire-and-forget). R is read
	 *  from the repo's post-merge `HEAD` — accurate for local-mode lands (the daemon's checkout sits on
	 *  main, so after the merge HEAD IS the landed result). In PR mode the local main may lag the GitHub
	 *  merge, so R can be stale/absent there; recorded best-effort, never blocking (observe-only). */
	async recordLanded(attemptId: string | undefined, repo: string): Promise<void> {
		if (!attemptId) return;
		try {
			const r = await this.stateRef(repo, "HEAD");
			const repositoryId = r?.repositoryId ?? computeRepositoryId(repo);
			await this.append({ attemptId, repositoryId, stage: "landed", resultCommit: r?.commit, resultTree: r?.tree });
			if (r) void this.extractAccepted(repo, r);
		} catch (err) {
			this.log("warn", `land-assessment recordLanded failed: ${errText(err)}`);
		}
	}

	// ── internals (all guarded; never throw to a caller) ──────────────────────────────────────────────

	/** Concern 11: extract the accepted-state manifest from the landed result R (C≠R — accepted state
	 *  comes from what actually landed, never the candidate). Fire-and-forget off the land path. */
	private async extractAccepted(repo: string, r: RepositoryStateRef): Promise<void> {
		try {
			await repairContinuity(this.stateDir, repo, r, HOOK_PRODUCER);
		} catch (err) {
			this.log("warn", `land-assessment accepted-state extraction failed for ${r.commit}: ${errText(err)}`);
		}
	}

	/** Run the analyzers against (base, main, candidate) and append a content-addressed snapshot +
	 *  `assessment-attached` event. Pins the candidate so a mid-analysis rebase/gc can't prune it. */
	private async assess(attemptId: string, repo: string, branch: string, candidate: RepositoryStateRef): Promise<void> {
		const pin = `refs/land-assessment/${attemptId}/${candidate.commit}`;
		try {
			await git(["update-ref", pin, candidate.commit], repo).catch(() => undefined);
			// Single-daemon model: the land merges the candidate branch INTO the daemon's own checkout, which
			// sits on the main branch — so HEAD is main and base is their merge-base. A resolution failure
			// degrades to an analyzer coverage gap (runAnalyzers turns a bad context into gaps, never a throw).
			const mainCommit = (await git(["rev-parse", "HEAD"], repo)).stdout;
			const baseCommit = (await git(["merge-base", candidate.commit, "HEAD"], repo)).stdout || mainCommit;
			const ctx: AnalyzerContext = { repo, baseCommit, mainCommit, candidateCommit: candidate.commit };
			const result = await runAnalyzers([topologyAnalyzer, structuralDeltaAnalyzer], ctx);

			const base = await this.stateRefFor(repo, baseCommit);
			const target = await this.stateRefFor(repo, mainCommit);
			const environment = structuralDeltaEnvironmentFingerprint();
			const assessmentKey = computeAssessmentKey({ base, target, candidate }, environment);
			const batchRef = await writeObservationBatch(this.stateDir, candidate.repositoryId, { facts: result.observations, changes: [], findings: result.findings });
			const outputHash = computeOutputHash(result.observations, result.findings);
			const analysisRunId = createHash("sha1").update(`${assessmentKey}\0run`).digest("hex").slice(0, 20);
			await appendLandAssessmentSnapshot(this.stateDir, {
				schemaVersion: SCHEMA_VERSION,
				assessmentKey,
				analysisRunId,
				state: { base, target, candidate },
				environment,
				observationBatchRefs: [batchRef],
				findingRefs: result.findings.map((f) => f.id),
				coverage: result.coverage,
				outputHash,
				createdAt: new Date().toISOString(),
			});
			await this.append({ attemptId, repositoryId: candidate.repositoryId, stage: "assessment-attached", assessmentKey, candidateCommit: candidate.commit });
		} catch (err) {
			this.log("warn", `land-assessment analysis failed for ${attemptId} (land unaffected): ${errText(err)}`);
		} finally {
			await git(["update-ref", "-d", pin], repo).catch(() => undefined);
		}
	}

	private nextSeq(attemptId: string): number {
		const n = (this.seqByAttempt.get(attemptId) ?? -1) + 1;
		this.seqByAttempt.set(attemptId, n);
		return n;
	}

	private async append(spec: AppendSpec): Promise<void> {
		const seq = this.nextSeq(spec.attemptId);
		const evidence: EvidencePointer[] = spec.candidateCommit
			? [{ kind: "commit", repositoryId: spec.repositoryId, commit: spec.candidateCommit }]
			: [];
		const event: LandAttemptEvent = {
			schemaVersion: SCHEMA_VERSION,
			eventId: computeEventId(spec.attemptId, seq),
			attemptId: spec.attemptId,
			repositoryId: spec.repositoryId,
			seq,
			stage: spec.stage,
			...(spec.assessmentKey ? { assessmentKey: spec.assessmentKey } : {}),
			...(spec.previousAssessmentKey ? { previousAssessmentKey: spec.previousAssessmentKey } : {}),
			...(spec.resultCommit ? { resultCommit: spec.resultCommit } : {}),
			...(spec.resultTree ? { resultTree: spec.resultTree } : {}),
			...(spec.reason ? { reason: spec.reason } : {}),
			refs: {},
			criteria: { declaredCriterionRefs: [], impactStatus: "not-evaluated" },
			observedAt: new Date().toISOString(),
			evidence,
		};
		await appendLandAttemptEvent(this.stateDir, event); // store surfaces an I/O failure as "write-failed", not a throw
	}

	private async stateRef(repo: string, ref: string): Promise<RepositoryStateRef | undefined> {
		const c = await git(["rev-parse", ref], repo);
		if (c.code !== 0 || !c.stdout) return undefined;
		return this.stateRefFor(repo, c.stdout);
	}

	private async stateRefFor(repo: string, commit: string): Promise<RepositoryStateRef> {
		const tree = (await git(["rev-parse", `${commit}^{tree}`], repo)).stdout;
		return { commit, tree, repositoryId: computeRepositoryId(repo) };
	}
}
