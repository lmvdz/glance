/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { HubShell } from './components/hub/HubShell';
import { TaskDetail } from './components/TaskDetail';
import { TaskListView } from './components/TaskListView';
import { TaskProvider, useTaskContext } from './context/TaskContext';
import { PageContextProvider, PageContextScope } from './context/PageContext';
import {
  deriveCapabilitiesPageContext,
  deriveOrgPageContext,
  deriveReviewPageContext,
  deriveTasksPageContext,
} from './lib/pageContextDerive';
import { GlobalShortcuts } from './components/GlobalShortcuts';
import { ToastContainer } from './components/ToastContainer';
import { ThemeProvider } from './context/ThemeContext';
import { BorrowedSurface } from './components/hub/BorrowedSurface';
import { CommandPalette } from './components/CommandPalette';
import { OmpGraphPanel } from './components/OmpGraphPanel';
import { UnseenSurface } from './components/hub/UnseenSurface';
import { MondaySurface } from './components/hub/MondaySurface';
import { CostSurface } from './components/hub/CostSurface';
import { DesignReviewView } from './components/DesignReviewView';
import { RealitySurface } from './components/hub/RealitySurface';
import { PlanSurface } from './components/hub/PlanSurface';
import { VerdictSurface } from './components/hub/VerdictSurface';
import { PeopleSurface } from './components/hub/PeopleSurface';
import { FileSignIn } from './components/FileSignIn';
import { FirstRunSetup } from './components/FirstRunSetup';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import { PendingApproval } from './components/PendingApproval';
import { PageContextDebugPanel } from './components/PageContextDebugPanel';
import { VoiceCallProvider } from './context/VoiceCallContext';
import { VoiceCallPill } from './components/chat/VoiceCallPill';
import { parseHubHash, shouldColdBootFleet, type HubRoute } from './lib/router';
import { Loader2 } from 'lucide-react';

const useHubRoute = () => {
  const [route, setRoute] = React.useState(() => parseHubHash(typeof window === 'undefined' ? '' : window.location.hash));
  React.useEffect(() => {
    const sync = () => setRoute(parseHubHash(window.location.hash));
    if (shouldColdBootFleet(window.location.hash)) window.location.hash = '#fleet';
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return route;
};

const WorkbenchRoute = ({ route }: { route: Extract<HubRoute, { kind: 'workbench' }> }) => {
  const { selectedTaskId, selectTask, currentProject, tasks, taskFilter, tasksListMode, reviewTaskId, reviewDocPath, capabilities, publicCatalog } = useTaskContext();
  const { status } = useAuth();

  React.useEffect(() => {
    if (route.view === 'task' && route.id) selectTask(route.id);
  }, [route.view, route.id, selectTask]);
  const reviewTask = React.useMemo(() => tasks.find((t) => t.id === reviewTaskId || t.sourceId === reviewTaskId), [tasks, reviewTaskId]);
  const tasksPageContext = React.useMemo(
    () => deriveTasksPageContext({ tasks, selectedTaskId, taskFilter, listMode: tasksListMode }),
    [tasks, selectedTaskId, taskFilter, tasksListMode],
  );
  const reviewPageContext = React.useMemo(
    () => deriveReviewPageContext({ reviewTaskId, reviewDocPath, task: reviewTask }),
    [reviewTaskId, reviewDocPath, reviewTask],
  );
  const capabilitiesPageContext = React.useMemo(
    () => deriveCapabilitiesPageContext({ capabilities, publicCatalog }),
    [capabilities, publicCatalog],
  );
  const orgPageContext = React.useMemo(() => deriveOrgPageContext(), []);

  if (status === 'authed' && !currentProject && route.view !== 'org') return <FirstRunSetup />;
  if (route.view === 'fog') return <UnseenSurface />;
  if (route.view === 'daily') return <MondaySurface />;
  if (route.view === 'economics') return <CostSurface />;
  if (route.view === 'review') {
    return (
      <PageContextScope value={reviewPageContext}>
        <DesignReviewView />
      </PageContextScope>
    );
  }
  if (route.view === 'capabilities') return <BorrowedSurface />;
  if (route.view === 'graph') return <OmpGraphPanel />;
  if (route.view === 'plan-reality') return <RealitySurface />;
  if (route.view === 'plans') return <PlanSurface name={route.id} />;
  if (route.view === 'gate-verdict') return <VerdictSurface routeId={route.id} />;
  if (route.view === 'org') return <PeopleSurface />;
  if (route.view === 'tasks' && !selectedTaskId) {
    return (
      <PageContextScope value={tasksPageContext}>
        <TaskListView />
      </PageContextScope>
    );
  }

  return (
    <PageContextScope value={tasksPageContext}>
      <TaskDetail />
    </PageContextScope>
  );
};

const AppContent = () => {
  const route = useHubRoute();
  return (
    <>
      <HubShell route={route} renderWorkbench={(workbenchRoute) => <WorkbenchRoute route={workbenchRoute} />} />
      <PageContextDebugPanel />
    </>
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
  // File mode's own signed-out state. Without it the SPA rendered the whole dashboard against a daemon
  // that was 401ing every call, so an unauthenticated browser saw an empty fleet instead of a sign-in.
  if (status === 'file-anon') return <FileSignIn />;
  if (status === 'pending') return <PendingApproval />;
  return <>{children}</>;
};

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
          <TaskProvider>
            {/* PageContextProvider sits ABOVE both the publishers (every MainContent view branch)
                and the readers (AssistantChat's context assembly, the debug panel) — see
                context/PageContext.tsx for why this can't just be threaded as a prop. */}
            <PageContextProvider>
              <GlobalShortcuts />
              {/* VoiceCallProvider owns the live VoiceSession (webapp-voice-lane concern 08,
                  DESIGN.md "Session ownership" row) — it must sit ABOVE AssistantChat (rendered
                  deep inside AppContent, conditional on `isChatOpen`) so a closed/deleted chat
                  panel never takes the call down with it. VoiceCallPill is mounted beside
                  AppContent, same pattern as CommandPalette/ToastContainer below, so no
                  view-level conditional can unmount the in-call HUD either. */}
              <VoiceCallProvider>
                <AppContent />
                <VoiceCallPill />
              </VoiceCallProvider>
              {/* ⌘K opens the palette from EVERY view — mounted beside (not inside) AppContent so
                  no view-level conditional can unmount it. */}
              <CommandPalette />
              <ToastContainer />
            </PageContextProvider>
          </TaskProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  );
}
