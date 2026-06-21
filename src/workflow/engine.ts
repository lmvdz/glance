/**
 * WorkflowEngine — walks a parsed workflow graph, delegating execution to a
 * NodeExecutor. The engine is pure orchestration: routing, conditions, visit
 * caps, goal-gate failure handling, human-gate pausing, and stage emission. It
 * knows nothing about omp, processes, or the fleet — that lives in executors.
 *
 * Routing per node:
 *   - human node     → take the edge whose label equals the chosen option;
 *   - everything else→ first edge whose `condition` is true, else the first
 *                      unconditioned edge (the fallback);
 *   - goal-gate node that failed with no matching edge → its `retry_target`.
 * A node that would exceed its visit cap cannot run again; if nothing else routes
 * the run, it fails (this is what bounds fix-up loops).
 */

import type { NodeExecutor, Outcome, RunContext, RunResult, StageEvent, Workflow, WorkflowNode } from "./types.ts";

const DEFAULT_NODE_VISITS = 50;

/** Run-wide mutable state threaded through the walk and concurrent branches. */
interface Shared {
	visits: Record<string, number>;
	stages: StageEvent[];
	cap: number;
	index: number;
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

	async run(goal: string): Promise<RunResult> {
		const ctx: RunContext = { goal, vars: {} };
		const shared: Shared = { visits: {}, stages: [], cap: this.wf.maxNodeVisits ?? DEFAULT_NODE_VISITS, index: 0 };

		let current: string | undefined = this.wf.start;
		while (current) {
			if (this.cancelled) throw new WorkflowCancelled();
			const node = this.wf.nodes.get(current);
			if (!node) return { outcome: "failed", reason: `dangling edge to unknown node "${current}"`, stages: shared.stages };
			if (node.kind === "exit") return { outcome: "succeeded", reason: "reached exit", stages: shared.stages };

			const limit = node.maxVisits ?? shared.cap;
			if ((shared.visits[current] ?? 0) >= limit) {
				return { outcome: "failed", reason: `node "${current}" exceeded its visit cap (${limit})`, stages: shared.stages };
			}
			shared.visits[current] = (shared.visits[current] ?? 0) + 1;

			const index = shared.index++;
			this.stage(shared, index, node, "start", ctx);

			let next: string | undefined;
			if (node.kind === "parallel") {
				ctx.outcome = await this.runParallel(node, ctx, shared);
				next = this.findMerge(node);
			} else {
				await this.execute(node, ctx);
				next = this.route(node, ctx);
			}

			this.stage(shared, index, node, "end", ctx);

			if (!next) {
				const ok = ctx.outcome !== "failed";
				return { outcome: ok ? "succeeded" : "failed", reason: ok ? `no outgoing edge from "${current}"` : `"${current}" failed with no recovery route`, stages: shared.stages };
			}
			current = next;
		}
		return { outcome: "failed", reason: "ran off the end of the graph", stages: shared.stages };
	}

	/** Fan out a parallel node's branches concurrently (each a single agent node), then join. */
	private async runParallel(fork: WorkflowNode, ctx: RunContext, shared: Shared): Promise<Outcome> {
		const branchIds = this.wf.edges.filter((e) => e.from === fork.id).map((e) => e.to);
		const policy = fork.attrs.join_policy === "first_success" ? "first_success" : "wait_all";
		const maxParallel = fork.attrs.max_parallel ? Math.max(1, Number.parseInt(fork.attrs.max_parallel, 10) || 4) : 4;

		const runOne = async (bid: string): Promise<Outcome> => {
			const bn = this.wf.nodes.get(bid);
			if (!bn) return "failed";
			const limit = bn.maxVisits ?? shared.cap;
			if ((shared.visits[bid] ?? 0) >= limit) return "failed";
			shared.visits[bid] = (shared.visits[bid] ?? 0) + 1;
			const index = shared.index++;
			this.stage(shared, index, bn, "start", ctx);
			// Each branch gets an isolated context fork (fabro semantics).
			const branchCtx: RunContext = { goal: ctx.goal, vars: { ...ctx.vars } };
			const r = this.executor.runBranch ? await this.executor.runBranch(bn, branchCtx) : await this.executor.runAgent(bn, branchCtx);
			branchCtx.outcome = r.outcome;
			if (r.text !== undefined) branchCtx.vars.lastText = r.text;
			this.stage(shared, index, bn, "end", branchCtx);
			return r.outcome;
		};

		const outcomes = await this.runBounded(branchIds, maxParallel, runOne);
		ctx.vars.parallelResults = JSON.stringify(branchIds.map((id, i) => ({ branch: id, outcome: outcomes[i] })));
		const succeeded = outcomes.filter((o) => o === "succeeded").length;
		if (policy === "first_success") return succeeded > 0 ? "succeeded" : "failed";
		return outcomes.length > 0 && succeeded === outcomes.length ? "succeeded" : "failed";
	}

	/** The single merge node that parallel branches converge on. */
	private findMerge(fork: WorkflowNode): string | undefined {
		const merges = [...this.wf.nodes.values()].filter((n) => n.kind === "merge");
		if (merges.length !== 1) throw new Error(`parallel node "${fork.id}" needs exactly one merge node (found ${merges.length})`);
		return merges[0]!.id;
	}

	/** Run `fn` over items with at most `limit` in flight, preserving input order in the results. */
	private async runBounded<T>(items: string[], limit: number, fn: (item: string) => Promise<T>): Promise<T[]> {
		const results = new Array<T>(items.length);
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < items.length) {
				const idx = cursor++;
				results[idx] = await fn(items[idx]!);
			}
		};
		await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
		return results;
	}

	private stage(shared: Shared, index: number, node: WorkflowNode, phase: "start" | "end", ctx: RunContext): void {
		const ev: StageEvent = { index, nodeId: node.id, label: node.label ?? node.id, kind: node.kind, phase, outcome: phase === "end" ? ctx.outcome : undefined, text: phase === "end" ? ctx.vars.lastText : undefined };
		shared.stages.push(ev);
		this.executor.onStage?.(ev);
	}

	private async execute(node: WorkflowNode, ctx: RunContext): Promise<void> {
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
				const r = await this.executor.runAgent(node, ctx);
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
		if (fallback !== undefined) return fallback;
		if (node.goalGate && node.retryTarget && ctx.outcome === "failed") return node.retryTarget;
		return undefined;
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
