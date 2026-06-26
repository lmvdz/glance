import type { AgentDTO, PendingRequest } from "./dto";

export type InboxRow =
  | { kind: "pending"; agent: AgentDTO; req: PendingRequest; ts: number }
  | { kind: "error"; agent: AgentDTO; ts: number }
  | { kind: "landReady"; agent: AgentDTO; ts: number };

/** Fold every operator-actionable item across the roster, oldest-first. */
export function foldInbox(agents: AgentDTO[]): InboxRow[] {
  const out: InboxRow[] = [];
  for (const agent of agents) {
    for (const req of agent.pending) out.push({ kind: "pending", agent, req, ts: req.createdAt });
    if (agent.status === "error") out.push({ kind: "error", agent, ts: agent.lastActivity });
    if (agent.landReady) out.push({ kind: "landReady", agent, ts: agent.lastActivity });
  }
  out.sort((x, y) => x.ts - y.ts);
  return out;
}

export function inboxActionCount(agents: AgentDTO[]): number {
  return foldInbox(agents).length;
}
