/**
 * Lazy syntax highlighting — react-syntax-highlighter's full Prism build was eagerly
 * imported by three components, which put ~500KB of grammars into the main bundle of a
 * PWA meant to be driven from a phone. The library (plus the theme) now loads on first
 * use; until then a plain <pre> shows the code, so nothing blocks or shifts badly.
 */

import React, { Suspense, type CSSProperties } from 'react';

export interface CodeHighlightProps {
  lineNumberStyle?: CSSProperties;
  language?: string;
  children: string;
  customStyle?: CSSProperties;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  lineProps?: (lineNumber: number) => { style: CSSProperties };
}

const LazyPrism = React.lazy(async () => {
  const [{ Prism }, { vscDarkPlus }] = await Promise.all([
    import('react-syntax-highlighter'),
    import('react-syntax-highlighter/dist/esm/styles/prism'),
  ]);
  const Highlighter: React.FC<CodeHighlightProps> = ({ language, children, customStyle, showLineNumbers, wrapLines, lineProps, lineNumberStyle }) => (
    <Prism language={language} style={vscDarkPlus} customStyle={customStyle} showLineNumbers={showLineNumbers} wrapLines={wrapLines} lineProps={lineProps} lineNumberStyle={lineNumberStyle} PreTag="div">
      {children}
    </Prism>
  );
  return { default: Highlighter };
});

export const CodeHighlight: React.FC<CodeHighlightProps> = (props) => (
  <Suspense
    fallback={
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-gray-200" style={props.customStyle}>
        {props.children}
      </pre>
    }
  >
    <LazyPrism {...props} />
  </Suspense>
);
