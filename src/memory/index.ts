/**
 * The long-horizon agent-memory lane — one seam for the whole lane.
 *
 * This barrel is the lane's INTERFACE: everything a caller outside src/memory/ may use.
 * Modules inside the directory are implementation; importing them directly from outside
 * the lane is frozen by tests/memory-lane-boundary.test.ts (existing deep importers are
 * pinned as an allowlist — new couplings must come through here, so the lane can reshape
 * its internals without a repo-wide sweep).
 *
 * The lane's shape (plans/research-long-horizon-agent-memory/POSITION.md):
 *   - a ledger with regenerated projections — decisions are appended, superseded
 *     (invalidated-never-deleted), and projected; superseded facts are EXCLUDED from the
 *     active set, not annotated (compliance trap, arXiv 2607.10608);
 *   - fabric/fabric-search build the read-side projection + context primer;
 *   - symptoms / after-action / episodes / answers / digests are the teaching surfaces;
 *   - nodes / node-records are the work-graph substrate the ledger anchors to.
 */

// ── the decision ledger: the lane's single write path ───────────────────────────
export { DecisionLedger, normalizeSupersedesRef, sanitizePatchDecisions } from "./decision-ledger.ts";
export type { DecisionLedgerStore, RecordDecisionOutcome, CaptureDecisionInput, CaptureDecisionResult, FeatureDecision } from "./decision-ledger.ts";

// ── reviewer-ensemble weights: measured per-lineage precision (Weaver-lite) ─────
export {
	MIN_FINDINGS_FOR_WEIGHT, parseReviewerLedger, renderReviewerReport, reviewerPrecision,
	DEFAULT_REVIEWER_LEDGER_PATH, DEFAULT_REVIEWER_LEDGER_REPO, reviewerPrecisionFor, readReviewerLedgerEntries,
	reviewerPrecisionFromLedger, renderReviewerPrecision, appendReviewerLedgerEntry, semanticKey,
} from "./reviewer-weights.ts";
export type { ReviewerLineage, ReviewerLedgerEntry, LineagePrecision, ReviewerPrecisionStamp } from "./reviewer-weights.ts";

// ── decisions: evidence gate + reversal/cost impact ─────────────────────────────
export { evidenceFilePath, validateModelDelta } from "./decision-evidence.ts";
export type { EvidenceRejection, EvidenceAccepted, EvidenceValidation } from "./decision-evidence.ts";
export { assessReversal, summariseCost, shouldDiscloseCost, costEventsFrom } from "./decision-impact.ts";
export type { ReversalNode, ReversalAssessment, CostEvent, CostSummary } from "./decision-impact.ts";

// ── projection: fabric snapshot + lexical search + context primer ───────────────
export { hotAreasFromReceipts, loadScoutFacts, loadFailureFacts, actorVisibleRepoSet, buildFabricSnapshot } from "./fabric.ts";
export type {
	FactSource, FabricAgentFact, FabricDigestFact, FabricHotAreaFact, FabricScoutFact,
	FabricLeaseFact, FabricDecisionFact, FabricFailureFact, FabricSymptomFact,
	FabricEpisodeFact, FabricAnswerFact, FabricSnapshot, FabricDeps,
} from "./fabric.ts";
export { tokenize, fabricDocuments, rankKbDocs, searchFabric, classifyQueryShape, PRIMER_BUDGET, buildContextPrimer } from "./fabric-search.ts";
export type { KbDocType, KbDoc, FabricSearchResult } from "./fabric-search.ts";

// ── teaching surfaces: failures, symptoms, after-action, episodes, answers, digests ─
export { readFailureAnnotations, recordFailureAnnotation, failureAnnotation } from "./failure-memory.ts";
export type { FailureAnnotation, FailureStore } from "./failure-memory.ts";
export {
	isoWeekKey, symptomId, readSymptom, listSymptoms, saveSymptom, validateSymptomText,
	validateWhereToLookCount, classifyWhereToLookEntry, statWhereToLookEntry,
	groupSymptomHits, formatWhereToLookEntry,
	MIN_SYMPTOM_LEN, MIN_WHERE_TO_LOOK, MAX_WHERE_TO_LOOK, MAX_SYMPTOM_LEN, MAX_WHERE_TO_LOOK_ENTRY_LEN,
} from "./symptoms.ts";
export type { SymptomEntry, SymptomRejection, SymptomAccepted, SymptomValidation, WhereToLookStat, SymptomSearchHit, SymptomGroup } from "./symptoms.ts";
export { AFTER_ACTION_MARKER, composeAfterAction, readAfterAction, listAfterActions, saveAfterAction, selectTerminalReaps } from "./after-action.ts";
export type { AfterActionReport, AfterActionInput, TerminalReapCandidate } from "./after-action.ts";
export {
	EPISODE_SCHEMA_VERSION, isoWeekBounds, previousCompleteIsoWeek, buildEpisode,
	episodeRepoHash, episodeContentHash, episodeSourceFingerprint, gatherEpisode, saveEpisode, readEpisode, listEpisodes, EpisodeLoop,
} from "./weekly-episode.ts";
export type { OmittedEntry, StaleAnswerEntry, BuildEpisodeInput, EpisodeMeta, BuiltEpisode, EpisodeGatherResult, EpisodeLoopDeps, EpisodeSources, SourceRead } from "./weekly-episode.ts";
export { readAnswer, listAnswers, saveAnswer, extractPathTokens, possiblyStale, answerBrief } from "./answers.ts";
export type { Answer } from "./answers.ts";
export {
	formatRewardTag, parseDigestReward, rewardWeight, buildDigest, digestSummaryExcerpt,
	digestPath, writeDigest, readDigest, neutralizeDelimiters, fenceUntrusted, authoredSpecBlock,
} from "./digest.ts";
export type { DigestReward, DigestInput } from "./digest.ts";

// ── work-graph substrate: nodes + typed node records ────────────────────────────
export { ACTIVITY_HALF_LIFE_MS, compareActivity, NodeStore } from "./nodes.ts";
export type { NodeKind, NodeState, ActivityRankCandidate, Node, CreateNodeInput } from "./nodes.ts";
export { quoteRule, nodeRecordKinds, readNodeRecord, NodeRecordStore } from "./node-records.ts";
export type {
	RuleDisagreement, RuleRecord, DelegationBoundaryRecord, InstructionReadbackRecord,
	ObjectionRecord, PlanMotionRecord, EvidenceRecord, AgentProfileRecord, DecisionRecord,
	HumanAuthorityRecord, HandoverRecord, RetentionRecord, NodeSummaryRecord,
	LearningStateRecord, NodeRecord,
} from "./node-records.ts";
export { regenerateNodeSummaries } from "./node-summaries.ts";
export type { NodeSummaryReferences, NodeSummaryInput } from "./node-summaries.ts";
