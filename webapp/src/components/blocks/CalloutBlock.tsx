import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BlockProps } from '../PlanBlocks';

const toneStyles = {
  decision: { label: 'DECISION', color: 'var(--wf-accent)' },
  warn: { label: 'WARN', color: 'var(--wf-warn, var(--wf-warning))' },
  ok: { label: 'OK', color: 'var(--wf-ok, var(--wf-success))' },
  info: { label: 'INFO', color: 'var(--wf-muted, var(--wf-text-subtle))' },
} as const;

type CalloutTone = keyof typeof toneStyles;

function isCalloutTone(value: string | undefined): value is CalloutTone {
  return value === 'decision' || value === 'warn' || value === 'ok' || value === 'info';
}

function InlineMarkdown({ content }: { content: string }) {
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

export default function CalloutBlock({ body, params, blockId }: BlockProps) {
  const tone = isCalloutTone(params.tone) ? params.tone : 'info';
  const style = toneStyles[tone];

  return (
    <div
      data-block-id={blockId}
      className="not-prose my-3 rounded-md border border-[var(--wf-border)] border-l-4 bg-[var(--wf-surface-raised)] p-3 text-sm text-[var(--wf-text-muted)] shadow-sm"
      style={{ borderLeftColor: style.color }}
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: style.color }}>
        {style.label}
      </div>
      <div className="leading-relaxed">
        <InlineMarkdown content={body} />
      </div>
    </div>
  );
}
