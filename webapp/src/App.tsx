/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Sidebar } from './components/Sidebar';
import { TaskList } from './components/TaskList';
import { TaskDetail } from './components/TaskDetail';
import { TaskProvider, useTaskContext } from './context/TaskContext';
import { GlobalShortcuts } from './components/GlobalShortcuts';
import { ToastContainer } from './components/ToastContainer';
import { ThemeProvider } from './context/ThemeContext';
import { NotificationManager } from './components/NotificationManager';
import { AssistantChat } from './components/AssistantChat';
import { CapabilityPanel } from './components/CapabilityPanel';

const readStoredBoolean = (key: string, fallback: boolean) => {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === 'true';
};

const MainContent = ({ taskListCollapsed, onToggleTaskList }: { taskListCollapsed: boolean; onToggleTaskList: () => void }) => {
  const { view } = useTaskContext();
  
  if (view === 'capabilities') {
    return <CapabilityPanel />;
  }
  
  return (
    <>
      <TaskList collapsed={taskListCollapsed} onToggleCollapsed={onToggleTaskList} />
      <TaskDetail />
    </>
  );
};

const AppContent = () => {
  const { isChatOpen, setIsChatOpen } = useTaskContext();
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => readStoredBoolean('omp.sidebar.collapsed', false));
  const [taskListCollapsed, setTaskListCollapsed] = React.useState(() => readStoredBoolean('omp.taskList.collapsed', false));

  React.useEffect(() => {
    window.localStorage.setItem('omp.sidebar.collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  React.useEffect(() => {
    window.localStorage.setItem('omp.taskList.collapsed', String(taskListCollapsed));
  }, [taskListCollapsed]);
  
  return (
    <div className="h-screen w-full flex overflow-hidden text-sm font-sans bg-[#f7f8f9] dark:bg-gray-950 text-gray-800 dark:text-gray-200 transition-colors duration-200">
      <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)} />
      <MainContent taskListCollapsed={taskListCollapsed} onToggleTaskList={() => setTaskListCollapsed((collapsed) => !collapsed)} />
      {isChatOpen && (
        <AssistantChat onClose={() => setIsChatOpen(false)} />
      )}
    </div>
  );
};

export default function App() {
  return (
    <ThemeProvider>
      <TaskProvider>
        <NotificationManager />
        <GlobalShortcuts />
        <AppContent />
        <ToastContainer />
      </TaskProvider>
    </ThemeProvider>
  );
}
