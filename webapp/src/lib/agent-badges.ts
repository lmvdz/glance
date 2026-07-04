import type { AgentDTO } from './dto';

/** Human-facing label for an agent's PR-mode `prState`. Local-mode agents have no `prState`. */
export function prStateBadgeLabel(prState: NonNullable<AgentDTO['prState']>): string {
  switch (prState) {
    case 'draft':
    case 'open':
      return 'awaiting merge';
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed — unmerged';
  }
}

/** Tailwind badge classes for an agent's PR-mode `prState`, matching the existing badge palette. */
export function prStateBadgeClass(prState: NonNullable<AgentDTO['prState']>): string {
  switch (prState) {
    case 'draft':
    case 'open':
      return 'bg-amber-100 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400';
    case 'merged':
      return 'bg-emerald-100 font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400';
    case 'closed':
      return 'bg-red-100 font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-400';
  }
}

/** Tailwind badge classes for an agent's lifecycle `status`, matching the roster row's badge palette
 *  (border+bg+text triad; `starting`/`idle`/`working`'s working-adjacent states fall through to blue). */
export function agentStatusBadgeClass(status: AgentDTO['status']): string {
  switch (status) {
    case 'working':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400';
    case 'error':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400';
    case 'input':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400';
    case 'stopped':
      return 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400';
    default:
      return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400';
  }
}

/** Per-mode Land button label, shared between ActiveWorkPane and AssistantChat. */
export function landButtonLabel(agent: Pick<AgentDTO, 'prState' | 'landReady'>): string {
  if (agent.prState === 'merged') return 'Merged ✓';
  if (agent.prState) return 'Merge PR';
  if (agent.landReady) return 'Land ✓';
  return 'Land';
}
