import { useEffect, useState } from "react";
import { useSquad } from "@/hooks/useSquad";
import { useLiveness } from "@/hooks/useLiveness";
import { TickProvider } from "@/lib/tick";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TopBar } from "@/components/layout/TopBar";
import { Sidebar, type View } from "@/components/layout/Sidebar";
import { AgentsView } from "@/components/views/AgentsView";
import { FeaturesView } from "@/components/views/FeaturesView";
import { GraphPane } from "@/components/views/GraphPane";
import { InboxView } from "@/components/views/InboxView";
import { FeedbackLoopView } from "@/components/views/FeedbackLoopView";
import { AuditView } from "@/components/views/AuditView";
import { NetworkView } from "@/components/views/NetworkView";
import { HeatmapView } from "@/components/views/HeatmapView";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { groupProjects } from "@/lib/projects";
import { ProjectView } from "@/components/views/ProjectView";
import { ConsoleView } from "@/components/views/ConsoleView";
import { DashboardPagesView } from "@/components/views/DashboardPagesView";
import { featureHash, parseHash, projectHash, viewHash } from "@/lib/routes";
import { inboxActionCount } from "@/lib/inbox";


export function App() {
  const squad = useSquad();
  useLiveness(squad.agents);
  const [{ view, sel, taskId, handoffContext }, setRoute] = useState(() => parseHash(location.hash));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [light, setLight] = useState(() => document.documentElement.classList.contains("light"));

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (v: View) => {
    location.hash = viewHash(v);
  };
  const select = (id: string) => {
    location.hash = view === "features" ? featureHash(id) : "#/" + view + "/" + encodeURIComponent(id);
  };
  const selectIn = (v: View, id: string) => {
    location.hash = v === "features" ? featureHash(id) : "#/" + v + "/" + encodeURIComponent(id);
  };
  const clear = () => {
    location.hash = view === "project" && sel ? projectHash(sel) : viewHash(view);
  };
  const toggleTheme = () => {
    document.documentElement.classList.toggle("light");
    setLight(document.documentElement.classList.contains("light"));
  };

  const waiting = inboxActionCount(squad.agents);
  const projects = groupProjects(squad.features, squad.agents);

  return (
    <TickProvider>
      <TooltipProvider>
        <ToastProvider>
          <div className="relative flex flex-col overflow-hidden bg-base text-text-primary" style={{ height: "var(--viewport-height)" }}>
            <TopBar
              agents={squad.agents}
              features={squad.features}
              connected={squad.connected}
              light={light}
              onToggleTheme={toggleTheme}
              onOpenPalette={() => setPaletteOpen(true)}
            />
            <div className="flex min-h-0 flex-1">
              <Sidebar
                view={view}
                selectedId={sel}
                onView={go}
                counts={{ inbox: waiting, agents: squad.agents.length, features: squad.features.length }}
                projects={projects}
                agents={squad.agents}
                activeRepo={view === "project" ? sel : null}
                onProject={(repo) => {
                  location.hash = projectHash(repo);
                }}
                onAgent={(id) => selectIn("agents", id)}
              />
              <main className="min-w-0 flex-1 overflow-hidden bg-base">
                {view === "console" && <ConsoleView squad={squad} handoffContext={handoffContext} />}
                {view === "agents" && <AgentsView squad={squad} selectedId={sel} onSelect={select} />}
                {view === "features" && <FeaturesView squad={squad} selectedId={sel} onSelect={select} onClose={clear} />}
                {view === "graph" && <GraphPane squad={squad} selectedId={sel} onSelect={select} onClose={clear} />}
                {view === "heatmap" && <HeatmapView />}
                {view === "inbox" && <InboxView squad={squad} />}
                {view === "feedback-loop" && <FeedbackLoopView selectedId={sel} onSelect={select} onClose={clear} />}
                {view === "audit" && <AuditView />}
                {view === "network" && <NetworkView squad={squad} />}
                {view === "project" && sel ? <ProjectView repo={sel} taskId={taskId} squad={squad} /> : null}
                {["profiles", "tournaments", "observability", "governance", "settings", "conflicts", "onboarding"].includes(view) ? (
                  <DashboardPagesView page={view} squad={squad} onView={go} />
                ) : null}
              </main>
            </div>
          </div>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            squad={squad}
            onView={go}
            onSelectAgent={(id) => selectIn("agents", id)}
            onSelectFeature={(id) => selectIn("features", id)}
            onToggleTheme={toggleTheme}
          />
        </ToastProvider>
      </TooltipProvider>
    </TickProvider>
  );
}
