import type { PlanMotionRecord } from "./node-records.ts";

/** Meaningful work observed in one unit that belongs to a plan. */
export interface PlanMotionUnit {
	readonly id: string;
	readonly movementsAt: readonly number[];
	readonly blockedCause?: string;
	readonly eligibleSuccessor: boolean;
}

export interface PlanMotionInput {
	readonly planId: string;
	readonly planTitle: string;
	readonly units: readonly PlanMotionUnit[];
	readonly now: number;
	readonly parked?: boolean;
	readonly intentionalStill?: boolean;
	readonly unaffectedPlanTitles?: readonly string[];
}

export interface PlanMotionAssessment {
	readonly record: Omit<PlanMotionRecord, "id" | "nodeId" | "createdAt">;
	readonly stalled: boolean;
	readonly recoveryOptions: readonly string[];
	readonly message?: string;
}

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

function latestMovement(units: readonly PlanMotionUnit[]): number | undefined {
	return units.flatMap((unit) => unit.movementsAt).reduce<number | undefined>((latest, at) => latest === undefined || at > latest ? at : latest, undefined);
}

function observedGaps(units: readonly PlanMotionUnit[]): number[] {
	return units.flatMap((unit) => {
		const movements = [...unit.movementsAt].sort((a, b) => a - b);
		return movements.slice(1).map((at, index) => at - movements[index]!).filter((gap) => gap > 0);
	});
}

function duration(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const minutes = Math.max(1, Math.floor(ms / 60_000));
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Compare a plan only with its own retained movements. A plan is still when its current gap exceeds
 * every observed gap from its own units; there is deliberately no fleet-wide timeout hidden here.
 */
export function assessPlanMotion(input: PlanMotionInput): PlanMotionAssessment {
	const parked = input.parked === true;
	const intentionalStill = input.intentionalStill === true;
	const lastMeaningfulMovementAt = latestMovement(input.units) ?? input.now;
	const gaps = observedGaps(input.units);
	const baselineMs = median(gaps);
	const longestObservedGap = gaps.length === 0 ? undefined : Math.max(...gaps);
	const blockedUnits = input.units.filter((unit) => unit.blockedCause);
	const blockedCause = blockedUnits.map((unit) => unit.blockedCause).find((cause): cause is string => Boolean(cause));
	const eligibleSuccessorCount = input.units.filter((unit) => unit.eligibleSuccessor).length;
	const currentGap = Math.max(0, input.now - lastMeaningfulMovementAt);
	const stalled = !parked && !intentionalStill && longestObservedGap !== undefined && currentGap > longestObservedGap;
	const unaffected = input.unaffectedPlanTitles?.length ? ` Nothing else is affected: ${input.unaffectedPlanTitles.join(", ")} are still moving.` : " Nothing else is affected outside this plan.";
	const recoveryOptions = [
		`Resume the blocked work${eligibleSuccessorCount > 0 ? ` with one of ${eligibleSuccessorCount} eligible successors` : " after resolving its cause"}; the plan can move again.`,
		"Park the plan; that records that its stillness is deliberate and it will not be raised again until unparked.",
		"Drop the plan; that closes this work instead of leaving it to look active.",
	] as const;
	const message = stalled && baselineMs !== undefined
		? `${input.planTitle} has not moved for ${duration(currentGap)}. ${blockedCause ?? "No unit has recorded a cause"}; ${eligibleSuccessorCount === 0 ? "no eligible successor can pick it up" : `${eligibleSuccessorCount} eligible successor${eligibleSuccessorCount === 1 ? " is" : "s are"} available`}. This plan normally moves every ${duration(baselineMs)}, measured from its own ${input.units.length} units — not a threshold anyone set.${unaffected} Recovery: ${recoveryOptions.join(" ")}`
		: undefined;
	return {
		record: {
			kind: "plan-motion",
			lastMeaningfulMovementAt,
			baselineMs: parked || intentionalStill ? undefined : baselineMs,
			baselineSampleSize: input.units.length,
			parked,
			intentionalStill,
			blockedCause,
			eligibleSuccessorCount,
		},
		stalled,
		recoveryOptions,
		message,
	};
}

export function planMotionMetrics(records: readonly PlanMotionRecord[], now: number, windowMs = 8 * 7 * 24 * 60 * 60 * 1000): { noticed: number; falsePositive: number } {
	const recent = records.filter((record) => record.createdAt >= now - windowMs);
	return {
		noticed: recent.filter((record) => record.noticedAt !== undefined).length,
		falsePositive: recent.filter((record) => record.outcome === "false-positive").length,
	};
}
