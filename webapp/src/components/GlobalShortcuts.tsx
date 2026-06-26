import React, { useEffect } from 'react';
import { useTaskContext } from '../context/TaskContext';

export const GlobalShortcuts = () => {
  const { addTask, deleteTask, selectedTaskId } = useTaskContext();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if user is typing in an input field
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
  }, [addTask, deleteTask, selectedTaskId]);

  return null;
};
