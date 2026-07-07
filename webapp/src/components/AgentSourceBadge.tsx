/** Small emerald pill marking a decision (or other artifact) as captured by an agent — shared by the
 *  KnowledgePanel "Decisions on record" list and the TaskDetail decisions log so the two stay in sync. */
export function AgentSourceBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block rounded-sm bg-emerald-100 px-1 py-px text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 ${className}`}
      title="captured by an agent"
    >
      agent
    </span>
  );
}
