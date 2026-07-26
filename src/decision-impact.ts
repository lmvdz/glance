/**
 * decision-impact.ts — what a decision cost, and what undoing it would cost.
 *
 * Two questions a person actually asks, and one rule about when to answer them.
 *
 * **"What would it take to undo this?"** Undoing 3.2 is not undoing 3.2 alone if 3.3 built on it, so
 * reversal cost is dependency-aware or it is a lie of omission. And an element that cannot be undone
 * is named with its NEAREST REPAIR rather than marked impossible: "the tag cannot be unpublished; the
 * repair is a superseding release" is something a person can act on, and "irreversible" is not.
 *
 * **"What did that cost?"** Spend and waste are different facts. Four agents idling for 46 minutes
 * because an interruption arrived is a cost with a cause, and the cause is the part worth keeping —
 * spend without attribution is a number nobody can act on.
 *
 * **When to say it.** Cost is disclosed only where it changes the decision. A running ticker on every
 * screen is how people learn to stop reading numbers, and then the one number that mattered goes past
 * unread too.
 *
 * Everything here reads from the retained records of concern 17. Reconstructing cost from logs after
 * the fact is exactly the fragility this concern exists to remove: by then the evidence has been
 * compacted, and what is left is a plausible story rather than a record.
 */

import type { NodeRecord } from "./node-records.ts";

/** One piece of work in the dependency graph, for reversal purposes. */
export interface ReversalNode {
	id: string;
	address: string;
	title: string;
	/** Addresses of work that built ON this one. Undoing this means facing these too. */
	dependents: string[];
	/** Set when this element cannot be undone. Carries the nearest thing to a repair. */
	irreversible?: { what: string; nearestRepair: string };
	/** Rough effort to undo, when known and reversible. */
	undoMinutes?: number;
}

export interface ReversalAssessment {
	/** Everything that must be faced, in the order a person would face it. */
	touched: ReversalNode[];
	/** The subset that cannot be undone, each with its nearest repair. */
	irreversible: ReversalNode[];
	totalUndoMinutes: number;
	/** Whether any part of the cost is unknown rather than zero. */
	incomplete: boolean;
	sentence: string;
}

/**
 * What undoing one node would actually take, following dependents transitively.
 *
 * Cycles are tolerated rather than fatal: a graph that has one is already wrong, but refusing to
 * answer would leave a person with no estimate at all at exactly the moment they need one.
 */
export function assessReversal(nodes: readonly ReversalNode[], startAddress: string): ReversalAssessment {
	const byAddress = new Map(nodes.map((node) => [node.address, node]));
	const seen = new Set<string>();
	const touched: ReversalNode[] = [];
	const walk = (address: string): void => {
		if (seen.has(address)) return;
		seen.add(address);
		const node = byAddress.get(address);
		if (!node) return;
		touched.push(node);
		for (const dependent of node.dependents) walk(dependent);
	};
	walk(startAddress);

	const irreversible = touched.filter((node) => node.irreversible);
	// A node with no recorded estimate is UNKNOWN, not free. Summing it as zero would understate the
	// cost of exactly the work nobody has looked at closely.
	const incomplete = touched.some((node) => !node.irreversible && node.undoMinutes === undefined);
	const totalUndoMinutes = touched.reduce((sum, node) => sum + (node.undoMinutes ?? 0), 0);

	return { touched, irreversible, totalUndoMinutes, incomplete, sentence: reversalSentence(startAddress, touched, irreversible, totalUndoMinutes, incomplete) };
}

function reversalSentence(start: string, touched: readonly ReversalNode[], irreversible: readonly ReversalNode[], minutes: number, incomplete: boolean): string {
	const others = touched.length - 1;
	const head =
		others === 0
			? `Undoing ${start} means undoing ${start}. Nothing was built on it.`
			: `Undoing ${start} means facing ${others} other ${others === 1 ? "piece" : "pieces"} of work that were built on it: ${touched.slice(1, 4).map((n) => n.address).join(", ")}${others > 3 ? ", and more" : ""}.`;

	const effort = incomplete
		? ` At least ${minutes} minutes of work to reverse, and some of it has never been estimated — treat that as unknown, not as free.`
		: ` About ${minutes} minutes of work to reverse.`;

	if (irreversible.length === 0) return `${head}${effort} All of it can be undone.`;
	const repairs = irreversible.map((node) => `${node.irreversible!.what} cannot be undone; the repair is ${node.irreversible!.nearestRepair}`).join(". ");
	return `${head}${effort} ${repairs}.`;
}

// ── Spend, waste, and their causes ───────────────────────────────────────────

export interface CostEvent {
	/** Cents. Kept as an integer so nothing rounds away silently. */
	cents: number;
	/** Set when this spend produced nothing, WITH the reason it produced nothing. */
	wastedBecause?: string;
	/** Agents idled by whatever caused the waste. */
	idledAgents?: number;
	idledMinutes?: number;
}

export interface CostSummary {
	spentCents: number;
	wastedCents: number;
	/** Waste grouped by its stated cause, largest first. Unattributed waste is its own bucket. */
	byCause: Array<{ cause: string; cents: number; idledAgents: number; idledMinutes: number }>;
	sentence: string;
}

/**
 * Spend split from waste, with the waste attributed.
 *
 * Waste with no stated cause is kept as its own bucket rather than folded into the total, because
 * "£40 wasted" with nothing to point at is a number that makes a person feel bad and teaches them
 * nothing. Naming the unattributed portion is what makes it a question someone can chase.
 */
export function summariseCost(events: readonly CostEvent[]): CostSummary {
	const spentCents = events.reduce((sum, event) => sum + event.cents, 0);
	const wasted = events.filter((event) => event.wastedBecause !== undefined);
	const wastedCents = wasted.reduce((sum, event) => sum + event.cents, 0);

	const buckets = new Map<string, { cents: number; idledAgents: number; idledMinutes: number }>();
	for (const event of wasted) {
		const cause = event.wastedBecause?.trim() || "no cause was recorded";
		const bucket = buckets.get(cause) ?? { cents: 0, idledAgents: 0, idledMinutes: 0 };
		bucket.cents += event.cents;
		bucket.idledAgents += event.idledAgents ?? 0;
		bucket.idledMinutes += event.idledMinutes ?? 0;
		buckets.set(cause, bucket);
	}
	const byCause = [...buckets.entries()]
		.map(([cause, bucket]) => ({ cause, ...bucket }))
		.sort((a, b) => b.cents - a.cents || a.cause.localeCompare(b.cause));

	return { spentCents, wastedCents, byCause, sentence: costSentence(spentCents, wastedCents, byCause) };
}

function money(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

function costSentence(spent: number, wasted: number, byCause: CostSummary["byCause"]): string {
	if (spent === 0) return "Nothing has been spent on this yet.";
	if (wasted === 0) return `${money(spent)} spent, and none of it was wasted.`;
	const top = byCause[0];
	const idle =
		top && top.idledAgents > 0
			? ` ${top.idledAgents} agent${top.idledAgents === 1 ? "" : "s"} sat idle for ${top.idledMinutes} minutes waiting.`
			: "";
	return `${money(spent)} spent, ${money(wasted)} of it wasted — the largest part because ${top?.cause ?? "no cause was recorded"}.${idle}`;
}

/**
 * Whether to show a cost at all.
 *
 * The rule that makes the rest of this module useful: a number shown everywhere is a number nobody
 * reads. Cost belongs next to a choice it should influence — where a cheaper option exists, or where
 * the amount is large enough that a person would want to stop. Everywhere else it is decoration that
 * trains people to look past exactly the figure that mattered.
 */
export function shouldDiscloseCost(context: {
	/** True when the person is choosing between options with different costs. */
	changesTheDecision: boolean;
	cents: number;
	/** Above this, say it whether or not there is a choice — it is worth interrupting for. */
	notableCents?: number;
}): boolean {
	if (context.changesTheDecision) return true;
	return context.cents >= (context.notableCents ?? 5_000);
}

/** Cost events recovered from a node's retained records (concern 17), never from logs. */
export function costEventsFrom(records: readonly NodeRecord[]): CostEvent[] {
	return records.flatMap((record) =>
		record.kind === "evidence" && record.claim.startsWith("cost:")
			? [{ cents: Number.parseInt(record.claim.slice(5), 10) || 0 }]
			: [],
	);
}
