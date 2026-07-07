/**
 * Drift audit — the JUDGE-confirmation + durable record half of Sentinel v0
 * (plans/sentinel-drift-probe). Sibling to src/drift-lens.ts's action-free MONITOR: this module is
 * where the independent judge is ALLOWED to run (`validator.ts`'s `scoreAgainstCriteria`, the same
 * computation `convergence-run.ts`'s `realValidate` already does), and where the confirmed result is
 * persisted. The monitor never imports this file or validator.ts directly — only the manager-side
 * sink (wired in concern 02) calls `confirmDrift`.
 *
 * `confirmDrift` is the JUDGE path: it re-checks the run's liveness (the runId turnover guard) both
 * BEFORE the judge call and again before the write, because the sweep that produced the hypothesis
 * can outlast `finalizeRun` tearing the run down (DESIGN.md's "Sweep-vs-finalizeRun race"). `abstain`
 * (thin/empty diff) and `skipped` (no criteria) are RECORDED verdicts, not errors — they are the
 * honest "could not confirm yet" labels the v0 precision measurement needs.
 */

import { appendFileSync } from "node:fs";
import * as path from "node:path";
import { type Judge, scoreAgainstCriteria } from "./validator.ts";
import type { DriftKind, DriftSeverity, Hypothesis } from "./drift-lens.ts";
import type { FeatureCriterion, ValidationRecord } from "./types.ts";

/** One judge-confirmed (or judge-abstained/skipped) drift record — the durable, off-Plane audit line. */
export interface DriftAuditEntry {
	runId?: string;
	agent: string;
	kind: DriftKind;
	severity: DriftSeverity;
	evidence: string;
	rationale: string;
	judgeVerdict: ValidationRecord["verdict"];
	agreement: number;
	ts: number;
}

/** Append-only sentinel audit log path — mirrors receipts.ts's `receipts/*.jsonl` and
 *  automation-log.ts's `automation.jsonl`. Lives off the run record so it survives `finalizeRun`'s
 *  teardown (`rec.run = undefined`). */
export function driftAuditPath(stateDir: string): string {
	return path.join(stateDir, "sentinel-audit.jsonl");
}

/** Append one entry as a JSON line. Best-effort, never throws — log-and-swallow like scout.ts's saveSeen. */
export function appendDriftAudit(stateDir: string, entry: DriftAuditEntry, log: (msg: string) => void = () => {}): void {
	try {
		appendFileSync(driftAuditPath(stateDir), `${JSON.stringify(entry)}\n`);
	} catch (e) {
		log(`drift audit persist failed (contained): ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Injected deps for one judge-confirmation — headless-testable, no daemon. */
export interface ConfirmDeps {
	hypothesis: Hypothesis;
	criteria: FeatureCriterion[];
	/** Working-tree diff, injected (concern 02 supplies e.g. gitDiffAgainstHead(worktree)). */
	diff: () => Promise<string>;
	/** Injected judge override — undefined ⇒ scoreAgainstCriteria's own default (independent) judge. */
	judge?: Judge;
	/** runId turnover guard — false ⇒ the run already turned over; abort without judging or writing. */
	stillLive: () => boolean;
	stateDir: string;
	/** Clock seam (defaults to Date.now). */
	now?: () => number;
	/** Log sink (defaults to no-op). */
	log?: (msg: string) => void;
}

/**
 * Confirm a hypothesis against the DECLARED criteria via the independent judge, then append the
 * result to the durable audit log. Never throws (`scoreAgainstCriteria` itself never throws; a
 * throwing `diff()` degrades to an empty diff, which the judge treats as `"abstain"`).
 *
 * Race guard (DESIGN.md "Sweep-vs-finalizeRun race"): checks `stillLive()` BEFORE the judge call
 * (skip the spend entirely on a dead run) and again BEFORE the write (a run can turn over while the
 * judge is in flight) — both a no-op return null, writing nothing.
 */
export async function confirmDrift(deps: ConfirmDeps): Promise<DriftAuditEntry | null> {
	const log = deps.log ?? (() => {});
	const now = deps.now ?? Date.now;

	if (!deps.stillLive()) {
		log(`drift confirm aborted — run turned over before the judge ran (agent=${deps.hypothesis.agent})`);
		return null;
	}

	let diffText = "";
	try {
		diffText = await deps.diff();
	} catch (e) {
		log(`drift confirm: diff() failed (contained, treated as empty): ${e instanceof Error ? e.message : String(e)}`);
	}

	const record = await scoreAgainstCriteria(deps.criteria, diffText, undefined, deps.judge);

	if (!deps.stillLive()) {
		log(`drift confirm aborted — run turned over after the judge, before the write (agent=${deps.hypothesis.agent})`);
		return null;
	}

	const entry: DriftAuditEntry = {
		runId: deps.hypothesis.runId,
		agent: deps.hypothesis.agent,
		kind: deps.hypothesis.kind,
		severity: deps.hypothesis.severity,
		evidence: deps.hypothesis.evidence,
		rationale: deps.hypothesis.rationale,
		judgeVerdict: record.verdict,
		agreement: record.agreement,
		ts: now(),
	};
	appendDriftAudit(deps.stateDir, entry, log);
	return entry;
}
