/**
 * PageContextDebugPanel — Feature 2 D1's acceptance criterion ("each view's context in a debug
 * readout + screenshot", plans/orchestration/CANVAS-AND-PAGE-CHAT.md). Dev-builds only (checked
 * via `import.meta.env.DEV`, so this never ships in a production bundle) — a hidden ⌃⇧D hotkey
 * dumps the LIVE PageContext every view is publishing, so a screenshot can prove "the chat really
 * does know I'm on Tasks/Graph/Fleet" without instrumenting the network tab.
 */
import React, { useEffect, useState } from 'react';
import { usePageContext } from '../context/PageContext';

const isDev = (): boolean => {
  try {
    // Vite exposes this at build time; guarded so a non-Vite test runner (bun:test via
    // react-dom/server) never throws reaching for `import.meta.env`.
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
};

export const PageContextDebugPanel: React.FC = () => {
  const pageContext = usePageContext();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isDev()) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!isDev() || !open) return null;

  return (
    <div
      data-testid="page-context-debug-panel"
      className="fixed bottom-16 right-4 z-50 flex max-h-[60vh] w-96 flex-col overflow-hidden rounded-lg border border-gray-700 bg-black/90 shadow-2xl"
    >
      <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-700 px-3 py-1.5 text-[11px] text-gray-400">
        <span>PageContext (dev only — ⌃⇧D to toggle)</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded px-1 text-gray-500 hover:bg-gray-800 hover:text-gray-200"
          aria-label="Close PageContext debug panel"
        >
          ×
        </button>
      </div>
      <pre
        data-testid="page-context-debug-json"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-emerald-300"
      >
        {pageContext ? JSON.stringify(pageContext, null, 2) : 'null — no view has published a PageContext yet'}
      </pre>
    </div>
  );
};
