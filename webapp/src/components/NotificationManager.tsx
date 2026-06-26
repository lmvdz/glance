import { useEffect, useRef } from 'react';
import { useTaskContext } from '../context/TaskContext';

export const NotificationManager = () => {
  const { tasks } = useTaskContext();
  const notifiedTasks = useRef<Set<string>>(new Set());

  useEffect(() => {
    if ('Notification' in window) {
      if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }
  }, []);

  useEffect(() => {
    const checkDueDates = () => {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;

      const now = new Date().getTime();

      tasks.forEach(task => {
        if (task.status !== 'done' && task.dueDate) {
          const dueDate = new Date(task.dueDate).getTime();
          
          // Trigger notification if due within the next minute (or past due slightly)
          // and we haven't notified for this task yet.
          if (dueDate > 0 && dueDate - now <= 0 && !notifiedTasks.current.has(task.id)) {
            new Notification('Task Due!', {
              body: `The task "${task.title}" is due now.`,
              icon: '/favicon.ico'
            });
            notifiedTasks.current.add(task.id);
          }
        }
      });
    };

    const interval = setInterval(checkDueDates, 60000); // check every minute
    checkDueDates(); // initial check

    return () => clearInterval(interval);
  }, [tasks]);

  return null;
};
