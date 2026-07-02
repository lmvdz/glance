/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { WorkbenchPane } from './components/WorkbenchPane';
import { TaskDetail } from './components/TaskDetail';
import { TaskProvider, useTaskContext } from './context/TaskContext';
import { GlobalShortcuts } from './components/GlobalShortcuts';
import { ToastContainer } from './components/ToastContainer';
import { ThemeProvider } from './context/ThemeContext';
import { NotificationManager } from './components/NotificationManager';
import { AssistantChat } from './components/AssistantChat';
import { CapabilityPanel } from './components/CapabilityPanel';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import { Loader2 } from 'lucide-react';

const readStoredBoolean = (key: string, fallback: boolean) => {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === 'true';
};

const MainContent = () => {
  const { view } = useTaskContext();
  
  if (view === 'capabilities') {
    return <CapabilityPanel />;
  }
  
  return (
    <>
      <TaskDetail />
    </>
  );
};

const AppContent = () => {
  const { isChatOpen, setIsChatOpen } = useTaskContext();
  const [workbenchCollapsed, setWorkbenchCollapsed] = React.useState(() => readStoredBoolean('omp.workbench.collapsed', false));

  React.useEffect(() => {
    window.localStorage.setItem('omp.workbench.collapsed', String(workbenchCollapsed));
  }, [workbenchCollapsed]);
  
  return (
    <div className="h-screen w-full flex overflow-hidden text-sm font-sans bg-[#f7f8f9] dark:bg-gray-950 text-gray-800 dark:text-gray-200 transition-colors duration-200">
      <WorkbenchPane collapsed={workbenchCollapsed} onToggleCollapsed={() => setWorkbenchCollapsed((collapsed) => !collapsed)} />
      <MainContent />
      {isChatOpen && (
        <AssistantChat onClose={() => setIsChatOpen(false)} />
      )}
    </div>
  );
};

// Gate the app on auth. File mode renders straight through (legacy bearer-token behavior); db mode shows
// the login screen until there's a valid session. A brief splash covers the initial mode/session probe.
const AuthGate = ({ children }: { children: React.ReactNode }) => {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#0a0a0b]">
        <Loader2 className="h-5 w-5 animate-spin text-[#5c5c62]" />
      </div>
    );
  }
  if (status === 'anon') return <Login />;
  return <>{children}</>;
};

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
          <TaskProvider>
            <NotificationManager />
            <GlobalShortcuts />
            <AppContent />
            <ToastContainer />
          </TaskProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  );
}
