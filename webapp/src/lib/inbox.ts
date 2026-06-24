import type { AgentDTO, PendingRequest } from "./dto";

export interface InboxRow {
  agent: AgentDTO;
  req: PendingRequest;
}

/** Fold every pending human-input request across the roster, oldest-first. */
export function foldInbox(agents: AgentDTO[]): InboxRow[] {
  const out: InboxRow[] = [];
  for (const a of agents) for (const req of a.pending) out.push({ agent: a, req });
  out.sort((x, y) => x.req.createdAt - y.req.createdAt);
  return out;
}
