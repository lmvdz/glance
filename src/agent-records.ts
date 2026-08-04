import type { AgentProfileRecord, EvidenceRecord, NodeRecord } from "./memory/node-records.ts";

export type AgentClaimState = "current" | "stale" | "withdrawn";

export interface AgentClaim {
	id: string;
	claim: string;
	verification: EvidenceRecord["verification"];
	sampleSize: number;
	date: number;
	state: AgentClaimState;
	/** The exact units that produced the claim; never an aggregate without its sources. */
	sourceNodeIds: string[];
}

export interface AgentRecordView {
	agentId: string;
	/** Configured work, never presented as proven behaviour. */
	roleDefault?: string;
	provisional: boolean;
	checking?: AgentProfileRecord["checking"];
	/** Missing is unknown, not an established record. */
	profileMissing: boolean;
	claims: AgentClaim[];
}

function claimState(record: EvidenceRecord, now: number): AgentClaimState {
	if (record.withdrawnAt !== undefined && record.withdrawnAt <= now) return "withdrawn";
	if (record.staleAt !== undefined && record.staleAt <= now) return "stale";
	return "current";
}

/**
 * Projects one agent's durable record. This intentionally accepts one id and has no collection
 * helper: the product informs the next task for this agent, never a cross-agent leaderboard.
 */
export function agentRecordView(agentId: string, records: readonly NodeRecord[], now = Date.now()): AgentRecordView {
	const profile = records.find((record): record is AgentProfileRecord => record.kind === "agent-profile" && record.nodeId === agentId && record.agentId === agentId);
	const claims = records
		.filter((record): record is EvidenceRecord => record.kind === "evidence" && record.nodeId === agentId)
		.map((record) => ({
			id: record.id,
			claim: record.claim,
			verification: record.verification,
			sampleSize: record.sampleSize,
			date: record.checkedAt ?? record.createdAt,
			state: claimState(record, now),
			sourceNodeIds: [...record.sourceNodeIds],
		}))
		.sort((a, b) => b.date - a.date || a.id.localeCompare(b.id));
	return {
		agentId,
		roleDefault: profile?.roleDefault,
		provisional: profile?.status === "provisional",
		checking: profile?.checking,
		profileMissing: profile === undefined,
		claims,
	};
}
