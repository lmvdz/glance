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
    <div className="relative group rounded-md overflow-hidden bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 my-4">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
        <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">{match[1]}</span>
        <button
          onClick={handleCopy}
          className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors flex items-center gap-1 text-xs"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500 dark:text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="p-4 overflow-x-auto text-sm text-gray-700 dark:text-gray-300">
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
