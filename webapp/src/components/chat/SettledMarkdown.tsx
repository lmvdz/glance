import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeBlock } from './CodeBlock';
import { splitSettled, trimStreamingArtifacts } from '../../lib/streamingMarkdown';
import type { TranscriptEntry } from '../../lib/dto';

// Moved from AssistantChat.tsx (concern 09 — monolith split), together with
// `CodeBlock` and the `streamingMarkdown` import it depends on — pulling
// those along is what keeps this module from having to import back from
// `../AssistantChat` (which would create a `chat/ -> ../AssistantChat`
// import cycle).

/** Shared remark config for both markdown call sites — kept in one place so they can't drift. */
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_COMPONENTS = { code: CodeBlock };

/** Memo leaf for the settled markdown prefix — its only prop is the settled string, so it only re-renders when the settled boundary advances. */
const MemoSettled = React.memo(({ text }: { text: string }) => (
  <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{text}</Markdown>
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
 */
export const SettledMarkdown = ({ text, status }: { text: string; status?: TranscriptEntry['status'] }) => {
  if (status === 'running') {
    const { settled, tail } = splitSettled(text);
    return (
      <>
        <MemoSettled text={settled} />
        <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{trimStreamingArtifacts(tail)}</Markdown>
      </>
    );
  }
  return <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{text}</Markdown>;
};
