import React from 'react';
import { FileText, MessageSquare, CheckCircle2 } from 'lucide-react';
import type { PipelineDocument } from './TaskDetail';
import type { ArtifactCommentDTO, DoneProofDTO } from '../lib/dto';
import { fmtSince } from '../lib/factoryStatus';
import { PanelSection } from './kit/PanelSection';
import { StatusChip } from './kit/StatusChip';

/** Per-doc annotation ("comment") count — reference A shows a badge on every artifact row. Doc
 *  targeting is modeled today as `kind: "plan-annotation"` + `annotation.planPath` (see comments.ts);
 *  there is no generic targetType/targetId union yet, so this filters the feature-scoped comment
 *  list down to the ones anchored at this specific document (X3's design-review unit owns richer
 *  doc-anchoring UX — this rail only needs the count). */
export function annotationCountByPath(comments: ArtifactCommentDTO[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    if (comment.kind !== 'plan-annotation' || !comment.annotation) continue;
    const path = comment.annotation.planPath;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/**
 * The right-hand ARTIFACTS rail from reference A: every artifact this task has produced, each with
 * a comment-count badge, in one place — the human decision it serves is "what has this task
 * actually produced, and where's the open discussion on it?" (as opposed to digging through the
 * plan-doc reading pane's tabs one at a time). Plan docs come from the same `pipeline` payload
 * TaskDetail already loads (GET /api/features/:id/pipeline — documents+comments; no new endpoint
 * needed for those). Done-proof is genuinely new surface (GET /api/features/:id/done-proof).
 * "Produced files" beyond plan docs and the done-proof aren't cheaply derivable today (would need a
 * worktree diff/tree walk per task) — left for a follow-on, not silently invented here.
 */
export function TaskArtifactsRail({
  documents,
  comments,
  doneProof,
  selectedPath,
  onSelect,
  right,
  toolbar,
  className = 'h-full',
  bodyClassName = 'overflow-y-auto',
}: {
  documents: PipelineDocument[];
  comments: ArtifactCommentDTO[];
  doneProof: DoneProofDTO | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Header-slot content (e.g. a doc-count + prev/next Kbd hints) — passed through to
   *  {@link PanelSection}'s `right`. Optional so a standalone rail (no keyboard cycling context)
   *  doesn't have to pass anything. */
  right?: React.ReactNode;
  /** Plan-level action row (Implement / Module / Sync tickets / …) rendered between the header
   *  and the document list. These act on the whole plan, not one document, so they live here
   *  rather than duplicated per-row — the one place TaskDetail's left pane wants them once the
   *  doc-viewer toolbar's copy is deleted. */
  toolbar?: React.ReactNode;
  /** Override the outer panel sizing — the standalone right-rail placement wants `h-full` +
   *  internal scroll; embedding this same component inline in a naturally-scrolling column
   *  (TaskDetail's left pane) wants a plain block instead, so callers can pass `''` for both. */
  className?: string;
  bodyClassName?: string;
}) {
  const counts = React.useMemo(() => annotationCountByPath(comments), [comments]);

  return (
    <PanelSection title="Artifacts" right={right} className={className} bodyClassName={bodyClassName}>
      {toolbar}
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {documents.length === 0 && !doneProof && (
          <div className="px-3 py-6 text-center text-xs text-gray-400 dark:text-gray-500">No artifacts yet.</div>
        )}
        {documents.map((doc) => {
          const count = counts.get(doc.path) ?? 0;
          const isSelected = doc.path === selectedPath;
          return (
            <button
              key={doc.path}
              type="button"
              onClick={() => onSelect(doc.path)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:hover:bg-gray-900/60 ${isSelected ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''}`}
              aria-current={isSelected}
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">{doc.file}</span>
              {count > 0 && (
                <span className="flex flex-shrink-0 items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <MessageSquare className="h-2.5 w-2.5" aria-hidden="true" />
                  {count}
                </span>
              )}
            </button>
          );
        })}
        {doneProof && (
          <div className="flex items-start gap-2 px-3 py-2.5 text-xs">
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                <span className="font-medium">done-proof</span>
                <StatusChip status={doneProof.verified} tone={doneProof.verified === 'green' ? 'success' : doneProof.verified === 'red-baseline' ? 'attention' : 'neutral'} />
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400 dark:text-gray-500">{doneProof.commit.slice(0, 10)} · {fmtSince(Math.max(0, Math.floor((Date.now() - doneProof.provenAt) / 1000)))}</div>
            </div>
          </div>
        )}
      </div>
    </PanelSection>
  );
}
