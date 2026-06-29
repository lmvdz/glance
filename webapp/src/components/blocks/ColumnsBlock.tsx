import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BlockProps } from '../PlanBlocks';

function splitColumns(body: string): [string, string] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const dividerIndex = lines.findIndex((line) => line === '---');

  if (dividerIndex === -1) {
    return [body, ''];
  }

  return [lines.slice(0, dividerIndex).join('\n').trim(), lines.slice(dividerIndex + 1).join('\n').trim()];
}

function ColumnMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-[var(--wf-text)]">{children}</strong>,
        a: ({ children, href }) => (
          <a className="font-medium text-[var(--wf-accent)] underline underline-offset-2" href={href}>
            {children}
          </a>
        ),
        code: ({ children }) => (
          <code className="rounded bg-[var(--wf-paper-muted)] px-1 py-0.5 font-mono text-[0.86em] text-[var(--wf-text)]">
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="mb-2 overflow-x-auto rounded-md border border-[var(--wf-border)] bg-[var(--wf-paper)] p-2 font-mono text-xs leading-relaxed text-[var(--wf-text)] last:mb-0">
            {children}
          </pre>
        ),
      }}
    >
      {content}
    </Markdown>
  );
}

export default function ColumnsBlock({ body, params, blockId }: BlockProps) {
  const [left, right] = splitColumns(body);
  const leftLabel = params.left || 'Before';
  const rightLabel = params.right || 'After';

  return (
    <div data-block-id={blockId} className="not-prose my-3 grid gap-3 md:grid-cols-2">
      <section className="rounded-md border border-[var(--wf-border)] bg-[var(--wf-surface-raised)] p-3 text-sm text-[var(--wf-text-muted)] shadow-sm">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--wf-text-subtle)]">{leftLabel}</div>
        <div className="leading-relaxed">
          <ColumnMarkdown content={left} />
        </div>
      </section>
      <section className="rounded-md border border-[var(--wf-border)] bg-[var(--wf-surface-raised)] p-3 text-sm text-[var(--wf-text-muted)] shadow-sm">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--wf-text-subtle)]">{rightLabel}</div>
        <div className="leading-relaxed">
          <ColumnMarkdown content={right} />
        </div>
      </section>
    </div>
  );
}
