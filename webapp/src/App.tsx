/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Bot } from 'lucide-react';
import { WorkbenchPane } from './components/WorkbenchPane';
import { TaskDetail } from './components/TaskDetail';
import { TaskListView } from './components/TaskListView';
import { TaskProvider, useTaskContext } from './context/TaskContext';
import { GlobalShortcuts } from './components/GlobalShortcuts';
import { ToastContainer } from './components/ToastContainer';
import { ThemeProvider } from './context/ThemeContext';
import { AssistantChat } from './components/AssistantChat';
import { CapabilityPanel } from './components/CapabilityPanel';
import { CommandPalette } from './components/CommandPalette';
import { OmpGraphPanel } from './components/OmpGraphPanel';
import { IntervenceView } from './components/IntervenceView';
import { DesignReviewView } from './components/DesignReviewView';
import { WorkspaceCockpit } from './components/WorkspaceCockpit';
import { FactoryStatusStrip } from './components/FactoryStatusStrip';
import { OrgSettings } from './components/OrgSettings';
import { FirstRunSetup } from './components/FirstRunSetup';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import { PendingApproval } from './components/PendingApproval';
import { Loader2 } from 'lucide-react';

const readStoredBoolean = (key: string, fallback: boolean) => {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === 'true';
};

const MainContent = () => {
  const { view, selectedTaskId, currentProject } = useTaskContext();
  const { status } = useAuth();

  // db-mode dead-end: a freshly-provisioned org has no project, so every view is empty and there's
  // no way to add the first repo. Route to onboarding until a project exists. (File mode always has
  // the cwd project, so status==='file' never trips this; 'org' is the settings escape hatch.)
  if (status === 'authed' && !currentProject && view !== 'org') return <FirstRunSetup />;

  {/* The four-item shell (GRAPH-FOLD.md §6e): Fleet · Tasks · Graph · Capabilities, plus the
      routed-into views (org via the AccountMenu gear, intervene via a "Needs you" tap, review via
      its deep-linkable hash). The eight dead keys aren't handled here because they can't ARRIVE
      here: they're gone from the AppView union, and the one out-of-type-system source (the
      localStorage-persisted view) is coerced through lib/viewAlias.ts's alias map before it ever
      becomes state — automation/heat/… → omp-graph, fleet-health/attention/… → fleet,
      federation → org, knowledge → omp-graph + the ⌘K palette auto-opening. */}
  if (view === 'fleet') return <WorkspaceCockpit />;
  if (view === 'intervene') return <IntervenceView />;
  if (view === 'review') return <DesignReviewView />;
  if (view === 'capabilities') return <CapabilityPanel />;
  if (view === 'omp-graph') return <OmpGraphPanel />;
  if (view === 'org') return <OrgSettings />;
  if (view === 'tasks' && !selectedTaskId) return <TaskListView />;

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
      {/* Factory liveness is a first-glance concern, so the strip sits ABOVE every view — an idle-but-alive
          fleet must never again be indistinguishable from a dead one, on any screen. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <FactoryStatusStrip />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <MainContent />
        </div>
      </div>
      {isChatOpen ? (
        <AssistantChat onClose={() => setIsChatOpen(false)} />
      ) : (
        // Steering must be reachable from EVERY view, not just Tasks — the chat panel is
        // where agent controls (answer, verify, land) live.
        <button
          onClick={() => setIsChatOpen(true)}
          className="fixed bottom-4 right-4 z-40 flex min-h-10 items-center gap-1.5 rounded-full bg-gray-900 px-3.5 py-2 text-xs font-semibold text-white shadow-lg transition-colors hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white dark:focus-visible:ring-offset-gray-950"
          aria-label="Open agent chat"
        >
          <Bot className="h-4 w-4" aria-hidden="true" /> Agent
        </button>
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
  if (status === 'pending') return <PendingApproval />;
  return <>{children}</>;
};

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
          <TaskProvider>
            <GlobalShortcuts />
            <AppContent />
            {/* ⌘K opens the palette from EVERY view — mounted beside (not inside) AppContent so
                no view-level conditional can unmount it. */}
            <CommandPalette />
            <ToastContainer />
          </TaskProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  );
}
