/**
 * Agent stop control — the webapp could never stop a running agent: dto.ts defines the
 * kill/interrupt/restart/remove commands and useSquad().send can dispatch them, but no
 * component ever sent one. These helpers back the "Stop" button in the task detail header.
 */

import type { AgentDTO, ClientCommand } from './dto';

/** Statuses that are terminal — an agent here can't (and needn't) be stopped. */
const TERMINAL: ReadonlySet<AgentDTO['status']> = new Set(['stopped', 'error']);

/** Agents that can still be stopped (anything not already terminal). */
export function stoppableAgents(agents: AgentDTO[]): AgentDTO[] {
  return agents.filter((agent) => !TERMINAL.has(agent.status));
}

/**
 * The command to stop one agent. We use `kill` (halt the agent host) rather than `interrupt`
 * (stop just the current turn): `kill` keeps the agent in the roster and restartable, so it's
 * the safe, recoverable "Stop".
 */
export function stopCommand(agentId: string): ClientCommand {
  return { type: 'kill', id: agentId };
}
