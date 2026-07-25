import React from 'react';
import { FileText } from 'lucide-react';

// Moved verbatim from AssistantChat.tsx (concern 09 — monolith split).
// `AgentFileDiff` lives here (its most natural home) rather than in
// `AssistantChat.tsx`, so `TranscriptTimeline.tsx` can import it from this
// sibling module instead of reaching back across the `chat/ -> ../AssistantChat`
// cycle boundary; `AssistantChat.tsx` re-imports it forward from here.
export interface AgentFileDiff {
  file: string;
  status?: string;
  diff?: string;
}

export const DiffReviewPanel = ({ diffs }: { diffs: AgentFileDiff[] }) => {
  if (!diffs.length) return null;
  return (
    <section data-chat-message className="rounded-lg border border-ink-border bg-white/70 p-2.5 text-xs border-ink-border bg-panel/40" aria-label="Changed files">
      <details>
        <summary className="flex cursor-pointer list-none items-center gap-2 text-ink-text-label hover:text-ink-text text-ink-text-subtle dark:hover:text-ink-text">
          <FileText className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <span className="font-medium">{diffs.length} changed {diffs.length === 1 ? 'file' : 'files'}</span>
          <span className="ml-auto text-caption">Review diff</span>
        </summary>
        <div className="mt-2 space-y-2">
          {diffs.map((diff) => (
            <details key={diff.file} className="rounded-md bg-ink px-2 py-1.5 bg-ink">
              <summary className="cursor-pointer list-none truncate font-mono text-caption text-ink-text-label">
                {diff.status ? `${diff.status} ` : ''}{diff.file}
              </summary>
              {diff.diff && <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-ink p-2 text-caption leading-relaxed text-ink-text whitespace-pre scrollbar-custom">{diff.diff}</pre>}
            </details>
          ))}
        </div>
      </details>
    </section>
  );
};
