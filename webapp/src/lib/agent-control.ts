/**
 * Agent control helpers — wires the Stop/kill, Interrupt, Restart, Remove, Set-model,
 * and Answer commands that the WS ClientCommand protocol already supports server-side.
 */

import type { AgentDTO, ClientCommand } from './dto';

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
