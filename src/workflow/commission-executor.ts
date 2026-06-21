/**
 * CommissionExecutor — drives the commission graph (author → validate → onboard)
 * by binding its `action` nodes to the manager's domain hooks. It proves the
 * workflow engine generalizes past agent/shell nodes: the same pure engine that
 * runs a plan-implement graph runs the hire-a-worker loop, including the bounded
 * re-author-on-gate-failure cycle the hand-coded commission() never had.
 *
 * The commission graph uses ONLY action nodes, so runAgent/runCommand/humanGate
 * are never reached — they throw to make a mis-authored graph fail loudly.
 */

import type { AgentDTO, GateReport } from "../types.ts";
import type { NodeExecutor, NodeResult, RunContext, WorkflowNode } from "./types.ts";

export interface CommissionHooks {
	/** Author the worker into its dir. `feedback` carries the prior gate failure on a retry. */
	author: (feedback?: string) => Promise<void>;
	/** Optional one-time dependency install (enables the typecheck/acceptance gate tiers). */
	install?: () => Promise<void>;
	/** Run the acceptance gate. */
	validate: () => Promise<GateReport>;
	/** Onboard the validated worker as a fleet member. */
	onboard: (report: GateReport) => Promise<AgentDTO>;
}

export class CommissionExecutor implements NodeExecutor {
	/** Latest gate report (the candidate's interview result). */
	report?: GateReport;
	/** The onboarded member, set iff the run reached onboard. */
	member?: AgentDTO;

	private readonly hooks: CommissionHooks;
	private installed = false;

	constructor(hooks: CommissionHooks) {
		this.hooks = hooks;
	}

	async runAction(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		switch (node.attrs.action) {
			case "author": {
				const prior = this.report;
				const feedback =
					prior && !prior.ok
						? `A previous attempt failed the acceptance gate: ${prior.checks.map((c) => `${c.name}=${c.status}`).join(", ")}.${prior.checks.find((c) => c.status === "fail")?.detail ? ` Details: ${prior.checks.find((c) => c.status === "fail")?.detail}` : ""} Fix these issues.`
						: undefined;
				await this.hooks.author(feedback);
				return { outcome: "succeeded" };
			}
			case "validate": {
				if (this.hooks.install && !this.installed) {
					await this.hooks.install();
					this.installed = true;
				}
				this.report = await this.hooks.validate();
				return { outcome: this.report.ok ? "succeeded" : "failed", text: this.report.checks.map((c) => `${c.name}=${c.status}`).join(" ") };
			}
			case "onboard": {
				if (!this.report) return { outcome: "failed", text: "no gate report" };
				this.member = await this.hooks.onboard(this.report);
				return { outcome: "succeeded" };
			}
			default:
				throw new Error(`unknown commission action "${node.attrs.action ?? ""}"`);
		}
	}

	runAgent(): Promise<NodeResult> {
		throw new Error("commission graph uses action nodes only (no agent nodes)");
	}
	runCommand(): Promise<NodeResult> {
		throw new Error("commission graph uses action nodes only (no command nodes)");
	}
	humanGate(): Promise<string> {
		throw new Error("commission graph has no human gates");
	}
}
