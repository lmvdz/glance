/**
 * Observer — periodic fleet self-audit loop (OMPSQ-52), sibling to the Orchestrator.
 *
 * Where the Orchestrator DRIVES work (spawn → verify → land), the Observer CONFIRMS the
 * fleet/project is in the intended state and, on a detected gap, FILES a fix-issue or
 * reopens a false-Done source issue for the existing Dispatcher to pick up — closing
 * observe → fix → confirm. It never modifies the orchestrator/dispatcher; it only files
 * issues, reopens false-Dones, and (opt-in) reaps a landed survivor.
 *
 * Strictly opt-in like the orchestrator: `start()` arms no timer and `tick()` is inert
 * unless OMP_SQUAD_OBSERVE !== "0" (on by default; =0 disables). Every effect goes through
 * injected `deps`, so the whole loop unit-tests headless with fakes — no live daemon.
 *
 * Per tick: run each AUDIT CHECK → each yields findings. A NEW finding (fingerprint unseen)
 * is filed as a Plane issue; the fingerprint is persisted to <stateDir>/observer-seen.json so
 * the same gap is never re-filed across ticks/restarts. A previously-filed finding that no
 * longer reproduces this tick is confirmed RESOLVED → its fingerprint is cleared.
 *
 * SAFETY (prevents a runaway observe → file loop):
 *  - Dedup by fingerprint (never re-file the same finding).
 *  - Hard cap on observer-filed OPEN issues: OMP_SQUAD_OBSERVE_MAX (default 10) — past it, log+skip.
 *  - Findings DEFAULT to needs-triage: filed with a do-not-auto-land marker so the dispatcher's
 *    `noAutoDispatch` gate skips them (no unsupervised auto-dispatch to the yolo fleet).
 *    OMP_SQUAD_OBSERVE_AUTODISPATCH=1 files plain (non-structural, non-autofix) findings WITHOUT
 *    the marker so the auto-dispatch loop consumes them. structural/security ⇒ ALWAYS needs-triage.
 *  - autoFixable findings (e.g. reap-survivor) are actioned directly only under
 *    OMP_SQUAD_OBSERVE_AUTOFIX=1 (default off); NEVER for anything touching main/code.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { envInt } from "./config.ts";
import * as path from "node:path";
import type { AutomationRecorder } from "./automation-log.ts";
import type { ComplianceFinding } from "./compliance.ts";
import { getDoneProofByBranch, proofCoversTip } from "./done-proof.ts";
import type { LandLedger } from "./land-ledger.ts";
import type { AgentDTO, AutomationSkipReason, IssueRef } from "./types.ts";

export type Severity = "low" | "high" | "structural";

/** One detected gap. `fingerprint` is the stable dedup key; `title` is the issue name (no markers). */
export interface Finding {
	fingerprint: string;
	title: string;
	detail?: string;
	severity: Severity;
	/** True when the loop can repair this directly (under OMP_SQUAD_OBSERVE_AUTOFIX=1) instead of filing. */
	autoFixable?: boolean;
	/** The direct repair for an autoFixable finding. MUST never touch main/code (reap-survivor only). */
	fix?: () => Promise<void>;
	/** Reopen this Done issue instead of filing a new observer issue (false-done self-heal). */
	reopenIssue?: IssueRef;
}

/** External edges the loop audits/acts through — all injected so the loop runs without a live daemon. */
export interface ObserverDeps {
	/** Current roster snapshot the checks reason over. */
	listAgents: () => AgentDTO[];
	/** Open Plane issues for the observed repo; `null` ⇒ Plane not configured / unreachable. */
	listIssues: () => Promise<IssueRef[] | null>;
	/** File a finding as a Plane issue → its ref; `null` ⇒ not configured / failed. */
	fileIssue: (title: string) => Promise<IssueRef | null>;
	/** Close a now-resolved observer issue (self-healing). Optional — absent ⇒ resolved issues are only cleared from the seen-map, not closed. */
	closeIssue?: (ref: IssueRef) => Promise<boolean>;
	/** Reopen a false-Done issue to Todo so the dispatcher re-runs the original work. */
	reopenIssue?: (ref: IssueRef) => Promise<boolean>;
	/** Reap a landed-survivor agent (the only autofix; never touches main/code). */
	removeAgent: (id: string) => Promise<void>;
	/** Spawn an observing agent to reproduce a confirmed regression in its own worktree, instead of
	 *  only filing an issue. Absent ⇒ regressions are only filed (today's behavior). Only ever called
	 *  for a `regression:`-fingerprinted finding, and only under OMP_SQUAD_OBSERVE_REPRODUCE=1. */
	spawnObserver?: (finding: Finding) => Promise<boolean>;
	/** Run the acceptance gate (the repo's own verify command) on main; `ok:false` ⇒ red. */
	runGate: () => Promise<{ ok: boolean; firstFailure?: string; skipped?: boolean }>;
	/** Commits on the agent's branch not in main (origin-aware in PR mode — see `aheadOfBase`):
	 *  0 ⇒ landed; >0 ⇒ unlanded; <0 ⇒ unknown. Async: PR mode fetches the origin default branch. */
	gitAheadOfMain: (agent: AgentDTO) => Promise<number>;
	/** Untracked file paths in the main checkout. */
	untrackedInMain: () => string[];
	/** Tracked files on an agent's branch (for the untracked-collision check); `[]` when no branch. */
	filesOnAgentBranch: (agent: AgentDTO) => string[];
	/** Uncommitted files in an agent worktree; absent keeps the check disabled for old tests/embedders. */
	uncommittedInWorktree?: (agent: AgentDTO) => string[];
	/** Branch → auto-land failure streak (the persisted ledger). Absent ⇒ the land-failure check is
	 *  skipped — keeps the loop usable in tests / before any land. */
	landLedger?: () => LandLedger;
	/** Learning-loop baseline (agentic-learning-loop concern 01): how many branches are CURRENTLY over
	 *  the land-failure-streak cap this tick (0 when none). Fired every tick the landLedger check runs,
	 *  so "land-failure-streak frequency" is measurable even when nothing is filed (e.g. already-open). */
	recordLandFailureStreak?: (count: number) => void;
	/** Recurring-failure memory (concern 05, downscoped): annotate a land-failure streak's root cause
	 *  ONCE per fingerprint (the callee is responsible for its own idempotency — a fingerprint already
	 *  annotated is a no-op) so a later cold-start on the same branch can warn the next agent. Absent
	 *  ⇒ disabled (no annotation, matches OMP_SQUAD_FAILURE_MEMORY default off). */
	annotateFailure?: (finding: Finding, branch: string) => Promise<void>;
	/** Epic 3's compliance evaluator (src/compliance.ts) — real policy findings (forced lands,
	 *  overridden validator vetoes, repeatedly-failing branches) fed into the SAME observe → file →
	 *  confirm loop as the structural checks below. Absent ⇒ disabled — keeps old tests/embedders green. */
	complianceFindings?: () => Promise<ComplianceFinding[]>;
	/** Where to persist seen fingerprints. */
	stateDir: string;
	/** Seen-map filename within stateDir (default "observer-seen.json"). Per-repo observers pass distinct
	 *  names so multi-repo audits don't share one dedup map. */
	seenFile?: string;
	/** Clock seam (defaults to Date.now). */
	now?: () => number;
	/** Log sink (defaults to no-op). */
	log?: (msg: string) => void;
	/** Observability sink — one report per tick (a clean audit is a heartbeat proving the loop is alive). */
	record?: AutomationRecorder;
}

/** Marks an observer-filed issue so the cap can count its own OPEN issues without touching others. */
const OBSERVER_TAG = "[observer]";
/** Embedded in needs-triage titles so the dispatcher's `noAutoDispatchName` gate skips them. */
const TRIAGE_MARKER = "do-not-auto-land";

/** On by default; set OMP_SQUAD_OBSERVE=0 to disable the self-audit loop. */
function observeEnabled(): boolean {
	return process.env.OMP_SQUAD_OBSERVE !== "0";
}
/** Hard cap on observer-filed OPEN issues (default 10). */
function observeMax(): number {
	return envInt("OMP_SQUAD_OBSERVE_MAX", 10);
}
/** Opt-in: file plain findings without the triage marker so the dispatcher auto-dispatches them. */
function autoDispatch(): boolean {
	return process.env.OMP_SQUAD_OBSERVE_AUTODISPATCH === "1";
}
/** Opt-in: action autoFixable findings directly (reap-survivor) instead of filing. */
function autoFix(): boolean {
	return process.env.OMP_SQUAD_OBSERVE_AUTOFIX === "1";
}
/** Opt-in: dispatch an observing agent to reproduce a confirmed regression instead of only filing it. */
function observeReproduce(): boolean {
	return process.env.OMP_SQUAD_OBSERVE_REPRODUCE === "1";
}
/** Consecutive failed auto-lands before the observer files a bug for a branch (mirrors the manager's
 *  AUTO_LAND_FAIL_CAP so a parked branch is exactly the one that gets a bug filed). */
function landFailCap(): number {
	return envInt("OMP_SQUAD_AUTOLAND_FAIL_CAP", 3);
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Strip terminal control sequences before text leaves logs/TTY and becomes a Plane title. */
export function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, "");
}

function cleanTitle(value: string): string {
	return stripAnsi(value).replace(/\s+/g, " ").trim();
}

/**
 * Run a transient external (Plane) call with ONE retry, then surface-and-swallow. A thrown Plane
 * error (429/network blip) used to be caught silently with `() => null`, dropping the whole tick's
 * audit/file work with no signal and no second chance. This retries once; if both attempts throw it
 * logs a warning and returns `fallback` so the loop stays non-fatal (never crashes a tick).
 */
async function withRetry<T>(fn: () => Promise<T>, fallback: T, onFail: (e: unknown) => void): Promise<T> {
	try {
		return await fn();
	} catch {
		try {
			return await fn();
		} catch (e) {
			onFail(e);
			return fallback;
		}
	}
}

// ── AUDIT CHECKS v1 — each a small pure fn over injected state (seeded from real gaps 2026-06-23). ──

/** A failing-test identity with bun's per-run duration suffix (e.g. " [1.15ms]") stripped, so the
 *  regression fingerprint is stable per test, not per run. A jittery duration (1.15ms vs 1.14ms, or a
 *  one-off 30000ms timeout) was minting a fresh `regression:` Plane issue every red tick for the SAME
 *  failing test — observer spam, and 429 churn from the cache-clear each filing triggers (OMPSQ). */
export function stableFailure(firstFailure?: string): string {
	return (firstFailure ?? "gate").replace(/\s*\[[\d.]+\s*(?:ns|[µu]s|ms|s)\]$/, "").trim() || "gate";
}

/** Check 1 — the acceptance gate is red on main ⇒ a regression finding (high). */
export function auditTestsGreen(gate: { ok: boolean; firstFailure?: string }): Finding[] {
	if (gate.ok) return [];
	const fail = stableFailure(gate.firstFailure);
	return [
		{
			fingerprint: `regression:${fail}`,
			title: `regression: ${fail}`,
			detail: "the acceptance gate (the repo's verify command) is red on main",
			severity: "high",
		},
	];
}

/** Check 2 — a finished (idle OR stopped) agent whose Plane issue is Done AND whose branch is
 *  proven-landed (a recorded DoneProof, OR ahead=0 of main when no proof exists) ⇒ reap the landed
 *  survivor (autofixable). DoneProof is consulted FIRST, before any arithmetic (squash/rebase merges
 *  make the rev-list count permanently nonzero even when the work is safely in origin/default — a
 *  proof only ever makes MORE things look landed, never fewer, so this never regresses the ahead=0
 *  path). Covers `stopped` too: a cleanly-landed agent's host exits, so it ends up stopped, not idle —
 *  the common done-state. Reaping frees the roster slot + host + worktree so the next ticket has room.
 *  `error` is excluded (a crash needs a human). */
export async function auditLandedSurvivors(
	agents: AgentDTO[],
	openIds: Set<string>,
	aheadOf: (a: AgentDTO) => Promise<number>,
	removeAgent: (id: string) => Promise<void>,
	hasProof: (a: AgentDTO) => Promise<boolean>,
): Promise<Finding[]> {
	const out: Finding[] = [];
	for (const a of agents) {
		if ((a.status !== "idle" && a.status !== "stopped") || !a.issue) continue;
		if (openIds.has(a.issue.id)) continue; // issue still open ⇒ not Done
		const proven = await hasProof(a);
		if (!proven && (await aheadOf(a)) !== 0) continue; // >0 ⇒ unlanded (stale-done); <0 ⇒ unknown — leave it
		out.push({
			fingerprint: `survivor:${a.issue.identifier ?? a.issue.id}`,
			title: `reap landed survivor ${a.id}`,
			detail: proven
				? `${a.status} agent ${a.id} — branch ${a.branch ?? "?"} has a recorded DoneProof and issue ${a.issue.identifier ?? a.issue.id} is Done; safe to reap`
				: `${a.status} agent ${a.id} — branch ${a.branch ?? "?"} is ahead=0 of main and issue ${a.issue.identifier ?? a.issue.id} is Done; safe to reap`,
			severity: "low",
			autoFixable: true,
			fix: () => removeAgent(a.id),
		});
	}
	return out;
}

/** ≥ this many Done-but-unlanded issues at once ⇒ a SYSTEMIC auto-land failure, not N independent
 *  cases. ponytail: a plain threshold; env-ify (OMP_SQUAD_STALE_DONE_SYSTEMIC) only if a repo wants
 *  to tune it. */
const STALE_DONE_SYSTEMIC = 3;

/**
 * Check 4 — Done Plane issues whose branch is ahead>0 (work the fleet marked done but never landed).
 *
 * These are false-Dones: reopen the original issue instead of filing a reconcile issue, so the
 * dispatcher re-runs the source ticket and Plane history stays on the real work item. N≥threshold
 * still emits one structural observer finding because that names an auto-land mechanism failure.
 *
 * DoneProof is consulted FIRST, before the arithmetic: a proven-landed branch is never "stale" no
 * matter what `aheadOf` reports — squash/rebase merges make that count permanently nonzero even
 * once the work is safely in origin/default, so trusting the rev-list count alone would reopen
 * already-landed work forever (a false-positive re-dispatch storm).
 */
export async function auditStaleDone(agents: AgentDTO[], openIds: Set<string>, aheadOf: (a: AgentDTO) => Promise<number>, hasProof: (a: AgentDTO) => Promise<boolean>): Promise<Finding[]> {
	const stale: AgentDTO[] = [];
	for (const a of agents) {
		if (!a.issue || openIds.has(a.issue.id)) continue; // no issue, or issue still open ⇒ not a Done candidate
		if (await hasProof(a)) continue; // proven landed ⇒ never stale, regardless of the arithmetic
		if ((await aheadOf(a)) > 0) stale.push(a);
	}
	if (stale.length === 0) return [];
	const ident = (a: AgentDTO): string => a.issue!.identifier ?? a.issue!.id;
	const reopenFindings = stale.map((a) => ({
		fingerprint: `false-done:${ident(a)}`,
		title: `reopen false-Done ${ident(a)}`,
		detail: `issue ${ident(a)} is marked Done but branch ${a.branch ?? "?"} is ahead>0 — the work was never landed`,
		severity: "structural" as const,
		reopenIssue: a.issue,
	}));
	if (stale.length >= STALE_DONE_SYSTEMIC) {
		const idents = stale.map(ident).sort();
		return [
			{
				fingerprint: "autoland-systemic-failure", // count-independent ⇒ one finding, not one-per-issue churn
				title: `auto-land is systemically failing — ${stale.length} issues Done-but-unlanded`,
				detail: `${stale.length} Done issues have unlanded branches (ahead>0): ${idents.join(", ")}.\nThis is one auto-land failure, not ${stale.length} cases — fix the land path, don't hand-reconcile each branch. Likely causes: event-driven land never re-fires for a re-adopted agent that didn't re-run (OMPSQ-164); a conflict-auto-resolved land left "staged" awaits a one-tap Land and is never completed/parked (OMPSQ-138/175); or the orchestrator land tick is off (OMP_SQUAD_AUTODRIVE).`,
				severity: "structural" as const,
			},
			...reopenFindings,
		];
	}
	return reopenFindings;
}

/** Check 3 — untracked files in the main checkout that also exist on an open agent branch ⇒ land hazard (structural). */
export function auditUntrackedHazard(untracked: string[], branchFiles: Set<string>): Finding[] {
	const collide = untracked.filter((f) => branchFiles.has(f)).sort();
	if (collide.length === 0) return [];
	return [
		{
			fingerprint: `untracked:${collide.join(",")}`,
			title: `commit/remove ${collide.join(", ")} — blocks auto-land`,
			detail: "untracked files in the main checkout also exist on an open agent branch; an auto-land would be blocked or clobber them",
			severity: "structural",
		},
	];
}

/**
 * Check 5 — a branch whose auto-land has failed `cap`+ times in a row (the manager parks it) ⇒ file
 * a bug so the fleet re-does the work on a fresh branch. Scoped to `liveBranches` (branches of agents
 * still in the roster) so a reaped/merged branch's stale ledger entry ages out instead of keeping the
 * finding alive forever.
 */
export function landFailureFindings(ledger: LandLedger, liveBranches: Set<string>, cap: number): Finding[] {
	const out: Finding[] = [];
	for (const [branch, entry] of Object.entries(ledger)) {
		if (entry.fails < cap || !liveBranches.has(branch)) continue;
		out.push({
			fingerprint: `land-failing:${branch}`,
			title: `auto-land failing for ${branch} — fix so it passes the gate`,
			detail: `auto-land merged then rolled back ${entry.fails}× in a row (the branch fails the acceptance gate). Latest failure:\n${entry.lastDetail}`,
			severity: "high",
		});
	}
	return out;
}

/**
 * Compliance findings (Epic 3, leaf 06) — a pure mapper from `src/compliance.ts`'s policy findings
 * into Observer `Finding`s, so a policy violation (forced land, overridden veto, repeatedly-failing
 * branch) rides the SAME dedup/file/confirm loop as the structural checks above, not just an
 * on-demand `/api/governance` read. `fingerprint` is stable per (code, subject) so a re-tick with the
 * same violation is never re-filed; `severity` passes through unchanged (compliance's
 * `low|high|structural` already matches Observer's `Severity`).
 */
export function auditCompliance(findings: ComplianceFinding[]): Finding[] {
	return findings.map((f) => ({
		fingerprint: `compliance:${f.code}:${f.subject}`,
		title: `compliance: ${f.code} — ${f.subject}`,
		detail: f.detail,
		severity: f.severity,
	}));
}

/** Check 6 — a stopped/idle agent with local uncommitted edits has stranded work that cannot be
 * inferred from commits-ahead. Surface it as an observer issue instead of letting it rot invisibly in
 * the worktree. Live working/input agents are excluded: their dirty files are in-progress, not stranded. */
export function auditStrandedUncommitted(agents: AgentDTO[], dirtyFiles: (a: AgentDTO) => string[]): Finding[] {
	const out: Finding[] = [];
	for (const a of agents) {
		if (a.status !== "idle" && a.status !== "stopped" && a.status !== "error") continue;
		const files = dirtyFiles(a).map((f) => f.trim()).filter(Boolean).sort();
		if (files.length === 0) continue;
		const ident = a.issue?.identifier ?? a.issue?.id ?? a.id;
		const shown = files.slice(0, 5).join(", ");
		const extra = files.length > 5 ? `, +${files.length - 5} more` : "";
		out.push({
			fingerprint: `stranded-uncommitted:${a.id}:${files.join(",")}`,
			title: `stranded uncommitted work in ${a.id}`,
			detail: `${a.status} agent ${a.id}${a.branch ? ` on ${a.branch}` : ""}${a.issue ? ` for ${ident}` : ""} has uncommitted worktree changes: ${shown}${extra}. Commit, land, or intentionally discard them before reaping/reusing the worktree.`,
			severity: "structural",
		});
	}
	return out;
}

interface SeenEntry {
	title: string;
	issueId?: string;
	reopened?: boolean;
	filedAt: number;
}
type SeenMap = Record<string, SeenEntry>;

export class Observer {
	private readonly deps: ObserverDeps;
	private timer?: Timer;
	/** Guards against overlapping ticks — the gate run can outlast the interval. */
	private running = false;
	private readonly seenPath: string;
	/** Filed-finding fingerprints, persisted so a gap is never re-filed across ticks/restarts. */
	private seen: SeenMap;

	constructor(deps: ObserverDeps) {
		this.deps = deps;
		this.seenPath = path.join(deps.stateDir, deps.seenFile ?? "observer-seen.json");
		this.seen = this.loadSeen();
	}

	/** Arm the loop. No-op (arms no timer) unless OMP_SQUAD_OBSERVE !== "0", so the daemon leaks no timer when off. */
	start(intervalMs = 60_000): void {
		if (this.timer || !observeEnabled()) return;
		// Contain a tick rejection: a throwing audit/file edge must be logged + retried next tick, never an
		// unhandled rejection (that crashes the daemon). Mirrors orchestrator.start().
		this.timer = setInterval(() => void this.tick().catch((e) => (this.deps.log ?? (() => {}))(`tick error (contained): ${msg(e)}`)), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** One audit step. Inert until OMP_SQUAD_OBSERVE !== "0"; gathers findings, files new ones (dedup'd + capped), confirms resolved. */
	async tick(): Promise<void> {
		if (!observeEnabled()) return;
		if (this.running) return; // never overlap — the gate run can outlast the interval
		this.running = true;
		const log = this.deps.log ?? (() => {});
		const clock = this.deps.now ?? Date.now;
		const t0 = clock();
		let found = 0;
		let filed = 0;
		let resolved = 0;
		try {
			// Plane list is a transient external call: retry once, then surface (warn + record) rather than
			// silently dropping the tick's work. `null` (Plane not configured/unreachable) is a clean signal,
			// not an error — only a THROW triggers the retry/warn.
			const open =
				(await withRetry(
					() => this.deps.listIssues(),
					null,
					(e) => {
						log(`listIssues failed after retry — skipping this tick's filing: ${msg(e)}`);
						this.deps.record?.({ durationMs: clock() - t0, level: "warn", detail: `listIssues failed: ${msg(e)}` });
					},
				)) ?? [];
			const findings = await this.collect(open);
			found = findings.length;
			let openObserverCount = open.filter((i) => i.name.includes(OBSERVER_TAG)).length;
			const max = observeMax();
			const reproduced = new Set<string>();

			for (const f of findings) {
				reproduced.add(f.fingerprint);

				// A confirmed regression (confirmedGate's double-confirmed gate-red, minted by
				// auditTestsGreen) can be dispatched to an observing agent that reproduces it in its own
				// worktree, instead of only filing an issue — opt-in and additive: OMP_SQUAD_OBSERVE_REPRODUCE
				// unset preserves today's file-only behavior exactly. A successful spawn marks the finding
				// handled for this tick (skips filing below); a failed/absent spawn falls through to the
				// normal file path unchanged. Never applies to survivors/false-dones/untracked/land-failure —
				// only a `regression:`-fingerprinted finding.
				if (f.fingerprint.startsWith("regression:") && observeReproduce() && this.deps.spawnObserver && !this.seen[f.fingerprint]) {
					const dispatched = await this.deps.spawnObserver(f).catch((e) => {
						log(`spawnObserver failed for ${f.fingerprint}: ${msg(e)}`);
						return false;
					});
					if (dispatched) {
						this.seen[f.fingerprint] = { title: f.title, filedAt: clock() };
						log(`dispatched observing agent for ${f.fingerprint}: ${f.title}`);
						continue;
					}
					log(`spawnObserver declined for ${f.fingerprint} — falling back to filing`);
				}

				// Autofixable findings are safe operational housekeeping (reap a landed survivor), never backlog
				// noise: reap when OMP_SQUAD_OBSERVE_AUTOFIX=1, otherwise just log — but NEVER file them as a
				// Plane issue (that floods the tracker with do-not-auto-land churn). Checked BEFORE the dedup
				// so a stale pre-fix filing self-clears via the resolve loop below.
				if (f.autoFixable) {
					if (f.fix && autoFix()) {
						await f.fix().catch((e) => log(`autofix failed for ${f.fingerprint}: ${msg(e)}`));
						log(`autofixed ${f.fingerprint}: ${f.title}`);
					} else {
						log(`autofixable — not filing ${f.fingerprint}: ${f.title} (OMP_SQUAD_OBSERVE_AUTOFIX=1 to reap)`);
					}
					continue;
				}

				if (f.reopenIssue) {
					if (!this.deps.reopenIssue) {
						reproduced.delete(f.fingerprint);
						log(`reopen unavailable for ${f.fingerprint}: ${f.title}`);
						continue;
					}
					if (this.seen[f.fingerprint]) continue; // dedup — already reopened; don't spam PATCH
					const reopened = await this.deps.reopenIssue(f.reopenIssue).catch((e) => {
						log(`reopen failed for ${f.fingerprint}: ${msg(e)}`);
						return false;
					});
					if (!reopened) {
						reproduced.delete(f.fingerprint); // reopen failed — retry next tick
						continue;
					}
					this.seen[f.fingerprint] = { title: f.title, issueId: f.reopenIssue.id, filedAt: clock(), reopened: true };
					log(`reopened false-Done ${f.reopenIssue.identifier ?? f.reopenIssue.id}: ${f.title}`);
					continue;
				}

				if (this.seen[f.fingerprint]) continue; // dedup — already filed; never re-file

				const triage = this.needsTriage(f);
				const findingTitle = cleanTitle(f.title);
				const title = cleanTitle(`${OBSERVER_TAG}${triage ? ` ${TRIAGE_MARKER}` : ""}: ${findingTitle}`);

				const prior = open.find((i) => {
					const name = cleanTitle(i.name);
					return name.includes(OBSERVER_TAG) && name.endsWith(`: ${findingTitle}`);
				});
				if (prior) {
					this.seen[f.fingerprint] = { title: f.title, issueId: prior.id, filedAt: clock() };
					log(`already open ${prior.identifier ?? prior.id} for ${f.fingerprint}: ${f.title}`);
					continue;
				}

				if (openObserverCount >= max) {
					// Cap reached: log + skip, and do NOT mark reproduced/persist — so it's retried once a slot frees.
					reproduced.delete(f.fingerprint);
					log(`observe cap reached (${max} open) — skipping ${f.fingerprint}: ${f.title}`);
					continue;
				}
				const ref = await this.deps.fileIssue(title).catch(() => null);
				if (!ref) {
					reproduced.delete(f.fingerprint); // filing failed — retry next tick
					log(`file failed for ${f.fingerprint}: ${f.title}`);
					continue;
				}
				openObserverCount++;
				filed++;
				this.seen[f.fingerprint] = { title: f.title, issueId: ref.id, filedAt: clock() };
				log(`filed ${triage ? "needs-triage" : "auto-dispatch"} ${f.severity} finding ${ref.identifier ?? ref.id}: ${f.title}`);
			}

			// Confirm-resolved: a previously-filed fingerprint that no longer reproduces is cleared.
			// The gate-backed regression finding is double-confirmed before filing (see confirmedGate),
			// so a single flaky red no longer files a false bug. ponytail: the clear side is still
			// single-shot — a transient green can close-then-refile a real regression; acceptable
			// (the dispatcher's proof gate catches premature work). Upgrade path: require N clean ticks.
			for (const fp of Object.keys(this.seen)) {
				if (reproduced.has(fp)) continue;
				const entry = this.seen[fp];
				// Self-healing: close now-resolved OBSERVER issues before clearing their fingerprints.
				// False-Done entries point at the source work item; never close it during resolve.
				if (!entry.reopened && this.deps.closeIssue && entry.issueId) await this.deps.closeIssue({ id: entry.issueId, name: entry.title }).catch((e) => log(`close failed for ${entry.issueId}: ${msg(e)}`));
				log(`resolved ${fp} (${entry.title}) — clearing fingerprint`);
				delete this.seen[fp];
				resolved++;
			}
			this.saveSeen();
		} finally {
			this.running = false;
			// One report per tick — found/filed surface real audit work; a no-op tick names why it did nothing.
			const skipReason: AutomationSkipReason | undefined = found === 0 ? "idle" : filed === 0 ? "already-handled" : undefined;
			this.deps.record?.({
				durationMs: (this.deps.now ?? Date.now)() - t0,
				found,
				filed,
				deduped: Math.max(0, found - filed),
				skipReason: resolved ? undefined : skipReason,
				detail: resolved
					? `${resolved} resolved`
					: found === 0
						? "no observer findings this tick"
						: filed === 0
							? "findings already filed, capped, autofixable, or an unresolved reopen/file edge"
							: undefined,
			});
		}
	}

	/**
	 * Acceptance gate with single-retry confirmation: a regression is only real if it REPRODUCES.
	 * A single red run is treated as suspect — the gate runs on a busy host while the fleet spawns
	 * real-omp agents and lands branches, so a transient flake (an integration test that "exited
	 * before ready" under load, a gate-vs-land race) routinely turns one tick red. Filing on that
	 * single red files a `regression:` bug naming a test that is actually green (OMPSQ-184). So when
	 * the first run is red, re-run once; only a second red is reported (with the reproduced run's
	 * firstFailure). A green confirm ⇒ flaky ⇒ reported green, nothing filed.
	 * ponytail: one extra gate run, and only on the rare red path; the green (common) path is unchanged.
	 */
	private async confirmedGate(): Promise<{ ok: boolean; firstFailure?: string }> {
		const safe = () => this.deps.runGate().catch(() => ({ ok: true }) as { ok: boolean; firstFailure?: string; skipped?: boolean });
		const first = await safe();
		if (first.skipped) this.deps.record?.({ detail: "gate inputs unchanged" });
		if (first.ok) return first;
		const confirm = await safe();
		if (!confirm.ok) return confirm; // reproduced — a real regression, named by the confirming run
		(this.deps.log ?? (() => {}))(`gate red then green on re-run — flaky, not filing (first failure was: ${first.firstFailure ?? "gate"})`);
		return { ok: true };
	}

	/** Consulted FIRST — before any ahead-count arithmetic — everywhere checks 2/4 ask "is this branch
	 *  landed". A recorded DoneProof survives squash/rebase merges that make rev-list arithmetic wrong —
	 *  but only while it still covers the branch's CURRENT tip (`proofCoversTip`): a follow-up commit
	 *  pushed to the same branch after the proof was taken must fall back to the ahead-count arithmetic,
	 *  not be permanently treated as landed by a now-stale proof. */
	private async hasDoneProof(a: AgentDTO): Promise<boolean> {
		if (!a.branch) return false;
		const proof = getDoneProofByBranch(this.deps.stateDir, a.branch);
		if (!proof) return false;
		return proofCoversTip(proof, a.branch, a.repo);
	}

	/** Run every audit check over the current injected state. */
	private async collect(open: IssueRef[]): Promise<Finding[]> {
		const agents = this.deps.listAgents();
		const openIds = new Set(open.map((i) => i.id));
		const hasProof = (a: AgentDTO): Promise<boolean> => this.hasDoneProof(a);
		const findings: Finding[] = [];
		findings.push(...auditTestsGreen(await this.confirmedGate()));
		findings.push(...(await auditLandedSurvivors(agents, openIds, this.deps.gitAheadOfMain, this.deps.removeAgent, hasProof)));
		findings.push(...(await auditStaleDone(agents, openIds, this.deps.gitAheadOfMain, hasProof)));
		// Union of files across in-flight agent branches — the set an auto-land would touch.
		// ponytail: one git ls-tree per branched agent per tick; fine for a normal roster.
		const branchFiles = new Set<string>();
		for (const a of agents) {
			if (!a.branch) continue;
			for (const file of this.deps.filesOnAgentBranch(a)) branchFiles.add(file);
		}
		findings.push(...auditUntrackedHazard(this.deps.untrackedInMain(), branchFiles));
		if (this.deps.uncommittedInWorktree) findings.push(...auditStrandedUncommitted(agents, this.deps.uncommittedInWorktree));
		// Branches whose auto-land keeps failing the gate (the manager parks them after the cap) ⇒ each
		// becomes a dedup'd bug issue the dispatcher can pick up to re-do the work on a fresh branch.
		if (this.deps.landLedger) {
			const liveBranches = new Set(agents.map((a) => a.branch).filter((b): b is string => !!b));
			const lf = landFailureFindings(this.deps.landLedger(), liveBranches, landFailCap());
			this.deps.recordLandFailureStreak?.(lf.length);
			// Recurring-failure memory (concern 05): annotate each currently-streaking branch's root
			// cause. The callee (squad-manager) skips its own reflect() call for a fingerprint already
			// annotated, so this fires ONE genuine LLM call per recurring failure, not once per tick.
			if (this.deps.annotateFailure) {
				const log = this.deps.log ?? (() => {});
				for (const f of lf) {
					const branch = f.fingerprint.slice("land-failing:".length);
					await this.deps.annotateFailure(f, branch).catch((e) => log(`annotateFailure failed for ${f.fingerprint}: ${msg(e)}`));
				}
			}
			findings.push(...lf);
		}
		// Epic 3 compliance findings (forced lands, overridden vetoes, repeatedly-failing branches) —
		// the same policy state /api/governance exposes on demand, now filed/deduped automatically.
		if (this.deps.complianceFindings) findings.push(...auditCompliance(await this.deps.complianceFindings()));
		return findings;
	}

	/**
	 * needs-triage (do-not-auto-land marker) unless explicitly opted into auto-dispatch:
	 *  - structural/security ⇒ ALWAYS needs-triage (never auto-dispatched);
	 *  - autoFixable findings aren't coding tasks ⇒ needs-triage (actioned via OBSERVE_AUTOFIX, not the fleet);
	 *  - everything else ⇒ needs-triage unless OMP_SQUAD_OBSERVE_AUTODISPATCH=1.
	 */
	private needsTriage(f: Finding): boolean {
		if (f.severity === "structural") return true;
		if (f.autoFixable) return true;
		return !autoDispatch();
	}

	private loadSeen(): SeenMap {
		try {
			if (!existsSync(this.seenPath)) return {};
			const raw = JSON.parse(readFileSync(this.seenPath, "utf8")) as unknown;
			return raw && typeof raw === "object" ? (raw as SeenMap) : {};
		} catch (e) {
			// Corrupt/unreadable ⇒ start fresh (worst case: one redundant re-file) — but surface it: a wiped
			// seen-map means dedup is silently degraded and the observer may re-file already-filed findings.
			(this.deps.log ?? (() => {}))(`observer seen-map unreadable — starting fresh (dedup degraded): ${msg(e)}`);
			return {};
		}
	}

	private saveSeen(): void {
		try {
			writeFileSync(this.seenPath, JSON.stringify(this.seen));
		} catch (e) {
			(this.deps.log ?? (() => {}))(`persist failed: ${msg(e)}`);
		}
	}
}
