import type { CSSProperties } from 'react';
import { CodeHighlight } from '../CodeHighlight';
import type { BlockProps } from '../PlanBlocks';

type AnnotationNote = {
  start: number;
  end: number;
  note: string;
};

const NOTE_PATTERN = /^\/\/\s*@note\s+(\d+)(?:-(\d+))?\s+(.+)$/;

function parseAnnotatedCode(body: string): { code: string; notes: AnnotationNote[] } {
  const codeLines: string[] = [];
  const notes: AnnotationNote[] = [];

  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const match = NOTE_PATTERN.exec(line.trim());
    if (!match) {
      codeLines.push(line);
      continue;
    }

    const start = Number.parseInt(match[1], 10);
    const rawEnd = match[2] ? Number.parseInt(match[2], 10) : start;
    const end = Math.max(start, rawEnd);

    notes.push({ start, end, note: match[3].trim() });
  }

  return { code: codeLines.join('\n'), notes };
}

function lineLabel(note: AnnotationNote): string {
  return note.start === note.end ? `Line ${note.start}` : `Lines ${note.start}-${note.end}`;
}

function hasLineNote(notes: AnnotationNote[], lineNumber: number): boolean {
  return notes.some((note) => lineNumber >= note.start && lineNumber <= note.end);
}

export default function AnnotatedCodeBlock({ body, params, blockId }: BlockProps) {
  const { code, notes } = parseAnnotatedCode(body);
  const language = params.lang || 'text';

  return (
    <section
      className="not-prose overflow-hidden rounded-lg border border-[var(--wf-border)] bg-[var(--wf-surface)] text-sm text-[var(--wf-text)]"
      data-block-id={blockId}
    >
      <div className="border-b border-[var(--wf-border)] bg-[var(--wf-surface-raised)] px-3 py-2">
        <div className="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wf-text-muted)]">
          annotated code · {language}
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 overflow-x-auto bg-gray-950">
          <CodeHighlight
            language={language}
            showLineNumbers
            wrapLines
            lineProps={(lineNumber): { style: CSSProperties } => ({
              style: hasLineNote(notes, lineNumber)
                ? {
                    display: 'block',
                    backgroundColor: 'color-mix(in srgb, var(--wf-accent) 22%, transparent)',
                    borderLeft: '3px solid var(--wf-accent)',
                    paddingLeft: '0.5rem',
                  }
                : { display: 'block' },
            })}
            customStyle={{ margin: 0, background: 'transparent', padding: '1rem' }}
            lineNumberStyle={{
              minWidth: '2.75em',
              paddingRight: '1em',
              color: 'var(--wf-text-subtle)',
            }}
          >
            {code}
          </CodeHighlight>
        </div>

        {notes.length > 0 && (
          <aside className="space-y-2 border-t border-[var(--wf-border)] bg-[var(--wf-paper-muted)] p-3 lg:border-l lg:border-t-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--wf-text-muted)]">Notes</div>
            <ol className="space-y-2">
              {notes.map((note, index) => (
                <li
                  key={`${note.start}-${note.end}-${index}`}
                  className="rounded-md border border-[var(--wf-border)] bg-[var(--wf-surface)] p-3"
                >
                  <div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-[var(--wf-accent)]">
                    {lineLabel(note)}
                  </div>
                  <p className="m-0 text-sm leading-relaxed text-[var(--wf-text)]">{note.note}</p>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </section>
  );
}
