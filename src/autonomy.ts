import type { ApprovalMode } from "./types.ts";

export type AutonomyMode = "observe" | "assist" | "autodrive";
export type VerificationState = "unknown" | "none" | "failed" | "stale" | "fresh";
export type AgentAction = "prompt" | "answer" | "interrupt" | "verify" | "land" | "set-mode";

export interface AutonomyPolicyInput {
	requested: AutonomyMode;
	approvalMode: ApprovalMode;
	autoLand: boolean;
	landConfirm: boolean;
	blockedReason?: string;
}

const rank: Record<AutonomyMode, number> = { observe: 0, assist: 1, autodrive: 2 };
const byRank: AutonomyMode[] = ["observe", "assist", "autodrive"];

export function modeFromApproval(approvalMode: ApprovalMode): AutonomyMode {
	if (approvalMode === "always-ask") return "observe";
	if (approvalMode === "yolo") return "autodrive";
	return "assist";
}

export function maxEffectiveMode(input: Pick<AutonomyPolicyInput, "approvalMode" | "autoLand" | "landConfirm">): AutonomyMode {
	const approvalCap = modeFromApproval(input.approvalMode);
	const automationCap: AutonomyMode = input.autoLand && !input.landConfirm ? "autodrive" : "assist";
	return byRank[Math.min(rank[approvalCap], rank[automationCap])];
}

export function effectiveAutonomyMode(input: AutonomyPolicyInput): AutonomyMode {
	if (input.blockedReason) return "observe";
	return byRank[Math.min(rank[input.requested], rank[maxEffectiveMode(input)])];
}

export function availableActions(mode: AutonomyMode, verificationState: VerificationState, blockedReason?: string): AgentAction[] {
	if (blockedReason) return ["set-mode"];
	const actions: AgentAction[] = ["set-mode"];
	if (mode !== "observe") actions.push("prompt", "answer", "interrupt", "verify");
	if (mode !== "observe" && verificationState === "fresh") actions.push("land");
	return actions;
}

export function validateRequestedMode(mode: unknown): AutonomyMode | undefined {
	return mode === "observe" || mode === "assist" || mode === "autodrive" ? mode : undefined;
}
