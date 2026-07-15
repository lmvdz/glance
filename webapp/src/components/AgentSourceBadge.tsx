/** Small emerald pill marking a decision (or other artifact) as captured by an agent — used by the
 *  TaskDetail decisions log (previously also the KnowledgePanel, folded into the ⌘K palette). */
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

/** Sky pill marking a decision as a model-delta — a mental-model change (what was true before, what
 *  is true now) recorded mid-run with evidence anchors, distinct from a routine `agent` decision.
 *  Comprehension lane, concern 05 ("teaching producers"). */
export function ModelDeltaBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block rounded-sm bg-sky-100 px-1 py-px text-[10px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 ${className}`}
      title="mental-model delta — evidence-anchored, recorded mid-run"
    >
      model-delta
    </span>
  );
}
