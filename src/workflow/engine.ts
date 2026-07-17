/**
 * WorkflowEngine — walks a parsed workflow graph, delegating execution to a
 * NodeExecutor. The engine is pure orchestration: routing, conditions, visit
 * caps, goal-gate failure handling, human-gate pausing, and stage emission. It
 * knows nothing about omp, processes, or the fleet — that lives in executors.
 *
 * Routing per node:
 *   - human node     → take the edge whose label equals the chosen option;
 *   - everything else→ first edge whose `condition` is true; else a goal-gate
 *                      node that failed routes to its `retry_target`; else the
 *                      first unconditioned edge (the fallback).
 * A node that would exceed its visit cap cannot run again; if nothing else routes
 * the run, it fails (this is what bounds fix-up loops).
 */

import { identityNormalize } from "../output-reduce.ts";
import type { BranchOutcome, EngineCheckpoint, NodeExecutor, NodeResult, Outcome, RunContext, RunResult, StageEvent, Workflow, WorkflowNode, WorkflowRunState } from "./types.ts";

const DEFAULT_NODE_VISITS = 50;

/**
 * Max cold (dead-thread) re-entries of one genuinely-in-flight node before we stop re-running it and
 * escalate to a human. Bounds a run that crashes the daemon before reaching idle: the visit-cap does
 * not re-count the resumed node, so without this a poison node would re-run on every restart forever.
 */
const RESUME_ATTEMPT_CAP = 3;

/** Run-wide mutable state threaded through the walk and concurrent branches. */
interface Shared {
	visits: Record<string, number>;
	stages: StageEvent[];
	cap: number;
	index: number;
	/** Last normalized (trimmed) output of each goal-gate node, to detect a zero-progress retry loop. */
	goalOutputs: Record<string, string>;
}

/** Options accepted by `run()`. */
interface RunOpts {
	resume?: WorkflowRunState;
	checkpoint?: (c: EngineCheckpoint) => void;
	/** Fired at every terminal-failure return (visit-cap-no-overflow, poison-cap, no-recovery-route,
	 *  ran-off-the-end) with the checkpoint the run died at, so a caller can persist a terminal marker. */
	escalate?: (reason: string, checkpoint: EngineCheckpoint) => void | Promise<void>;
}

export class WorkflowCancelled extends Error {
	constructor() {
		super("workflow cancelled");
		this.name = "WorkflowCancelled";
	}
}

export class WorkflowEngine {
	private cancelled = false;

	constructor(
		private readonly wf: Workflow,
		private readonly executor: NodeExecutor,
	) {}

	/** Request the run stop at the next node boundary. */
	stop(): void {
		this.cancelled = true;
	}

	async run(goal: string, opts?: RunOpts): Promise<RunResult> {
		const resume = opts?.resume;
		const ctx: RunContext = { goal, vars: resume ? { ...resume.vars } : {}, outcome: resume?.outcome, preferredLabel: resume?.preferredLabel };
		const shared: Shared = { visits: resume ? { ...resume.visits } : {}, stages: [], cap: this.wf.maxNodeVisits ?? DEFAULT_NODE_VISITS, index: resume?.index ?? 0, goalOutputs: {} };

		let current: string | undefined = resume?.currentNode ?? this.wf.start;
		let resuming = resume !== undefined;
		while (current) {
			if (this.cancelled) throw new WorkflowCancelled();
			const node = this.wf.nodes.get(current);
			if (!node) {
				// Fifth terminal-failure return (review finding 5): this used to bypass terminalFail entirely,
				// so a dangling edge never got a terminal marker — resumable()'s `!terminal` check passed, the
				// poison cap never tripped (the run dies inside run() before ever reaching the resume-attempt
				// check), and the run boot-looped through adoption forever. Route it through the same helper as
				// the other four terminal-failure sites.
				const checkpoint: EngineCheckpoint = { goal, currentNode: current, visits: { ...shared.visits }, vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel, index: shared.index, resumeAttempts: 0 };
				return this.terminalFail(opts, shared, checkpoint, "failed", `dangling edge to unknown node "${current}"`);
			}
			if (node.kind === "exit") return { outcome: "succeeded", reason: "reached exit", stages: shared.stages };

			// The resumed node was already counted before the restart — don't re-count or re-cap it.
			if (!resuming) {
				const limit = node.maxVisits ?? shared.cap;
				if ((shared.visits[current] ?? 0) >= limit) {
					// Visit cap hit: route to a declared overflow target (e.g. fix-up → escalate) instead
					// of hard-failing; with no overflow this is the original loop-bounding failure.
					if (node.overflow) {
						current = node.overflow;
						continue;
					}
					const checkpoint: EngineCheckpoint = { goal, currentNode: current, visits: { ...shared.visits }, vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel, index: shared.index, resumeAttempts: 0 };
					return this.terminalFail(opts, shared, checkpoint, "failed", `node "${current}" exceeded its visit cap (${limit})`);
				}
				shared.visits[current] = (shared.visits[current] ?? 0) + 1;
			}

			// Poison cap: only the cold-resumed in-flight node (the one re-executed on a dead thread)
			// is bounded here. A node that keeps crashing the daemon mid-execution would otherwise re-run
			// on every restart unchecked. Forward progress (the exit checkpoint) resets resumeAttempts to 0.
			let entryAttempts = 0;
			if (resuming && resume?.cold) {
				const prior = resume.resumeAttempts ?? 0;
				if (prior >= RESUME_ATTEMPT_CAP) {
					const checkpoint: EngineCheckpoint = { goal, currentNode: current, visits: { ...shared.visits }, vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel, index: shared.index, resumeAttempts: prior };
					const escalateReason = `cold resume of "${current}" hit the ${RESUME_ATTEMPT_CAP}-attempt cap — escalating instead of re-running`;
					return this.terminalFail(opts, shared, checkpoint, "failed", `resume poison cap: "${current}" re-ran ${RESUME_ATTEMPT_CAP}× without progress — escalated to a human`, escalateReason);
				}
				entryAttempts = prior + 1;
			}

			const index = shared.index++;
			// Entry checkpoint: "currentNode is about to run". Preserves the warm-reattach property.
			const entryCheckpoint: EngineCheckpoint = { goal, currentNode: current, visits: { ...shared.visits }, vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel, index: shared.index, resumeAttempts: entryAttempts };
			opts?.checkpoint?.(entryCheckpoint);
			this.stage(shared, index, node, "start", ctx);

			let next: string | undefined;
			if (node.kind === "parallel") {
				ctx.outcome = await this.runParallel(node, ctx, shared, opts, resuming, entryCheckpoint);
				next = this.findMerge(node);
			} else {
				await this.execute(node, ctx, resuming);
				next = this.noProgressRoute(node, ctx, shared, this.route(node, ctx));
			}
			resuming = false;

			this.stage(shared, index, node, "end", ctx);

			if (!next) {
				const ok = ctx.outcome !== "failed";
				const outcome: Outcome = ok ? "succeeded" : "failed";
				const reason = ok ? `no outgoing edge from "${current}"` : `"${current}" failed with no recovery route`;
				const checkpoint: EngineCheckpoint = { goal, currentNode: current, visits: { ...shared.visits }, vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel, index: shared.index, resumeAttempts: entryAttempts };
				return this.terminalFail(opts, shared, checkpoint, outcome, reason);
			}

			// Exit checkpoint (the second phase): "currentNode FINISHED; advance to `next`". A finished
			// node now has its successor on disk, so a cold restart never re-enters it — the only
			// re-runnable node is one that crashed between its own entry and exit checkpoints =
			// genuinely in-flight. resumeAttempts resets to 0 because the run made forward progress.
			opts?.checkpoint?.({ goal, currentNode: next, visits: { ...shared.visits }, vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel, index: shared.index, resumeAttempts: 0 });
			current = next;
		}
		const checkpoint: EngineCheckpoint = { goal, currentNode: current ?? "", visits: { ...shared.visits }, vars: { ...ctx.vars }, outcome: ctx.outcome, preferredLabel: ctx.preferredLabel, index: shared.index, resumeAttempts: 0 };
		return this.terminalFail(opts, shared, checkpoint, "failed", "ran off the end of the graph");
	}

	/**
	 * Terminal-failure escalation channel: fired at every one of the engine's four dead-end returns
	 * (visit-cap-no-overflow, poison-cap, no-recovery-route, ran-off-the-end) so a caller can persist a
	 * terminal marker exactly once regardless of which site tripped. Only fires `escalate` when the
	 * outcome is actually "failed" — the no-outgoing-edge success case shares this helper's call site
	 * but must never escalate.
	 */
	private async terminalFail(opts: RunOpts | undefined, shared: Shared, checkpoint: EngineCheckpoint, outcome: Outcome, reason: string, escalateReason: string = reason): Promise<RunResult> {
		if (outcome === "failed") await opts?.escalate?.(escalateReason, checkpoint);
		return { outcome, reason, stages: shared.stages };
	}

	/**
	 * Fan out a parallel node's branches concurrently (each a single agent node), then join.
	 * `isResume` is true exactly when this call is processing the node the run resumed onto (never on a
	 * later revisit of the same fork within one run() call, e.g. a fix-up loop) — only then is
	 * `opts.resume.branchOutcomes` honored. `entrySnapshot` is the checkpoint `run()` already emitted for
	 * this node's entry; every per-branch checkpoint below is a verbatim clone of it (plus branchOutcomes),
	 * so the poison counter, visits, and currentNode can never drift mid-fan-out.
	 */
	private async runParallel(fork: WorkflowNode, ctx: RunContext, shared: Shared, opts: RunOpts | undefined, isResume: boolean, entrySnapshot: EngineCheckpoint): Promise<Outcome> {
		const branchIds = this.wf.edges.filter((e) => e.from === fork.id).map((e) => e.to);
		const policy = fork.attrs.join_policy === "first_success" ? "first_success" : "wait_all";
		const maxParallel = fork.attrs.max_parallel ? Math.max(1, Number.parseInt(fork.attrs.max_parallel, 10) || 4) : 4;

		// Deterministic, runId-free per-branch identity: stable across a fork (which mints a new runId)
		// and across a resume of this exact fan-out (the fork node's visit count doesn't change mid-fan-out).
		const visitIndex = shared.visits[fork.id] ?? 0;
		const branchKeys = branchIds.map((_, i) => `${fork.id}#${visitIndex}:${i}`);

		const recorded = isResume ? opts?.resume?.branchOutcomes : undefined;
		const branchOutcomes: Record<string, BranchOutcome> = {};
		for (const key of branchKeys) branchOutcomes[key] = recorded?.[key] ?? { disposition: "not_attempted", at: Date.now() };

		const emitBranchCheckpoint = (): void => {
			opts?.checkpoint?.({ ...entrySnapshot, transient: true, branchOutcomes: { ...branchOutcomes } });
		};

		// A recorded winner from before a crash means this fan-out already resolved — never re-spawn.
		if (policy === "first_success" && branchKeys.some((k) => branchOutcomes[k]!.disposition === "succeeded")) {
			ctx.vars.parallelResults = JSON.stringify(branchIds.map((id, i) => ({ branch: id, outcome: branchOutcomes[branchKeys[i]!]!.disposition, text: branchOutcomes[branchKeys[i]!]!.text })));
			return "succeeded";
		}

		// One controller per fan-out. Aborting it signals every in-flight branch agent to stop, so a
		// first_success win tears down the losers, and a thrown branch executor tears down its siblings
		// instead of leaving them running detached in their worktrees (the leak this guards against).
		const controller = new AbortController();
		const results = new Array<NodeResult | undefined>(branchIds.length);

		const runOne = async (bid: string, key: string): Promise<NodeResult> => {
			const bn = this.wf.nodes.get(bid);
			if (!bn) return { outcome: "failed" };
			const limit = bn.maxVisits ?? shared.cap;
			if ((shared.visits[bid] ?? 0) >= limit) return { outcome: "failed" };
			shared.visits[bid] = (shared.visits[bid] ?? 0) + 1;
			const index = shared.index++;
			this.stage(shared, index, bn, "start", ctx);
			// Each branch gets an isolated context fork (fabro semantics).
			const branchCtx: RunContext = { goal: ctx.goal, vars: { ...ctx.vars } };
			let r: NodeResult;
			try {
				r = this.executor.runBranch ? await this.executor.runBranch(bn, branchCtx, controller.signal, key) : await this.executor.runAgent(bn, branchCtx);
			} catch {
				// A branch executor that rejected (e.g. its spawn crashed) fails just this branch — never
				// the whole run. Abort the controller so any sibling agent already in flight is torn down
				// rather than orphaned: a Promise.all rejection here would lose those handles entirely.
				// The rejection was never a genuine execution, so it's re-spawnable on resume.
				controller.abort();
				r = { outcome: "failed", notAttempted: true };
			}
			branchCtx.outcome = r.outcome;
			if (r.text !== undefined) branchCtx.vars.lastText = r.text;
			this.stage(shared, index, bn, "end", branchCtx);
			return r;
		};

		// Only branches that weren't already resolved on a resumed pass are actually run.
		const toRun = branchIds.map((_, i) => i).filter((i) => branchOutcomes[branchKeys[i]!]!.disposition === "not_attempted");

		// Bounded concurrency: at most `maxParallel` branches in flight. For first_success the join
		// resolves the instant one branch succeeds — we abort the rest and stop pulling new work, so
		// the merge never blocks on the slowest/hung loser.
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < toRun.length && !controller.signal.aborted) {
				const idx = toRun[cursor++]!;
				const r = await runOne(branchIds[idx]!, branchKeys[idx]!);
				results[idx] = r;
				// A genuinely-executed result (including the 30-min turn timeout) records its real outcome;
				// ceiling/WIP refusals, aborts, and spawn crashes record not_attempted so resume re-spawns them.
				branchOutcomes[branchKeys[idx]!] = { disposition: r.notAttempted ? "not_attempted" : r.outcome, text: r.text, at: Date.now() };
				emitBranchCheckpoint();
				if (policy === "first_success" && r.outcome === "succeeded" && !r.notAttempted) controller.abort();
			}
		};
		await Promise.all(Array.from({ length: Math.min(maxParallel, toRun.length) }, () => worker()));

		// Fold recorded (resumed) dispositions back into results for branches this pass never ran.
		for (let i = 0; i < branchIds.length; i++) {
			if (results[i] !== undefined) continue;
			const rec = branchOutcomes[branchKeys[i]!]!;
			results[i] = { outcome: rec.disposition === "succeeded" ? "succeeded" : "failed", text: rec.text };
		}

		// Branches short-circuited before they ever ran count as failed for the record.
		const final = branchIds.map((_, i) => results[i] ?? { outcome: "failed" as Outcome });
		ctx.vars.parallelResults = JSON.stringify(branchIds.map((id, i) => ({ branch: id, outcome: final[i]!.outcome, text: final[i]!.text })));
		const succeeded = final.filter((r) => r.outcome === "succeeded").length;
		if (policy === "first_success") return succeeded > 0 ? "succeeded" : "failed";
		return final.length > 0 && succeeded === final.length ? "succeeded" : "failed";
	}

	/** The single merge node that parallel branches converge on. */
	private findMerge(fork: WorkflowNode): string | undefined {
		const merges = [...this.wf.nodes.values()].filter((n) => n.kind === "merge");
		if (merges.length !== 1) throw new Error(`parallel node "${fork.id}" needs exactly one merge node (found ${merges.length})`);
		return merges[0]!.id;
	}

	private stage(shared: Shared, index: number, node: WorkflowNode, phase: "start" | "end", ctx: RunContext): void {
		const ev: StageEvent = { index, nodeId: node.id, label: node.label ?? node.id, kind: node.kind, phase, outcome: phase === "end" ? ctx.outcome : undefined, text: phase === "end" ? ctx.vars.lastText : undefined };
		shared.stages.push(ev);
		this.executor.onStage?.(ev);
	}

	private async execute(node: WorkflowNode, ctx: RunContext, resume = false): Promise<void> {
		if (node.attrs.action) {
			if (!this.executor.runAction) throw new Error(`node "${node.id}" has action="${node.attrs.action}" but the executor has no runAction`);
			const r = await this.executor.runAction(node, ctx);
			ctx.outcome = r.outcome;
			if (r.text !== undefined) ctx.vars.lastText = r.text;
			return;
		}
		switch (node.kind) {
			case "start":
			case "conditional":
				ctx.outcome = ctx.outcome ?? "succeeded";
				return;
			case "agent":
			case "prompt": {
				const r = resume && this.executor.resumeAgent ? await this.executor.resumeAgent(node, ctx) : await this.executor.runAgent(node, ctx);
				ctx.outcome = r.outcome;
				if (r.text !== undefined) ctx.vars.lastText = r.text;
				return;
			}
			case "command": {
				const r = await this.executor.runCommand(node, ctx);
				ctx.outcome = r.outcome;
				if (r.text !== undefined) {
					ctx.vars.lastText = r.text;
					ctx.vars.lastOutput = r.text;
				}
				return;
			}
			case "human": {
				const options = this.wf.edges.filter((e) => e.from === node.id && e.label).map((e) => e.label!);
				if (options.length === 0) throw new Error(`human node "${node.id}" has no labeled outgoing edges`);
				ctx.preferredLabel = await this.executor.humanGate(node, options, ctx);
				ctx.outcome = "succeeded";
				return;
			}
			case "merge":
				// Pass-through: the join outcome (from runParallel) flows on to routing.
				ctx.outcome = ctx.outcome ?? "succeeded";
				return;
			case "parallel":
			case "wait":
				throw new Error(`node kind "${node.kind}" is not executed here: "${node.id}"`);
		}
	}

	private route(node: WorkflowNode, ctx: RunContext): string | undefined {
		const outs = this.wf.edges.filter((e) => e.from === node.id);

		if (node.kind === "human") {
			const chosen = outs.find((e) => e.label === ctx.preferredLabel);
			return chosen?.to;
		}

		let fallback: string | undefined;
		for (const e of outs) {
			if (!e.condition) {
				fallback ??= e.to;
				continue;
			}
			if (evalCondition(e.condition, ctx)) return e.to;
		}
		if (node.goalGate && node.retryTarget && ctx.outcome === "failed") return node.retryTarget;
		if (fallback !== undefined) return fallback;
		return undefined;
	}

	/**
	 * No-progress short-circuit. A goal-gate node that just FAILED with output identical to its
	 * previous visit isn't advancing — the fix-up loop is reproducing the same error. Skip the
	 * remaining retry budget and cascade through the retry tier's overflow chain
	 * (codefix → fixup → escalate), jumping to the FIRST tier that hasn't run yet. If every tier in
	 * the chain has already been tried we're genuinely stuck, so fail outright (return undefined).
	 * When the retry tier has no overflow chain at all, this is a no-op: the normal bounded loop stands.
	 */
	private noProgressRoute(node: WorkflowNode, ctx: RunContext, shared: Shared, next: string | undefined): string | undefined {
		if (!node.goalGate || ctx.outcome !== "failed") return next;
		// Normalize with identityNormalize (output-reduce.ts, noisegate-compaction concern 03) before
		// the exact-equality check: a >budget failing output now travels through runCommand's
		// reduceOutput, which appends an offload pointer carrying a FRESH ts+nonce on every single
		// reduction, so a trim-only compare would see two DIFFERENT strings for the exact same
		// reproduced error on every visit and this short-circuit would never fire (red-team RT2-1).
		// identityNormalize strips that pointer line plus ANSI and bun's per-test `[N.NNms]` duration
		// jitter, so two visits of the SAME failure compare equal while two GENUINELY different
		// failures still compare different. Deliberate improvement for small (non-reduced) outputs too
		// — the old trim-only comparator was already defeated by bun's own timing jitter on every visit.
		const current = identityNormalize(ctx.vars.lastOutput ?? "").trim();
		const previous = shared.goalOutputs[node.id];
		shared.goalOutputs[node.id] = current;
		if (previous === undefined || previous !== current) return next; // first visit, or progress made
		const start = node.retryTarget ? this.wf.nodes.get(node.retryTarget)?.overflow : undefined;
		if (!start) return next; // retry tier has no overflow chain → keep the normal bounded loop
		// Identical failure: skip the wasted retries and walk the overflow chain to the first untried tier.
		for (let tier: string | undefined = start; tier; tier = this.wf.nodes.get(tier)?.overflow) {
			if ((shared.visits[tier] ?? 0) === 0) return tier;
		}
		return undefined; // every tier in the chain has run and we're still stuck → terminal fail
	}
}

/**
 * Evaluate a fabro-style edge condition against the run context.
 * Grammar: OR of AND of atoms; atom = `lhs (= | == | !=) rhs`.
 * `lhs` resolves `outcome`, `preferred_label`, `context.<name>`, or a bare var;
 * `rhs` is a literal (quotes optional). Anything unparsable is treated as false.
 */
export function evalCondition(cond: string, ctx: RunContext): boolean {
	return cond.split("||").some((clause) =>
		clause.split("&&").every((atomSrc) => {
			const atom = atomSrc.trim();
			if (!atom) return false;
			const neq = atom.includes("!=");
			const [lhsRaw, rhsRaw] = atom.split(neq ? "!=" : /==|=/, 2);
			if (rhsRaw === undefined) return false;
			const lhs = lhsRaw!.trim();
			const rhs = rhsRaw.trim().replace(/^"(.*)"$/, "$1");
			let actual: string | undefined;
			if (lhs === "outcome") actual = ctx.outcome;
			else if (lhs === "preferred_label") actual = ctx.preferredLabel;
			else if (lhs.startsWith("context.")) actual = ctx.vars[lhs.slice("context.".length)];
			else actual = ctx.vars[lhs];
			return neq ? actual !== rhs : actual === rhs;
		}),
	);
}
