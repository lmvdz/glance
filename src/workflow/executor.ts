/**
 * SingleAgentExecutor — the Phase-A NodeExecutor. It binds every agent/prompt
 * node to ONE persistent omp thread (so a workflow run is one steerable roster
 * entry), runs command nodes as shell scripts in the run's worktree, and raises
 * human gates through an injected callback (the driver turns these into the
 * manager's ordinary needs-input requests).
 *
 * Everything the driver and the tests need to vary is injected: how to acquire
 * the agent, how to emit frames, how to raise a gate, how to run a command, and
 * how to resolve an `@file.md` prompt reference.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDriver } from "../agent-driver.ts";
import { envBool } from "../config.ts";
import { fenceUntrusted } from "../digest.ts";
import { errText } from "../err-text.ts";
import { gateEnv } from "../gate-env.ts";
import { GateSemaphore, sharedGateSemaphore } from "../gate-semaphore.ts";
import { decideRegressionGate, extractGateFailures } from "../land.ts";
import { isOn, learningFlags } from "../metrics.ts";
import { identityNormalize, reduceOutput } from "../output-reduce.ts";
import { appendReflection, hashOutput, latestReflection, reflect, renderReflectionNote, renderRefutationNote, type ReflectLlm } from "../reflection.ts";
import type { NodeExecutor, NodeResult, RunContext, StageEvent, WorkflowNode } from "./types.ts";
import type { BaselineResult } from "./verify-baseline.ts";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** A canceller for a scheduled repeating check. */
export interface IdleCheckHandle {
	cancel: () => void;
}
/** Schedules a repeating idle check; returns a canceller. Default: setInterval; injected in tests to drive deterministically. */
export type IdleScheduler = (check: () => void, intervalMs: number) => IdleCheckHandle;

export interface SingleAgentExecutorOptions {
	/** Worktree the run operates in (command cwd, prompt-ref base). */
	cwd: string;
	/** Lazily obtain (and start) the agent thread for agent/prompt nodes. `node` lets the driver route an
	 *  `isolatedLineage` node (e.g. the TDD write-test author) to a SEPARATE agent/context from the shared
	 *  inner thread; absent/ordinary nodes get the one persistent thread. */
	acquireAgent: (node?: WorkflowNode) => Promise<AgentDriver>;
	/** Forward an omp-shaped frame to surfaces (the manager). */
	emit: (frame: Record<string, unknown>) => void;
	/** Raise a human gate; resolve with the chosen edge label. */
	gate: (node: WorkflowNode, options: string[]) => Promise<string>;
	/** Run a command node. Default: bash via Bun.spawn in `cwd`. */
	execCommand?: (script: string, cwd: string) => Promise<CommandResult>;
	/**
	 * Base-diff (postmortem-gate-fixes): resolve the failing set of a `goalGate` command node's
	 * script when run on the unit's BASE state (memoized — see `verify-baseline.ts`). When present
	 * AND `OMP_SQUAD_VERIFY_BASE_DIFF` is not "0", `runCommand` diffs a failing goalGate run against
	 * this baseline (`decideRegressionGate`, land.ts) so pre-existing red-baseline failures never
	 * block a unit whose own diff introduced nothing new — mirroring the land-time regression gate
	 * one level down. Absent ⇒ every non-zero exit on a goalGate node fails the node, exactly as
	 * before this feature.
	 */
	resolveBaselineFailures?: (script: string) => Promise<BaselineResult | null>;
	/** List files changed by this unit relative to the verified base ref. Default: `git diff --name-only <baseRef>...HEAD`. */
	listChangedFilesSinceBase?: (baseRef: string) => Promise<string[]>;
	/** Executor diagnostics (tests inject; production defaults to stderr where useful). */
	log?: (message: string) => void;
	/**
	 * Serializes command-node execution against every OTHER unit's command nodes in this process
	 * (root + org managers alike — see gate-semaphore.ts). Default: the shared process-wide
	 * singleton (`OMP_SQUAD_GATE_CONCURRENCY`, default 1 = fully serialized). Inject a private
	 * instance in tests so they don't contend with each other via the real singleton.
	 */
	gateSemaphore?: GateSemaphore;
	/**
	 * Factory legibility: fired when a command node has waited >30s for the gate semaphore (still
	 * queued, hasn't started running yet). Default: a console.error line ("verify queued behind N
	 * gates…"). Injected in tests to assert without spying on the console.
	 */
	onGateWait?: (node: WorkflowNode, elapsedMs: number, aheadInQueue: number) => void;
	/** Override the 30s gate-wait warning threshold (tests only; production uses the semaphore's default). */
	gateWarnAfterMs?: number;
	/** Resolve an `@relative.md` prompt reference. Default: read it from `cwd`-relative dir. */
	readPromptRef?: (ref: string) => Promise<string>;
	/** Per-node agent turn timeout. */
	turnTimeoutMs?: number;
	/** Resolve a node's effective model + reasoning effort (model stylesheet). */
	resolveStyle?: (node: WorkflowNode) => { model?: string; reasoningEffort?: string };
	/** Spawn an independent fleet agent for a parallel-branch node. Absent → branches run sequentially on the shared thread.
	 * `signal` aborts when the join short-circuits or a sibling threw — the spawner stops the agent so it isn't leaked.
	 * `branchKey` is the engine's deterministic per-branch identity, forwarded so the spawner can derive a stable agent id. */
	spawnBranch?: (node: WorkflowNode, task: string, signal?: AbortSignal, branchKey?: string) => Promise<NodeResult>;
	/** Schedule the idle turn-end check (default: setInterval). Injected in tests to drive it deterministically. */
	scheduleIdleCheck?: IdleScheduler;
	/** Seed the stage rollup when resuming a run, so the progress view survives a restart. */
	initialRollup?: { label: string; status: "in_progress" | "completed" }[];
	/** Fold extra context (e.g. unresolved plan-review comments) into the FIRST agent node after a
	 *  human gate resolves — the feed-forward seam. Returns undefined to add nothing. May be async. */
	decoratePrompt?: (node: WorkflowNode, ctx: RunContext) => Promise<string | undefined> | string | undefined;
	/**
	 * True when resuming on a FRESH inner thread (the prior host died — the adopt path). A cold thread
	 * never received the goal, so the in-flight node must RE-EXECUTE via runAgent (re-priming the goal)
	 * rather than waiting on a turn no live thread is running. Absent/false = warm reattach (reconnect),
	 * where the original turn is still in flight and must NOT be re-prompted.
	 */
	cold?: boolean;
	/**
	 * Reflexion (agentic-learning-loop concern 04) wiring for the "fixup" node — best-effort, gated
	 * behind `OMP_SQUAD_REFLEXION` at call time (this config is always passed for a verify-loop workflow;
	 * the flag decides whether it actually fires). `runId` is a getter since the driver mints its runId
	 * lazily at `execRun` time, after this options object is built.
	 */
	reflection?: { stateDir: string; repo: string; agentId: string; runId?: () => string; llm?: ReflectLlm };
}

/**
 * Run var that survives a cold restart to re-trigger the post-gate feed-forward fold. `gateJustPassed`
 * is in-memory and lost when a fresh executor is built on resume; this var rides in the checkpoint vars
 * so a cold resume of the agent node right after a human gate still folds in the reviewer's comments.
 */
const GATE_FOLD_VAR = "__gateFold";

/**
 * Signal-preserving budget for a command node's output (noisegate-compaction concern 03) — what
 * `runCommand` feeds back to the next agent turn as steer text, via `reduceOutput` (output-reduce.ts,
 * concern 01) instead of the old blind `slice(0, MAX_CONTEXT_OUTPUT)` head-cut, which happily dropped
 * the ONE `error TS2304:` or `(fail)` summary line a fixup agent needed most whenever it landed past
 * byte 4000.
 *
 * 3800, not the old MAX_CONTEXT_OUTPUT's 4000: `reduceOutput` budgets its returned text — body PLUS
 * its `[N bytes omitted — full: <path>]` pointer line — to ≤ this value exactly (offload-first, exact
 * pointer arithmetic; see output-reduce.ts), and `runCommand` below may still prepend the ~70-char
 * "[environment not provisioned…]\n" prefix AFTER reduction. Worst case 3800 + ~70 = 3870, safely
 * under checkpoint-log's `MAX_FIELD_BYTES` (4096, concern 04) so the checkpoint boundary never has to
 * re-cut this string itself — a second cut there could shear off the trailing pointer line and
 * silently amputate the offload trail concern 04 exists to preserve.
 */
const STEER_BODY_BUDGET = 3800;
const IDLE_POLL_MS = 5_000;
/**
 * Legibility only (no behavior change): a command node failing because its OWN environment was
 * never provisioned (no node_modules ⇒ `tsc`/`bun run <script>` isn't even resolvable) looks
 * byte-for-byte identical, to an operator reading a CATASTROPHE detail, to the code under test
 * actually being broken. It does NOT change `outcome` (still "failed" on any non-zero exit) or
 * touch the engine's visit-cap math, so escalate's cap (and every other cap) fires exactly as
 * before. It only prefixes the text fed to the fixup/escalate agent (and, transitively, whatever
 * CATASTROPHE detail string quotes it) so "deps are missing" is distinguishable at a glance from
 * "a real check/test failed".
 *
 * Cross-lineage review MEDIUM 4: the classification is anchored on an ENVIRONMENT FACT — the
 * worktree's `node_modules` must actually be absent — not on output text alone. A real
 * application bug whose message merely LOOKS like a missing-module error (a bad import path, a
 * test asserting on "command not found" strings) with node_modules present must NOT get the tag,
 * or fixup gets steered toward "reinstall deps" instead of the actual defect. The output-shape
 * check then narrows WHICH failures with a missing node_modules are called out (exit 127 /
 * module-resolution shapes), so an unrelated failure in a repo that never needed node_modules
 * isn't mislabeled either.
 */
const UNPROVISIONED_RE = /command not found|is not recognized as an internal or external command|cannot find module|MODULE_NOT_FOUND|Cannot find package|ENOENT.*node_modules|no such file or directory.*node_modules/i;
function looksUnprovisioned(code: number, output: string, cwd: string): boolean {
	if (existsSync(path.join(cwd, "node_modules"))) return false; // env fact: deps ARE present ⇒ never the tag
	return code === 127 || UNPROVISIONED_RE.test(output);
}

/** On by default; set OMP_SQUAD_VERIFY_BASE_DIFF=0 to disable the per-unit verify-node base-diff. */
function verifyBaseDiffEnabled(): boolean {
	return envBool("OMP_SQUAD_VERIFY_BASE_DIFF", true);
}
/** Idle polls (~30s) with the inner loop reporting not-streaming, after it was seen active, before we treat a missing agent_end as turn-end. */
const IDLE_TICKS = 6;
/** Reflexion "last attempt" fallback cap — mirrors the engine's DEFAULT_NODE_VISITS (engine.ts) so a
 *  hand-authored `fixup` node that sets no explicit `maxVisits` still gets its final visit skipped,
 *  matching what the engine's own shared.cap default would bound it to. Kept in sync manually (the
 *  executor can't reach the engine's `shared.cap`); if the engine default changes, change this too. */
const DEFAULT_FIXUP_VISIT_CAP = 50;

export class SingleAgentExecutor implements NodeExecutor {
	/** Stage rollup for the driver's synthetic getState (done/total + active). */
	readonly rollup: { label: string; status: "in_progress" | "completed" }[] = [];

	private readonly opts: SingleAgentExecutorOptions;
	private primed = false;
	private lastModel?: string;
	private lastEffort?: string;
	/** Set when a human gate resolves; consumed once by the next runAgent (the decoratePrompt fold). */
	private gateJustPassed = false;

	constructor(opts: SingleAgentExecutorOptions) {
		this.opts = opts;
		if (opts.initialRollup?.length) this.rollup.push(...opts.initialRollup);
		// primed is decoupled from the seeded rollup: a WARM resume's inner thread already carries the
		// goal (don't re-send it), but a COLD resume's fresh thread never received it — so the first
		// runAgent must re-prime "Goal:" while still showing the restored progress rollup (RTC-F11).
		this.primed = !!opts.initialRollup?.length && !opts.cold;
	}

	onStage(ev: StageEvent): void {
		if (ev.kind === "start" || ev.kind === "exit") return;
		if (ev.phase === "start") {
			// On resume the seeded rollup already ends with the in-flight node as in_progress; reuse that
			// trailing entry instead of pushing a duplicate (RTC-F10) so the resumed node isn't listed twice.
			const tail = this.rollup[this.rollup.length - 1];
			if (!(tail && tail.status === "in_progress" && tail.label === ev.label)) {
				this.rollup.push({ label: ev.label, status: "in_progress" });
			}
			this.opts.emit({ type: "tool_execution_start", toolName: "stage", intent: ev.label });
		} else {
			const last = this.rollup[this.rollup.length - 1];
			if (last) last.status = "completed";
		}
	}

	async runAgent(node: WorkflowNode, ctx: RunContext): Promise<NodeResult> {
		let body = node.prompt ?? node.label ?? "Continue toward the goal.";
		if (body.startsWith("@")) body = await this.resolvePromptRef(body);

		// ponytail: idempotent rewrite — a fan-out's branch results land in cwd for the review node to read.
		if (ctx.vars.parallelResults) {
			await fs.writeFile(path.join(this.opts.cwd, "parallel_results.json"), ctx.vars.parallelResults);
		}

		// An isolatedLineage node (the TDD write-test author) runs on a SEPARATE agent/context from the
		// shared inner, so the author and the implementer cannot co-reason. Its fresh thread never received
		// the goal, so it always gets its own "Goal:" prime — but it must NOT flip the shared thread's
		// `primed` (or the implementer, running next as the first node on the shared inner, would never be
		// primed with the goal) or its model/effort tracking (that follows the shared coder thread).
		const isolated = node.isolatedLineage === true;

		const parts: string[] = [];
		if (isolated || !this.primed) {
			parts.push(`Goal: ${ctx.goal}`);
			if (!isolated) this.primed = true;
		}
		parts.push(body);
		if (ctx.vars.lastOutput) {
			// Fenced like the adjacent reflection note below (marker-forgery hardening,
			// noisegate-compaction concern 03): command output is gate/unit-authored text, and an
			// unfenced channel would let a forged `[N bytes omitted — full: /etc/passwd]`-shaped line
			// misdirect the model into treating it as a real offload pointer or, worse, as instructions.
			parts.push(fenceUntrusted("recent command output", ctx.vars.lastOutput));
		}
		if (!isolated) {
			const reflection = await this.reflectionNote(node, ctx);
			if (reflection) parts.push(fenceUntrusted("reflection", reflection));
		}
		// Feed-forward: on the FIRST agent node after a gate resolves, fold in the reviewer's comments once
		// (agent nodes share one thread, so re-injecting every turn would spam the same notes). The trigger
		// is OR'd with a persisted checkpoint var so a COLD restart landing on this node still folds the
		// comments in — a fresh executor has gateJustPassed=false and would otherwise run blind (RTC-F7).
		// Never on an isolated author — reviewer feedback is for the implementer, not the test author.
		if (!isolated && (this.gateJustPassed || ctx.vars[GATE_FOLD_VAR])) {
			this.gateJustPassed = false;
			delete ctx.vars[GATE_FOLD_VAR];
			const extra = await this.opts.decoratePrompt?.(node, ctx);
			if (extra) parts.push(extra);
		}
		const message = parts.join("\n\n");

		try {
			const agent = await this.opts.acquireAgent(node);
			// Style (model/effort) tracking follows the shared coder thread only — an isolated agent carries
			// its own model chosen at creation, so applying the stylesheet to it (and mutating lastModel/
			// lastEffort) would leak across lineages and desync the coder's own next comparison.
			if (!isolated) {
				const style = this.opts.resolveStyle?.(node);
				if (style?.reasoningEffort && style.reasoningEffort !== this.lastEffort && agent.setThinkingLevel) {
					await agent.setThinkingLevel(style.reasoningEffort).catch(() => {});
					this.lastEffort = style.reasoningEffort;
				}
				if (style?.model && style.model !== this.lastModel && agent.setModel) {
					await agent.setModel(style.model).catch(() => {});
					this.lastModel = style.model;
				}
			}
			const timeoutMs = Number(node.attrs.timeout_ms) || this.opts.turnTimeoutMs || 600_000;
			const text = await this.awaitTurn(agent, message, timeoutMs);
			return { outcome: "succeeded", text };
		} catch (err) {
			return { outcome: "failed", text: errText(err) };
		}
	}

	/**
	 * Reflexion (concern 04): between fixup attempts, generate a short root-cause note from the LATEST
	 * failing command output and inject it — turning a blind retry into a learning retry. Scoped
	 * strictly to the "fixup" node of a verify loop (`verify → codefix → fixup → escalate`), the ONLY
	 * node this concern targets. Best-effort by contract: `reflect()` never throws, and any failure
	 * here degrades to "no note this round" — reflexion is an aid, never load-bearing.
	 *
	 * Only fires from the node's 2nd visit onward (the first fixup with raw output is often enough,
	 * and this halves LLM cost), and never on the LAST visit before the node's overflow tier (escalate)
	 * — there is no point reflecting right before giving up on this tier. The attempt counter rides
	 * `ctx.vars` (like `GATE_FOLD_VAR` above) so it survives a daemon restart mid-run.
	 *
	 * Refutation, not accumulation: if the current failing output hashes identically to the reflection
	 * the LAST attempt was generated from, that hypothesis provably didn't fix anything — say so
	 * plainly (no new LLM call) instead of re-guessing on the same evidence.
	 */
	private async reflectionNote(node: WorkflowNode, ctx: RunContext): Promise<string | undefined> {
		const cfg = this.opts.reflection;
		if (node.id !== "fixup" || !cfg || !ctx.vars.lastOutput) return undefined;
		if (!isOn(learningFlags(cfg.agentId).reflexion)) return undefined;
		const attemptKey = `__reflectAttempt:${node.id}`;
		const attempt = (Number(ctx.vars[attemptKey]) || 0) + 1;
		ctx.vars[attemptKey] = String(attempt);
		if (attempt < 2) return undefined; // first fixup: raw output alone is often enough
		if (attempt >= (node.maxVisits ?? DEFAULT_FIXUP_VISIT_CAP)) return undefined; // last try before overflow — no point reflecting (defensive: hand-authored nodes may set no maxVisits)
		try {
			const prior = await latestReflection(cfg.stateDir, cfg.repo, this.opts.cwd);
			// identityNormalize (output-reduce.ts, concern 01) strips the offload pointer's unique
			// ts+nonce and bun's per-test `[N.NNms]` duration jitter before hashing, so two visits
			// reproducing the SAME underlying failure compare EQUAL even though runCommand's
			// reduceOutput minted a fresh offload path this time — and bun's timing jitter, which
			// already defeated the raw comparator even for SMALL outputs, no longer does either
			// (red-team RT2-1). Feed the SAME normalized text into `reflect()` below so the
			// outputHash IT stores (reflection.ts hashes `input.output`) is computed on the identical
			// basis — a raw-vs-normalized mismatch there would silently break every future refutation
			// check even after fixing the comparison here.
			const normalizedOutput = identityNormalize(ctx.vars.lastOutput);
			const outputHash = hashOutput(normalizedOutput);
			if (prior && prior.outputHash === outputHash) return renderRefutationNote(prior); // unchanged failure ⇒ the last guess didn't fix it
			const r = await reflect({ output: normalizedOutput, prior: prior ? { rootCause: prior.rootCause, whatToDoDifferently: prior.whatToDoDifferently, outputHash: prior.outputHash } : undefined }, cfg.llm);
			if (!r) return undefined;
			await appendReflection(cfg.stateDir, cfg.repo, this.opts.cwd, { ...r, agentId: cfg.agentId, runId: cfg.runId?.(), repo: cfg.repo, at: Date.now() });
			return renderReflectionNote(r);
		} catch {
			return undefined; // never let reflexion block a fixup turn
		}
	}

	/**
	 * Resume an in-flight agent node after a daemon restart: reattach the thread and wait for its
	 * current turn to end WITHOUT re-prompting (re-prompting would duplicate work — e.g. re-file the
	 * Plane issues). If the turn already finished while the daemon was down, advance immediately.
	 */
	async resumeAgent(node: WorkflowNode, ctx: RunContext): Promise<NodeResult> {
		// Cold resume (fresh thread): the prior host died, so there is no in-flight turn to wait on and the
		// new thread never received the goal. Re-execute the node via runAgent (which re-primes "Goal:" because
		// `primed` is false on a cold resume), instead of skipping it — the D2 soundness fix.
		if (this.opts.cold) return this.runAgent(node, ctx);
		try {
			const agent = await this.opts.acquireAgent(node);
			const st = await agent.getState();
			if (!st.isStreaming) return { outcome: "succeeded", text: "" };
			const timeoutMs = Number(node.attrs.timeout_ms) || this.opts.turnTimeoutMs || 600_000;
			const text = await this.awaitTurn(agent, undefined, timeoutMs);
			return { outcome: "succeeded", text };
		} catch (err) {
			return { outcome: "failed", text: errText(err) };
		}
	}

	/**
	 * Gate-concurrency fix (spawn-heavy-flake-under-load incident): full-suite verify/codefix
	 * commands are the expensive, spawn-heavy work that thrashes when several units' workflows run
	 * them at the same time on one host. Every command node acquires the shared gate semaphore
	 * BEFORE running its script and releases it in a `finally` (so a thrown/rejected exec never
	 * deadlocks the gate for the next queued unit). This is entirely inside `runCommand` — invisible
	 * to the engine's routing/visit-cap math, which already recorded this attempt's visit before
	 * calling in here (engine.ts increments `shared.visits[current]` before `execute()`), so however
	 * long this node waits queued behind other gates, it can never burn an EXTRA visit or trip the
	 * cap early — it only delays when the one counted attempt actually runs.
	 */
	async runCommand(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		const script = node.script ?? "";
		if (!script.trim()) return { outcome: "failed", text: `command node "${node.id}" has no script` };
		const run = this.opts.execCommand ?? defaultExecCommand;
		const gate = this.opts.gateSemaphore ?? sharedGateSemaphore();
		const release = await gate.acquire((elapsedMs, aheadInQueue) => this.logGateWait(node, elapsedMs, aheadInQueue), this.opts.gateWarnAfterMs);
		try {
			const { code, stdout, stderr } = await run(script, this.opts.cwd);
			const combined = [stdout, stderr].filter((s) => s.trim()).join("\n").trim();
			// looksUnprovisioned classifies on the UNREDUCED `combined` — an unprovisioned signature
			// (e.g. "cannot find module") could otherwise fall inside a region reduceOutput cuts from a
			// huge dump, and the regex/existsSync check is cheap against text already held in memory.
			const { text: reduced } = await reduceOutput(combined, STEER_BODY_BUDGET, { command: script, agentId: this.opts.reflection?.agentId, source: "executor-steer" });
			let shown = code !== 0 && looksUnprovisioned(code, combined, this.opts.cwd) ? `[environment not provisioned — dependencies missing, not a code failure]\n${reduced}` : reduced;
			let outcome: "succeeded" | "failed" = code === 0 ? "succeeded" : "failed";
			// Base-diff (postmortem-gate-fixes): only the verify goalGate node, only on a failing run, only
			// when a baseline provider is wired AND the flag is on. codefix/other command nodes and a
			// successful goalGate run are untouched — this can only turn a "failed" into "succeeded" (never
			// the reverse) when the failing set is a subset of what already fails on base.
			if (code !== 0 && node.goalGate === true && this.opts.resolveBaselineFailures && verifyBaseDiffEnabled()) {
				const diffed = await this.applyBaseDiff(script, combined, reduced, shown);
				outcome = diffed.outcome;
				shown = diffed.shown;
			}
			this.opts.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `$ ${node.label ?? node.id} → exit ${code}\n${shown || "(no output)"}` } });
			this.opts.emit({ type: "message_end" });
			return { outcome, text: shown };
		} finally {
			release();
		}
	}

	/**
	 * Base-diff the verify goalGate node's failing set against the unit's base state
	 * (`resolveBaselineFailures`, backed by `verify-baseline.ts`) so pre-existing red-baseline
	 * failures — flaky tests, stale-shared-node_modules env failures — never block a unit whose OWN
	 * diff is clean. Mirrors `applyRegressionGate`'s base-vs-merged comparison (`../land.ts`) one
	 * level down, at the per-unit node instead of the post-merge full suite; same fail-closed
	 * posture: an unestablished base NEVER reads as "everything tolerated".
	 */
	private async applyBaseDiff(script: string, combined: string, reduced: string, shownWithUnprovisionedTag: string): Promise<{ outcome: "succeeded" | "failed"; shown: string }> {
		const currentFailures = extractGateFailures(combined);
		const baseline = await this.opts.resolveBaselineFailures!(script);
		if (baseline === null || baseline.unrunnable) {
			const reason = baseline === null ? "no baseline result" : baseline.unrunnable;
			return { outcome: "failed", shown: `[base-diff: could not establish a base run (${reason}) — blocking on the full failure set]\n${shownWithUnprovisionedTag}` };
		}
		const { allow, newRegressions } = decideRegressionGate(baseline.failures, currentFailures);
		if (allow) {
			return {
				outcome: "succeeded",
				shown: `[base-diff: gate passed — all ${currentFailures.length} failing test(s) already fail on the base (${baseline.baseRef.slice(0, 8)}); 0 introduced by this unit]`,
			};
		}

		const { attributed, flakes } = await this.excludeUntouchedEnvironmentFlakes(script, baseline.baseRef, newRegressions);
		if (attributed.length === 0) {
			const flakeNote = renderFlakeNote(flakes);
			return {
				outcome: "succeeded",
				shown: `[base-diff: gate passed — ${flakeNote}; 0 introduced by this unit]`,
			};
		}
		const flakePrefix = flakes.length > 0 ? `${renderFlakeNote(flakes)}\n` : "";
		return {
			outcome: "failed",
			shown: `[base-diff: ${attributed.length} NEW failure(s) introduced by this unit — fix these:]\n${flakePrefix}${attributed.join("\n")}\n${reduced}`,
		};
	}

	private async excludeUntouchedEnvironmentFlakes(script: string, baseRef: string, newRegressions: string[]): Promise<{ attributed: string[]; flakes: string[] }> {
		let touched: Set<string>;
		try {
			const changed = this.opts.listChangedFilesSinceBase ? await this.opts.listChangedFilesSinceBase(baseRef) : await defaultListChangedFilesSinceBase(baseRef, this.opts.cwd);
			touched = new Set(changed.map(normalizeRepoPath));
		} catch (err) {
			this.logBaseDiff(`[base-diff] could not list unit-changed files for flake attribution: ${errText(err)}`);
			return { attributed: newRegressions, flakes: [] };
		}

		const attributed: string[] = [];
		const flakes = new Set<string>();
		const isolatedPassesByFile = new Map<string, boolean>();
		for (const failure of newRegressions) {
			const file = extractTestFileFromFailure(failure);
			if (!file || touched.has(file)) {
				attributed.push(failure);
				continue;
			}
			let isolatedPasses = isolatedPassesByFile.get(file);
			if (isolatedPasses === undefined) {
				isolatedPasses = await this.passesInIsolation(script, file);
				isolatedPassesByFile.set(file, isolatedPasses);
			}
			if (isolatedPasses) {
				flakes.add(file);
				this.logBaseDiff(`[base-diff] environment-flake excluded: ${file}`);
			} else {
				attributed.push(failure);
			}
		}
		return { attributed, flakes: [...flakes] };
	}

	private async passesInIsolation(script: string, file: string): Promise<boolean> {
		const run = this.opts.execCommand ?? defaultExecCommand;
		const isolationScript = isolateBunTestSegment(script, file);
		for (let attempt = 0; attempt < 3; attempt++) {
			const { code } = await run(isolationScript, this.opts.cwd);
			if (code === 0) return true;
		}
		return false;
	}

	private logBaseDiff(message: string): void {
		if (this.opts.log) this.opts.log(message);
		else console.error(message);
	}

	/** Factory legibility for a queued gate (default channel: console.error; injectable for tests). */
	private logGateWait(node: WorkflowNode, elapsedMs: number, aheadInQueue: number): void {
		const msg = `[gate] "${node.id}" verify queued behind ${aheadInQueue} gate${aheadInQueue === 1 ? "" : "s"} — waited ${Math.round(elapsedMs / 1000)}s so far`;
		if (this.opts.onGateWait) this.opts.onGateWait(node, elapsedMs, aheadInQueue);
		else console.error(msg);
	}

	async humanGate(node: WorkflowNode, options: string[], ctx: RunContext): Promise<string> {
		const label = await this.opts.gate(node, options);
		this.gateJustPassed = true; // the next agent node folds in the review comments once
		// Persist the same intent in the run vars so the fold survives a cold restart between this gate
		// and the next agent node (the entry checkpoint captures vars; runAgent clears it on consume).
		ctx.vars[GATE_FOLD_VAR] = "1";
		return label;
	}

	/** A parallel branch: a fresh fleet agent (if `spawnBranch`) or, without a fleet, a sequential turn. */
	async runBranch(node: WorkflowNode, ctx: RunContext, signal?: AbortSignal, branchKey?: string): Promise<NodeResult> {
		if (!this.opts.spawnBranch) return this.runAgent(node, ctx);
		let body = node.prompt ?? node.label ?? "";
		if (body.startsWith("@")) body = await this.resolvePromptRef(body);
		const task = body ? `Goal: ${ctx.goal}\n\n${body}` : ctx.goal;
		return this.opts.spawnBranch(node, task, signal, branchKey);
	}

	private async resolvePromptRef(ref: string): Promise<string> {
		if (this.opts.readPromptRef) return this.opts.readPromptRef(ref);
		return fs.readFile(path.join(this.opts.cwd, ref.slice(1)), "utf8");
	}

	/**
	 * Send a turn and resolve with the assistant text once the agent loop ends.
	 * Primary signal: the `agent_end` frame. Fallback: the inner agent reports idle
	 * (isStreaming false) for IDLE_TICKS polls after it was seen active — so if `agent_end`
	 * is ever missed (e.g. after auto-compaction on a very long loop) a finished run can't
	 * hang on its node until the hours-long turn timeout. isStreaming stays true through tool
	 * calls, so a slow tool never trips the fallback.
	 */
	private awaitTurn(agent: AgentDriver, message: string | undefined, timeoutMs: number): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let buf = "";
		let settled = false;
		let sawStreaming = false;
		let idleTicks = 0;
		const onEvent = (frame: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } }) => {
			if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") {
				buf += frame.assistantMessageEvent.delta ?? "";
			} else if (frame.type === "agent_end") {
				finish();
			}
		};
		const onExit = () => { if (!settled) reject(new Error("agent exited mid-turn")); };
		const timer = setTimeout(() => { if (!settled) reject(new Error(`stage timed out after ${timeoutMs}ms`)); }, timeoutMs);
		const idleCheck = () => {
			void agent
				.getState()
				.then((st) => {
					if (st.isStreaming) {
						sawStreaming = true;
						idleTicks = 0;
					} else if (sawStreaming && ++idleTicks >= IDLE_TICKS) {
						finish();
					}
				})
				.catch(() => {});
		};
		const idle = (this.opts.scheduleIdleCheck ?? defaultIdleScheduler)(idleCheck, IDLE_POLL_MS);
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			idle.cancel();
			agent.off("event", onEvent);
			agent.off("exit", onExit);
			resolve(buf.trim());
		};
		agent.on("event", onEvent);
		agent.once("exit", onExit);
		if (message !== undefined) {
			agent.prompt(message).catch((err) => {
				if (!settled) reject(err);
			});
		}
		return promise;
	}
}

function extractTestFileFromFailure(failure: string): string | null {
	const match = failure.match(/\b((?:\.\/)?(?:tests|src)\/[^>\s:]+\.test\.[cm]?[tj]sx?)\b/);
	return match ? normalizeRepoPath(match[1]) : null;
}

function normalizeRepoPath(file: string): string {
	return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isolateBunTestSegment(script: string, file: string): string {
	const quotedFile = shellQuote(file);
	const parts = script.trim().split(/(\s*&&\s*)/);
	for (let i = 0; i < parts.length; i += 2) {
		if (/\bbun\s+test\b/.test(parts[i])) {
			parts[i] = `${parts[i].trim()} ${quotedFile}`;
			return parts.join("");
		}
	}
	return `bun test ${quotedFile}`;
}

function renderFlakeNote(files: string[]): string {
	return `${files.length} flake${files.length === 1 ? "" : "s"} excluded: ${files.join(", ")}`;
}

async function defaultListChangedFilesSinceBase(baseRef: string, cwd: string): Promise<string[]> {
	const proc = Bun.spawn(["git", "diff", "--name-only", `${baseRef}...HEAD`], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error((stderr || stdout).trim() || `git diff exited ${code}`);
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

const defaultIdleScheduler: IdleScheduler = (check, intervalMs) => {
	const t: Timer = setInterval(check, intervalMs);
	t.unref?.();
	return { cancel: () => clearInterval(t) };
};

/**
 * Wrap a command-node script so the run's own `node_modules/.bin` is first on PATH.
 *
 * The gate runs under `bash -lc`, and a LOGIN shell re-derives PATH by sourcing
 * `/etc/profile` — which on many systems drops non-standard dirs (e.g. `~/.bun/bin`,
 * where a globally-installed `omp` lives). A gate that shells out to a project-local
 * binary (notably `omp`, which several spawn-based tests invoke bare) then fails to
 * resolve it and the gate exits non-zero even though the code is green. Prepending
 * the local bin — the same thing `npm run`/`bun run` do — makes gates robust to
 * whatever the login profile does to PATH. The export is injected INSIDE the script
 * so it runs AFTER `-l` sources the profile and therefore wins.
 */
export function withLocalBinOnPath(script: string, cwd: string): string {
	const localBin = path.join(cwd, "node_modules", ".bin");
	const quoted = `'${localBin.replace(/'/g, `'\\''`)}'`;
	return `export PATH=${quoted}:"$PATH"\n${script}`;
}

/**
 * Ruling (spawn-env-scrub batch 1 follow-up): a command node's `script` is authored in the
 * workflow's DOT graph (verify/lint/build steps a plan or its human author wrote), not
 * per-turn tenant-agent output — the same shape as the proof/land/regression gates that
 * `gate-env.ts` already scrubs, NOT the deny-by-default tenant-agent scrub in `spawn-env.ts`
 * (a `bun test`/`tsc` verify step legitimately needs CARGO_HOME/GOPATH/NVM_DIR/CI, which
 * spawn-env's keep-list deliberately excludes). It runs unsandboxed on the daemon host like
 * those gates, so it gets the same env: `gateEnv()`, not full `process.env` inheritance.
 */
export async function defaultExecCommand(script: string, cwd: string): Promise<CommandResult> {
	const proc = Bun.spawn(["bash", "-lc", withLocalBinOnPath(script, cwd)], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gateEnv() });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}
