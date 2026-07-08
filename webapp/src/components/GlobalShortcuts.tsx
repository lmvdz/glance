import React, { useEffect } from 'react';
import { useTaskContext } from '../context/TaskContext';

export const GlobalShortcuts = () => {
  const { addTask, deleteTask, selectedTaskId, toggleCommandPalette } = useTaskContext();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K — toggle the command palette (GRAPH-FOLD.md §3). Handled BEFORE the input
      // guard so it works from anywhere, including while typing — the conventional palette
      // binding. The old direct jump-to-task-search behavior (PR #124) lives on as the palette's
      // "Search tasks…" row instead of being the raw hotkey.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      // Don't trigger the remaining shortcuts if user is typing in an input field
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (isInput) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        addTask({
          title: 'New Task',
          category: 'frontend',
          duration: '1d',
          status: 'todo',
        });
      }

      if (e.key === 'Backspace' && selectedTaskId) {
        e.preventDefault();
        deleteTask(selectedTaskId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addTask, deleteTask, selectedTaskId, toggleCommandPalette]);

  return null;
};
