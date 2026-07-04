import React, { useState } from 'react';
import { Send } from 'lucide-react';
import type { PendingRequest } from '../../lib/dto';

// Moved verbatim from AssistantChat.tsx (concern 09 — monolith split).

export const GateWidget = ({
  request,
  onAnswer,
}: {
  request: PendingRequest;
  onAnswer: (value: string) => void;
}) => {
  const [text, setText] = useState('');
  if (request.options && request.options.length > 0) {
    return (
      <div data-chat-message className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/60 dark:bg-amber-950/20">
        <div className="mb-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{request.title}</div>
        <div className="flex flex-wrap gap-2">
          {request.options.map((opt) => (
            <button
              key={opt}
              onClick={() => onAnswer(opt)}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div data-chat-message className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/60 dark:bg-amber-950/20">
      <div className="mb-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{request.title}</div>
      {request.message && <div className="mb-2 text-[11px] text-gray-600 dark:text-gray-400">{request.message}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (text.trim()) { onAnswer(text.trim()); setText(''); }
          }
        }}
        rows={2}
        placeholder={request.placeholder ?? 'Type your reply…'}
        className="w-full resize-y rounded-md border border-amber-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-700 dark:bg-gray-950 dark:text-gray-100"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => { if (text.trim()) { onAnswer(text.trim()); setText(''); } }}
          disabled={!text.trim()}
          className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3 w-3" aria-hidden />
          Send
        </button>
      </div>
    </div>
  );
};
