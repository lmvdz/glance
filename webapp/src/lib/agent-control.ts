/**
 * Agent control helpers — wires the Stop/kill, Interrupt, Restart, Remove, Set-model,
 * and Answer commands that the WS ClientCommand protocol already supports server-side.
 */

import type { AgentDTO, ClientCommand } from './dto';
import { apiJson } from './api';

/** Statuses that are terminal — an agent here can't (and needn't) be stopped/interrupted. */
const TERMINAL: ReadonlySet<AgentDTO['status']> = new Set(['stopped', 'error']);

/** Agents that can still be stopped (anything not already terminal). */
export function stoppableAgents(agents: AgentDTO[]): AgentDTO[] {
  return agents.filter((agent) => !TERMINAL.has(agent.status));
}

/** Agents where Interrupt makes sense (only mid-flight ones — not stopped/error). */
export function interruptibleAgents(agents: AgentDTO[]): AgentDTO[] {
  return agents.filter((agent) => agent.status === 'working' || agent.status === 'starting');
}

/** Agents that can be restarted (only stopped/error agents — active ones need kill first). */
export function restartableAgents(agents: AgentDTO[]): AgentDTO[] {
  return agents.filter((agent) => TERMINAL.has(agent.status));
}

/**
 * The command to stop one agent. We use `kill` (halt the agent host) rather than `interrupt`
 * (stop just the current turn): `kill` keeps the agent in the roster and restartable, so it's
 * the safe, recoverable "Stop".
 */
export function stopCommand(agentId: string): ClientCommand {
  return { type: 'kill', id: agentId };
}

/** Interrupt the current turn without halting the agent host. */
export function interruptCommand(agentId: string): ClientCommand {
  return { type: 'interrupt', id: agentId };
}

/** Restart a stopped/error agent. */
export function restartCommand(agentId: string): ClientCommand {
  return { type: 'restart', id: agentId };
}

/** Remove an agent, optionally deleting its worktree. */
export function removeCommand(agentId: string, deleteWorktree = false): ClientCommand {
  return { type: 'remove', id: agentId, deleteWorktree };
}

/**
 * Fork a terminal-marked workflow run from a checkpoint (default: the daemon picks its latest).
 * Mirrors the daemon's `SquadManager.fork(id, {seq?})` — this slice is routing-state-only ("Candidate
 * A"): the new run starts at the checkpoint's node with reset fix-up-tier visits, but the code stays
 * at the source run's branch tip. Gated in the UI on `AgentDTO.forkAvailable`.
 */
export function forkCommand(agentId: string, seq?: number): ClientCommand {
  return { type: 'fork', id: agentId, seq };
}

/** One entry from GET /api/agents/:id/checkpoints (mirrors the daemon's CheckpointLogEntry — never `vars`). */
export interface CheckpointEntryDTO {
  seq: number;
  at: number;
  currentNode: string;
  outcome?: 'succeeded' | 'failed';
}

/** Read-only checkpoint history for the fork-step picker. Returns [] (rather than throwing) on an old
 *  daemon that 404s the route, so a stale webapp/daemon pairing degrades to an empty picker instead of
 *  a crash — the button itself is separately gated on `forkAvailable` so this path is rarely hit cold. */
export async function fetchCheckpoints(agentId: string): Promise<CheckpointEntryDTO[]> {
  try {
    return await apiJson<CheckpointEntryDTO[]>(`/api/agents/${encodeURIComponent(agentId)}/checkpoints`);
  } catch {
    return [];
  }
}

/**
 * Guards against a stale `fetchCheckpoints` response overwriting the Fork picker: true only if the
 * picker is still open for the same agent the fetch was made for. Without this, opening the picker
 * on agent A (slow fetch), then agent B (fast open) before A resolves, lets A's late response
 * overwrite B's already-open picker via setForkCheckpoints/setForkSelectedSeq — so confirming then
 * forks B using A's checkpoint seq (daemon rejects it, or worse, silently forks the wrong step).
 */
export function isForkCheckpointResponseCurrent(requestedAgentId: string, currentPickerAgentId: string | null): boolean {
  return requestedAgentId === currentPickerAgentId;
}

/**
 * Pure: resolves the exact `fork` command a confirmed picker selection sends, given the fetched
 * checkpoints and whatever seq is currently selected — falling back to the latest entry when nothing
 * has been explicitly picked yet (the picker's own default). Extracted out of the component's click
 * handler so the "select a step, confirm" flow is unit-testable without mounting React (this webapp
 * has no jsdom/testing-library; components are tested DOM-free per project convention).
 */
export function resolveForkTarget(
  agentId: string,
  checkpoints: CheckpointEntryDTO[],
  selectedSeq: number | null,
): Extract<ClientCommand, { type: 'fork' }> | undefined {
  if (checkpoints.length === 0) return undefined;
  const seq = selectedSeq ?? Math.max(...checkpoints.map((c) => c.seq));
  return forkCommand(agentId, seq) as Extract<ClientCommand, { type: 'fork' }>;
}

/** Change the model for an agent. */
export function setModelCommand(agentId: string, model: string): ClientCommand {
  return { type: 'set-model', id: agentId, model };
}

/** Answer a blocked agent's pending input request. */
export function answerCommand(agentId: string, requestId: string, value: string): ClientCommand {
  return { type: 'prompt', id: agentId, message: value, clientTurnId: requestId };
}

/** Known model shorthand names — matches what the daemon's set-model handler accepts. */
export const KNOWN_MODELS: readonly string[] = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
];

/**
 * Land/verify controls. The daemon has always exposed POST /api/agents/:id/verify and /land,
 * but the webapp shell replacement dropped every UI that called them — ad-hoc agents in
 * particular could only be merged by hand from a terminal. An agent is landable when it has
 * a branch and its own worktree to merge from; whether the land may *proceed* stays the
 * server's call (proofGate: verify-before-land).
 */
export function canLand(agent: Pick<AgentDTO, 'branch' | 'worktree' | 'repo'> | null | undefined): boolean {
  return !!agent?.branch && agent.worktree !== agent.repo;
}

export interface LandResultDTO {
  ok: boolean;
  committed?: boolean;
  merged?: boolean;
  staged?: boolean;
  message?: string;
  detail?: string;
}

export interface ProofResultDTO {
  ok: boolean;
  command?: string;
  detail?: string;
}

export type ToastTone = 'success' | 'error' | 'info';

/** Human toast for a land response (including the staged confirm-hold outcome). */
export function landToast(res: LandResultDTO): { text: string; tone: ToastTone } {
  const detail = res.detail ?? res.message ?? '';
  if (res.staged) return { text: `Ready to land — conflict auto-resolved, land again to merge${detail ? ` (${detail})` : ''}`, tone: 'info' };
  if (res.ok) return { text: res.merged ? `Landed${detail ? `: ${detail}` : ''}` : `Land made no merge${detail ? `: ${detail}` : ''}`, tone: 'success' };
  return { text: `Land blocked: ${detail || 'unknown reason'}`, tone: 'error' };
}

/** Human toast for a verify (proof) response. */
export function verifyToast(proof: ProofResultDTO): { text: string; tone: ToastTone } {
  if (proof.ok) return { text: 'Proof green — this branch can land', tone: 'success' };
  const tail = (proof.detail ?? '').split('\n').filter(Boolean).slice(-1)[0] ?? '';
  return { text: `Proof RED${tail ? ` — ${tail}` : ''}`, tone: 'error' };
}
