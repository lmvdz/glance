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
import { AuditView } from "@/components/views/AuditView";
import { CommandPalette } from "@/components/palette/CommandPalette";

const VIEWS = ["inbox", "agents", "features", "graph", "audit"] as const;

function readHash(): { view: View; sel: string | null } {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/");
  const view = (VIEWS as readonly string[]).includes(parts[0]) ? (parts[0] as View) : "agents";
  const sel = parts.length > 1 && parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : null;
  return { view, sel };
}

export function App() {
  const squad = useSquad();
  useLiveness(squad.agents);
  const [{ view, sel }, setRoute] = useState(readHash);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [light, setLight] = useState(() => document.documentElement.classList.contains("light"));

  useEffect(() => {
    const onHash = () => setRoute(readHash());
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
    location.hash = "#/" + v;
  };
  const select = (id: string) => {
    location.hash = "#/" + view + "/" + encodeURIComponent(id);
  };
  const selectIn = (v: View, id: string) => {
    location.hash = "#/" + v + "/" + encodeURIComponent(id);
  };
  const clear = () => {
    location.hash = "#/" + view;
  };
  const toggleTheme = () => {
    document.documentElement.classList.toggle("light");
    setLight(document.documentElement.classList.contains("light"));
  };

  const waiting = squad.agents.filter((a) => a.status === "input" || a.status === "error").length;

  return (
    <TickProvider>
      <TooltipProvider>
        <ToastProvider>
          <div className="flex flex-col" style={{ height: "var(--viewport-height)" }}>
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
                onView={go}
                counts={{ inbox: waiting, agents: squad.agents.length, features: squad.features.length }}
              />
              <main className="min-w-0 flex-1 overflow-hidden">
                {view === "agents" && <AgentsView squad={squad} selectedId={sel} onSelect={select} />}
                {view === "features" && <FeaturesView squad={squad} selectedId={sel} onSelect={select} onClose={clear} />}
                {view === "graph" && <GraphPane squad={squad} selectedId={sel} onSelect={select} onClose={clear} />}
                {view === "inbox" && <InboxView squad={squad} />}
                {view === "audit" && <AuditView />}
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
