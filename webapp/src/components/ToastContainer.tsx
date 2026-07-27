import React from 'react';
import { useTaskContext } from '../context/TaskContext';

/**
 * ToastContainer — the one place the product speaks without being asked.
 *
 * It was a rounded panel with a coloured glyph and a drop shadow, floating bottom-right — a
 * notification widget. The room's whole visual argument is that severity is a 2px rule and never a
 * filled panel with an icon, so this uses the same treatment as every card in the timeline: a tone
 * rule on the left, prose, no shadow, no glyph.
 *
 * It also stays put. Sliding in from the bottom draws the eye to something that is, by definition,
 * already over — the toast reports what happened, and animation implies it is happening.
 */

const TONE: Record<string, string> = { success: '#3E7D57', error: '#B4553A', info: '#3E5C8A' };

export const ToastContainer = () => {
  const { toasts } = useTaskContext();
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="max-w-[420px] px-3.5 py-2.5 text-[12.5px] leading-[1.5]"
          style={{
            background: '#0C0C0D',
            border: '1px solid #1F1F22',
            borderLeft: `2px solid ${TONE[toast.type] ?? '#2A2A30'}`,
            color: '#DEDEE2',
            textWrap: 'pretty',
          }}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
};
