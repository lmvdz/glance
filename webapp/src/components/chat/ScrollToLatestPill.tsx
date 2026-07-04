import React from 'react';
import { ArrowDown } from 'lucide-react';

/**
 * Floating "jump to latest" affordance for the chat transcript viewport.
 *
 * Shown when new content has arrived while the viewport is unlocked (the
 * operator scrolled up) — see `useChatStreamScroll` + `useChatNewMessages`
 * in `hooks/chat/`. Clicking re-locks and snaps/springs back to bottom.
 */
export const ScrollToLatestPill = ({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) => {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        aria-label="Jump to latest messages"
        className="pill-rise pointer-events-auto flex min-h-8 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-lg transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <ArrowDown className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        New messages
      </button>
    </div>
  );
};
