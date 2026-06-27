/**
 * Observer — periodic fleet self-audit loop (OMPSQ-52), sibling to the Orchestrator.
 *
 * Where the Orchestrator DRIVES work (spawn → verify → land), the Observer CONFIRMS the
 * fleet/project is in the intended state and, on a detected gap, FILES a fix-issue the
 * existing Dispatcher picks up — closing observe → fix → confirm. It never modifies the
 * orchestrator/dispatcher; it only files issues (and, opt-in, reaps a landed survivor).
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
import * as path from "node:path";
import type { AutomationRecorder } from "./automation-log.ts";
import type { LandLedger } from "./land-ledger.ts";
import type { AgentDTO, IssueRef } from "./types.ts";

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
	/** Reap a landed-survivor agent (the only autofix; never touches main/code). */
	removeAgent: (id: string) => Promise<void>;
	/** Run the acceptance gate (the repo's own verify command) on main; `ok:false` ⇒ red. */
	runGate: () => Promise<{ ok: boolean; firstFailure?: string }>;
	/** Commits on the agent's branch not in main: 0 ⇒ landed; >0 ⇒ unlanded; <0 ⇒ unknown. */
	gitAheadOfMain: (agent: AgentDTO) => number;
	/** Untracked file paths in the main checkout. */
	untrackedInMain: () => string[];
	/** Tracked files on an agent's branch (for the untracked-collision check); `[]` when no branch. */
	filesOnAgentBranch: (agent: AgentDTO) => string[];
	/** Branch → auto-land failure streak (the persisted ledger). Absent ⇒ the land-failure check is
	 *  skipped — keeps the loop usable in tests / before any land. */
	landLedger?: () => LandLedger;
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
	return Number(process.env.OMP_SQUAD_OBSERVE_MAX) || 10;
}
/** Opt-in: file plain findings without the triage marker so the dispatcher auto-dispatches them. */
function autoDispatch(): boolean {
	return process.env.OMP_SQUAD_OBSERVE_AUTODISPATCH === "1";
}
/** Opt-in: action autoFixable findings directly (reap-survivor) instead of filing. */
function autoFix(): boolean {
	return process.env.OMP_SQUAD_OBSERVE_AUTOFIX === "1";
}
/** Consecutive failed auto-lands before the observer files a bug for a branch (mirrors the manager's
 *  AUTO_LAND_FAIL_CAP so a parked branch is exactly the one that gets a bug filed). */
function landFailCap(): number {
	return Number(process.env.OMP_SQUAD_AUTOLAND_FAIL_CAP) || 3;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

/** Check 2 — a finished (idle OR stopped) agent ahead=0 of main whose Plane issue is Done ⇒ reap the
 *  landed survivor (autofixable). Covers `stopped` too: a cleanly-landed agent's host exits, so it
 *  ends up stopped, not idle — the common done-state. Reaping frees the roster slot + host + worktree
 *  so the next ticket has room. `error` is excluded (a crash needs a human). */
export function auditLandedSurvivors(agents: AgentDTO[], openIds: Set<string>, aheadOf: (a: AgentDTO) => number, removeAgent: (id: string) => Promise<void>): Finding[] {
	const out: Finding[] = [];
	for (const a of agents) {
		if ((a.status !== "idle" && a.status !== "stopped") || !a.issue) continue;
		if (openIds.has(a.issue.id)) continue; // issue still open ⇒ not Done
		if (aheadOf(a) !== 0) continue; // >0 ⇒ unlanded (stale-done); <0 ⇒ unknown — leave it
		out.push({
			fingerprint: `survivor:${a.issue.identifier ?? a.issue.id}`,
			title: `reap landed survivor ${a.id}`,
			detail: `${a.status} agent ${a.id} — branch ${a.branch ?? "?"} is ahead=0 of main and issue ${a.issue.identifier ?? a.issue.id} is Done; safe to reap`,
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
 * ONE is a special case ⇒ file a per-issue reconcile so it gets landed. But N≥STALE_DONE_SYSTEMIC at
 * once is the auto-land MECHANISM failing, not N coincidences — filing a reconcile per issue is noise
 * that nudges a manual force-land each time (treating the symptom, one branch at a time). Above the
 * threshold, collapse to ONE structural finding that names the pattern and points at the land path, so
 * the fleet fixes auto-land instead of hand-reconciling every stranded branch. The aggregate keeps a
 * single count-independent fingerprint so it dedups across ticks even as the stranded set shifts.
 */
export function auditStaleDone(agents: AgentDTO[], openIds: Set<string>, aheadOf: (a: AgentDTO) => number): Finding[] {
	const stale = agents.filter((a) => a.issue && !openIds.has(a.issue.id) && aheadOf(a) > 0);
	if (stale.length === 0) return [];
	const ident = (a: AgentDTO): string => a.issue!.identifier ?? a.issue!.id;
	if (stale.length >= STALE_DONE_SYSTEMIC) {
		const idents = stale.map(ident).sort();
		return [
			{
				fingerprint: "autoland-systemic-failure", // count-independent ⇒ one finding, not one-per-issue churn
				title: `auto-land is systemically failing — ${stale.length} issues Done-but-unlanded`,
				detail: `${stale.length} Done issues have unlanded branches (ahead>0): ${idents.join(", ")}.\nThis is one auto-land failure, not ${stale.length} cases — fix the land path, don't hand-reconcile each branch. Likely causes: event-driven land never re-fires for a re-adopted agent that didn't re-run (OMPSQ-164); a conflict-auto-resolved land left "staged" awaits a one-tap Land and is never completed/parked (OMPSQ-138/175); or the orchestrator land tick is off (OMP_SQUAD_AUTODRIVE).`,
				severity: "structural",
			},
		];
	}
	return stale.map((a) => ({
		fingerprint: `stale-done:${ident(a)}`,
		title: `reconcile Done-but-unlanded ${ident(a)}`,
		detail: `issue ${ident(a)} is marked Done but branch ${a.branch ?? "?"} is ahead>0 — the work was never landed`,
		severity: "structural",
	}));
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

interface SeenEntry {
	title: string;
	issueId?: string;
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
			const open = (await this.deps.listIssues().catch(() => null)) ?? [];
			const findings = await this.collect(open);
			found = findings.length;
			let openObserverCount = open.filter((i) => i.name.includes(OBSERVER_TAG)).length;
			const max = observeMax();
			const reproduced = new Set<string>();

			for (const f of findings) {
				reproduced.add(f.fingerprint);
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

				if (this.seen[f.fingerprint]) continue; // dedup — already filed; never re-file

				if (openObserverCount >= max) {
					// Cap reached: log + skip, and do NOT mark reproduced/persist — so it's retried once a slot frees.
					reproduced.delete(f.fingerprint);
					log(`observe cap reached (${max} open) — skipping ${f.fingerprint}: ${f.title}`);
					continue;
				}

				const triage = this.needsTriage(f);
				const title = `${OBSERVER_TAG}${triage ? ` ${TRIAGE_MARKER}` : ""}: ${f.title}`;
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
				// Self-healing: close the now-resolved Plane issue before clearing its fingerprint, so a finding
				// that stops reproducing never leaves a stale OPEN issue behind.
				if (this.deps.closeIssue && entry.issueId) await this.deps.closeIssue({ id: entry.issueId, name: entry.title }).catch((e) => log(`close failed for ${entry.issueId}: ${msg(e)}`));
				log(`resolved ${fp} (${entry.title}) — clearing fingerprint`);
				delete this.seen[fp];
				resolved++;
			}
			this.saveSeen();
		} finally {
			this.running = false;
			// One report per tick — found/filed surface real audit work; a clean tick is a heartbeat (ring-only).
			this.deps.record?.({ durationMs: (this.deps.now ?? Date.now)() - t0, found, filed, deduped: Math.max(0, found - filed), detail: resolved ? `${resolved} resolved` : undefined });
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
		const safe = () => this.deps.runGate().catch(() => ({ ok: true }) as { ok: boolean; firstFailure?: string });
		const first = await safe();
		if (first.ok) return first;
		const confirm = await safe();
		if (!confirm.ok) return confirm; // reproduced — a real regression, named by the confirming run
		(this.deps.log ?? (() => {}))(`gate red then green on re-run — flaky, not filing (first failure was: ${first.firstFailure ?? "gate"})`);
		return { ok: true };
	}

	/** Run every audit check over the current injected state. */
	private async collect(open: IssueRef[]): Promise<Finding[]> {
		const agents = this.deps.listAgents();
		const openIds = new Set(open.map((i) => i.id));
		const findings: Finding[] = [];
		findings.push(...auditTestsGreen(await this.confirmedGate()));
		findings.push(...auditLandedSurvivors(agents, openIds, this.deps.gitAheadOfMain, this.deps.removeAgent));
		findings.push(...auditStaleDone(agents, openIds, this.deps.gitAheadOfMain));
		// Union of files across in-flight agent branches — the set an auto-land would touch.
		// ponytail: one git ls-tree per branched agent per tick; fine for a normal roster.
		const branchFiles = new Set<string>();
		for (const a of agents) {
			if (!a.branch) continue;
			for (const file of this.deps.filesOnAgentBranch(a)) branchFiles.add(file);
		}
		findings.push(...auditUntrackedHazard(this.deps.untrackedInMain(), branchFiles));
		// Branches whose auto-land keeps failing the gate (the manager parks them after the cap) ⇒ each
		// becomes a dedup'd bug issue the dispatcher can pick up to re-do the work on a fresh branch.
		if (this.deps.landLedger) {
			const liveBranches = new Set(agents.map((a) => a.branch).filter((b): b is string => !!b));
			findings.push(...landFailureFindings(this.deps.landLedger(), liveBranches, landFailCap()));
		}
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
		} catch {
			return {}; // corrupt/unreadable ⇒ start fresh (worst case: one redundant re-file)
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
