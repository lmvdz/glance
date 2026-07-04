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

/** Per-mode Land button label, shared between ActiveWorkPane and AssistantChat. */
export function landButtonLabel(agent: Pick<AgentDTO, 'prState' | 'landReady'>): string {
  if (agent.prState === 'merged') return 'Merged ✓';
  if (agent.prState) return 'Merge PR';
  if (agent.landReady) return 'Land ✓';
  return 'Land';
}
