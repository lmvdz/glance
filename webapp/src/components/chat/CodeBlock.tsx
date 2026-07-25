import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { CodeHighlight } from '../CodeHighlight';

// Moved verbatim from AssistantChat.tsx (concern 09 — monolith split). Sole
// consumer is `SettledMarkdown`'s shared `code` renderer.
export const CodeBlock = ({ inline, className, children, ...props }: any) => {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const isBlock = !inline && match;

  const handleCopy = () => {
    navigator.clipboard.writeText(String(children).replace(/\n$/, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isBlock) {
    return <code className={className} {...props}>{children}</code>;
  }

  return (
    <div className="relative group rounded-md overflow-hidden bg-ink-surface border border-ink-border my-4">
      <div className="flex items-center justify-between px-4 py-2 bg-ink border-b border-ink-border">
        <span className="text-xs text-ink-text-muted font-mono">{match[1]}</span>
        <button
          onClick={handleCopy}
          className="text-ink-text-muted hover:text-ink-text-label dark:hover:text-ink-text-body transition-colors flex items-center gap-1 text-xs"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500 dark:text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="p-4 overflow-x-auto text-sm text-ink-text-label">
        <CodeHighlight
          language={match[1]}
          customStyle={{ margin: 0, padding: 0, background: 'transparent' }}
        >
          {String(children).replace(/\n$/, '')}
        </CodeHighlight>
      </div>
    </div>
  );
};
