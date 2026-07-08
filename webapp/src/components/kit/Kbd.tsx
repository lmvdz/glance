import React from 'react';

/**
 * Kbd — a keyboard-hint chip ("N", "c", "] next tab"). The reference UIs treat keyboard hints
 * as first-class chrome (UI-REFERENCES.md "Shared visual DNA"); glance had hints buried in
 * `title` tooltips only. This makes them visible, monospace, low-contrast furniture that never
 * competes with real content.
 */
export interface KbdProps {
  /** The literal key(s) to show inside the bordered key box, e.g. "N", "⌘↵", "]". */
  keys: string;
  /** Optional trailing description, e.g. "next tab" for `keys="]"`. */
  label?: string;
  className?: string;
}

export const Kbd: React.FC<KbdProps> = ({ keys, label, className }) => (
  <span className={`inline-flex flex-shrink-0 items-center gap-1.5 font-mono text-[10px] text-gray-400 dark:text-gray-500 ${className ?? ''}`}>
    <kbd className="rounded border border-gray-300 bg-gray-100 px-1 py-0.5 leading-none text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
      {keys}
    </kbd>
    {label && <span className="whitespace-nowrap">{label}</span>}
  </span>
);
