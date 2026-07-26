import type { LearningStateRecord, NodeRecord } from "./node-records.ts";

/** The day-one defaults are explicit policies, never silent fallbacks. */
export const borrowedDefaults = [
	{ id: "main-merge", sentence: "Nobody merges anything to main without you, whatever the change is.", reversal: "Withdraw this default in one action when you say what may merge without you." },
	{ id: "reversible-choice", sentence: "When two reversible options exist, an agent asks you rather than choosing.", reversal: "Turn this off in one action when you say which reversible choices it may make." },
	{ id: "stall-mention", sentence: "A plan that has not moved for two hours gets mentioned once, in the conversation.", reversal: "Replace this guess in one action with your fleet's measured normal." },
	{ id: "external-notification", sentence: "Nothing leaves this app unless you say it may.", reversal: "Withdraw this default in one action with your own notification rule." },
	{ id: "explanation-detail", sentence: "Every agent explains what it did in words, at some length, for the first week.", reversal: "Turn this down in one action when you say how much detail you want." },
	{ id: "decision-context", sentence: "Questions include the decision, the evidence, and the nearest reversible option.", reversal: "Replace this default in one action with the context you want before answering." },
] as const;

/**
 * Facts the product must keep admitting until evidence settles them. The proposal floor is attached
 * to the unknown itself: a rule cannot claim confidence from fewer decisions than the ledger demands.
 */
export const unknownLedger = [
	{
		id: "plan-normal",
		statement: "How long anything normally takes here, so it cannot tell a stall from ordinary slow work.",
		settlingEvidence: "About a week of a plan running.",
		requiredSampleSize: 5,
		costOfNotKnowing: "The product mentions a guessed stall once instead of claiming ordinary slow work is stuck.",
		proposalSubjects: [],
	},
	{
		id: "decision-preferences",
		statement: "Which decisions you care about, so it cannot widen anything on its own yet.",
		settlingEvidence: "Five answers to the same question, all with the same answer.",
		requiredSampleSize: 5,
		costOfNotKnowing: "Reversible decisions keep reaching you until your own sentence replaces the borrowed default.",
		proposalSubjects: ["*"],
	},
	{
		id: "agent-records",
		statement: "Whether any agent is good at anything in this codebase.",
		settlingEvidence: "Thirty completed units for each agent and role.",
		requiredSampleSize: 30,
		costOfNotKnowing: "No agent is trusted with more work because a score guessed from too little evidence would be a false promise.",
		proposalSubjects: [],
	},
	{
		id: "repository-danger",
		statement: "What is dangerous in this repository beyond what the code says.",
		settlingEvidence: "A human sentence naming the risk and the convention it requires.",
		requiredSampleSize: 1,
		costOfNotKnowing: "The fleet asks rather than treating silence as permission around risks the code cannot reveal.",
		proposalSubjects: [],
	},
	{
		id: "out-of-hours",
		statement: "Anything about your evenings, your week, or what is urgent to you.",
		settlingEvidence: "One answer, in your own words, to the out-of-hours question.",
		requiredSampleSize: 1,
		costOfNotKnowing: "Nothing leaves the app; everything waits for the morning rather than guessing about your evenings.",
		proposalSubjects: [],
	},
] as const;

export function coldStartLearningState(nodeId: string, createdAt: number): LearningStateRecord {
	return {
		id: `learning-state:${nodeId}`,
		nodeId,
		createdAt,
		kind: "learning-state",
		borrowedDefaults: borrowedDefaults.map((rule) => ({ ...rule, status: "borrowed" })),
		outOfHoursContact: "unset",
		unknowns: unknownLedger.map((unknown) => ({ ...unknown, proposalSubjects: [...unknown.proposalSubjects] })),
	};
}

/** The ledger, not a caller preference, sets the evidence floor for each proposal. */
export function proposalSampleFloor(records: readonly NodeRecord[], subject: string): number | undefined {
	const floors = records
		.filter((record): record is LearningStateRecord => record.kind === "learning-state")
		.flatMap((record) => record.unknowns)
		.filter((unknown) => unknown.settledAt === undefined && (unknown.proposalSubjects.includes("*") || unknown.proposalSubjects.includes(subject)))
		.map((unknown) => unknown.requiredSampleSize);
	return floors.length === 0 ? undefined : Math.max(...floors);
}
