import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeBlock } from './CodeBlock';
import { splitSettled, trimStreamingArtifacts } from '../../lib/streamingMarkdown';
import { BLOCK_REGISTRY, createRegistryPre, type MarkdownPreProps } from '../PlanBlocks';
import type { TranscriptEntry } from '../../lib/dto';

// Moved from AssistantChat.tsx (concern 09 — monolith split), together with
// `CodeBlock` and the `streamingMarkdown` import it depends on — pulling
// those along is what keeps this module from having to import back from
// `../AssistantChat` (which would create a `chat/ -> ../AssistantChat`
// import cycle).

/**
 * The trusted block registry minus `questions`: `QuestionsBlock` guards
 * `ctx.onAnswer` and degrades to disabled controls without it, and chat has no
 * answer path — an inert form in a chat lane is noise, not a feature. Revisit
 * once chat grows a way to answer questions inline.
 */
const CHAT_BLOCK_REGISTRY = Object.fromEntries(
  Object.entries(BLOCK_REGISTRY).filter(([lang]) => lang !== 'questions'),
);

/**
 * Chat's non-registry fence fallback: unwrap the block-level `CodeBlock` instead of
 * re-wrapping it in a `<pre>`, since `CodeBlock` already renders its own `<div>` chrome
 * (copy button, language label) for fenced code — nesting it inside `<pre>` produced
 * invalid `<pre><div>` markup.
 */
function chatPreFallback(children: React.ReactNode, props: React.ComponentPropsWithoutRef<'pre'>) {
  const child = React.isValidElement(children) ? children : undefined;
  const isBlockCode = child?.type === CodeBlock && /language-(\w+)/.test((child.props as { className?: string })?.className || '');
  if (isBlockCode) return child;
  return <pre {...props}>{children}</pre>;
}

/** Chat's `pre` renderer: registry blocks (minus `questions`) with the CodeBlock-aware fallback above. */
const ChatPre = createRegistryPre(CHAT_BLOCK_REGISTRY, chatPreFallback) as (props: MarkdownPreProps) => React.ReactElement;

/** Shared remark config for both markdown call sites — kept in one place so they can't drift. */
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/**
 * Streaming tail — today's plain behavior. `findSettledBoundary` never settles inside an
 * open fence, so an in-flight fence only ever appears here, and it renders as plain code
 * until the boundary passes it or the turn completes.
 */
const TAIL_COMPONENTS = { code: CodeBlock };

/**
 * Settled prefix and completed entries — registry dispatch on top of the plain code
 * renderer. Static and module-level (not built per render): a components object rebuilt
 * every render gives react-markdown a new identity every WS frame and remounts the whole
 * tail tree, which is exactly the churn the two-map split exists to avoid.
 */
const SETTLED_COMPONENTS = { code: CodeBlock, pre: ChatPre };

/** Memo leaf for the settled markdown prefix — its only prop is the settled string, so it only re-renders when the settled boundary advances. */
const MemoSettled = React.memo(({ text }: { text: string }) => (
  <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={SETTLED_COMPONENTS}>{text}</Markdown>
));

/**
 * Streaming-aware markdown: while `status === 'running'`, the settled prefix is
 * parsed once per boundary advance (memoized) and only the small unsettled tail
 * is re-parsed per WS frame, with streaming artifacts (torn `**`, unclosed
 * links, bare list markers, orphan table headers) suppressed on the tail only.
 * Completed entries render the full raw text in one pass, untrimmed — malformed
 * final markdown is a model bug and should render as remark parses it.
 *
 * Accepted visual artifact: when the settled boundary crosses a code fence, the
 * fence remounts from the tail tree to the settled tree — one Prism re-highlight
 * flash and copy-state reset per fence. Known, bounded, not a defect to chase.
 *
 * Two more accepted artifacts come with registry dispatch in the settled/completed
 * tree: a closed fence sitting in the tail still renders as plain code until the
 * boundary passes it or the turn completes (registry blocks never mount early), and
 * the settled boundary can move backward, so a mounted rich block may unmount back to
 * plain and remount once — a bounded flash in the same class as the fence remount above.
 */
export const SettledMarkdown = ({ text, status }: { text: string; status?: TranscriptEntry['status'] }) => {
  if (status === 'running') {
    const { settled, tail } = splitSettled(text);
    return (
      <>
        <MemoSettled text={settled} />
        <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={TAIL_COMPONENTS}>{trimStreamingArtifacts(tail)}</Markdown>
      </>
    );
  }
  return <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={SETTLED_COMPONENTS}>{text}</Markdown>;
};
