import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeHighlight } from '../CodeHighlight';

/**
 * PlanProse — a plan, typeset.
 *
 * A plan is not a blob of text that happens to be markdown; it is a numbered argument, and the
 * numbers are the argument. Rendering it `whitespace-pre-wrap` — which is what the decision panel did
 * first — throws away every distinction the author made: which lines are steps, which words are file
 * paths, where one thought ends. A person deciding whether to approve it then has to re-derive the
 * structure by eye, at the exact moment we are asking them to be careful.
 *
 * So the treatment follows the room's own idiom rather than a generic markdown stylesheet:
 *
 * - **Steps get the marker.** An ordered list renders as a mono ember number in the gutter with the
 *   text hanging beside it — the same shape as every other addressable thing in this product, where a
 *   small mono identifier sits left of prose. The number is the thing you will say out loud when you
 *   answer ("do 2 and 4, skip 3"), so it is legible and selectable, not a browser-drawn glyph.
 * - **Identifiers stay mono.** Inline code is where a plan names files, symbols and flags, and those
 *   are addresses — DESIGN.md's standing rule is identity at a glance, address on demand.
 * - **Headings are quiet.** A plan's own headings are structure, not shouting; they take the mono
 *   eyebrow treatment used for zone labels everywhere else, so they read as sections of this surface
 *   instead of a document pasted into it.
 * - **Nothing is boxed that does not need to be.** Only code blocks and tables get a border, because
 *   only they need an edge to be readable.
 *
 * Reading measure is capped rather than filling the panel: prose set to the full width of a 560px
 * rail is harder to read than the same prose at 60 characters, and the panel is a place you are meant
 * to read carefully once, not skim.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

/** Depth-aware ordered-list numbering, so a nested step reads "2.1" rather than restarting at 1. */
const OrderedContext = React.createContext<string>('');

function Ordered({ children, start }: { children?: React.ReactNode; start?: number }) {
  const prefix = React.useContext(OrderedContext);
  const first = typeof start === 'number' ? start : 1;
  const items = React.Children.toArray(children).filter((child) => React.isValidElement(child));
  return (
    <ol className="mt-2.5 flex flex-col gap-2.5">
      {items.map((child, index) => {
        const label = prefix ? `${prefix}.${first + index}` : String(first + index);
        return (
          <li key={index} className="flex gap-3">
            {/* The number is what a person says out loud when they answer — "do 2 and 4, skip 3" — so
                it is real selectable text in the gutter, not a marker the browser draws. */}
            <span
              className="flex-none select-text pt-[2px] text-right"
              style={{ fontFamily: MONO, fontSize: 11, color: '#F0A35A', minWidth: prefix ? 30 : 18 }}
            >
              {label}
            </span>
            <div className="min-w-0 flex-1">
              <OrderedContext.Provider value={label}>{child}</OrderedContext.Provider>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const components = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <div className="mb-3.5 mt-1 pb-2" style={{ borderBottom: '1px solid #1F1F22' }}>
      <div className="text-[14px] font-semibold leading-[1.35]" style={{ color: '#F2F2F4', textWrap: 'pretty' }}>{children}</div>
    </div>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <div className="mb-2 mt-5" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
      {typeof children === 'string' ? children.toUpperCase() : children}
    </div>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <div className="mb-1.5 mt-4 text-[12.5px] font-semibold" style={{ color: '#DEDEE2' }}>{children}</div>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-2 text-[12.5px] leading-[1.65]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>{children}</p>
  ),
  ol: Ordered,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mt-2 flex flex-col gap-1.5">
      {React.Children.toArray(children).filter(React.isValidElement).map((child, index) => (
        <li key={index} className="flex gap-2.5">
          <span className="mt-[8px] h-[4px] w-[4px] flex-none rounded-full" style={{ background: '#3E5C8A' }} />
          <div className="min-w-0 flex-1">{child}</div>
        </li>
      ))}
    </ul>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <div className="text-[12.5px] leading-[1.6]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>{children}</div>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => <strong style={{ color: '#E8E8EA', fontWeight: 600 }}>{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em style={{ color: '#DEDEE2' }}>{children}</em>,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} style={{ color: '#F0A35A' }} title={href}>{children}</a>
  ),
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const language = /language-(\w+)/.exec(className ?? '')?.[1];
    if (!language) {
      // A plan names files, symbols and flags inline. Those are ADDRESSES — mono, and tinted so they
      // are findable when someone is scanning for "which file does step 3 touch".
      return (
        <code
          className="rounded-[2px] px-[4px] py-[1px]"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: '#D8C3A5',
            background: '#171512',
            // A file path is long and the measure is narrow, so it WILL break. Without
            // box-decoration-break the first fragment keeps the left padding and the last keeps the
            // right, so one identifier reads as two ragged chips; `clone` gives every fragment its
            // own box. Breaking anywhere beats overflowing the rail — a path you cannot see the end
            // of is a path you cannot check.
            boxDecorationBreak: 'clone',
            WebkitBoxDecorationBreak: 'clone',
            overflowWrap: 'anywhere',
          } as React.CSSProperties}
        >
          {children}
        </code>
      );
    }
    return (
      <CodeHighlight
        language={language}
        customStyle={{ margin: 0, background: '#0A0A0B', fontSize: 11, padding: '10px 12px', border: '1px solid #1F1F22', borderRadius: 3 }}
      >
        {String(children).replace(/\n$/, '')}
      </CodeHighlight>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => <div className="my-3 overflow-x-auto">{children}</div>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 pl-3" style={{ borderLeft: '2px solid #2A2A30' }}>{children}</div>
  ),
  hr: () => <div className="my-4" style={{ borderTop: '1px solid #1F1F22' }} />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto" style={{ border: '1px solid #1F1F22' }}>
      <table className="w-full border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-2.5 py-1.5 text-left" style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.1em', color: '#5A5A61', borderBottom: '1px solid #1F1F22' }}>
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-2.5 py-1.5 align-top text-[12px]" style={{ color: '#C9C9CF', borderTop: '1px solid #17171A' }}>{children}</td>
  ),
} as const;

export function PlanProse({ markdown, measure = 62 }: { markdown: string; measure?: number }) {
  return (
    // A reading measure rather than the panel's full width: the same prose at 60-odd characters is
    // easier to read carefully, and careful is the whole point of this surface.
    <div style={{ maxWidth: `${measure}ch` }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>{markdown}</ReactMarkdown>
    </div>
  );
}
