import { useState } from "react";
import type { ReactNode } from "react";

interface TwoPanelLayoutProps {
  left: ReactNode;
  right: ReactNode;
  activePanelHint?: "left" | "right";
}

/** 40/60 split on desktop; tabbed single-panel below lg. */
export function TwoPanelLayout({ left, right, activePanelHint }: TwoPanelLayoutProps) {
  const [active, setActive] = useState<"left" | "right">(activePanelHint ?? "left");
  const [prevHint, setPrevHint] = useState(activePanelHint);
  if (activePanelHint !== prevHint) {
    setPrevHint(activePanelHint);
    if (activePanelHint) setActive(activePanelHint);
  }
  return (
    <div className="h-full">
      <div className="hidden h-full lg:flex">
        <div className="min-h-0 w-2/5 overflow-y-auto">{left}</div>
        <div className="w-px bg-gradient-to-b from-border-strong via-border to-transparent" />
        <div className="flex min-h-0 w-3/5 flex-col overflow-hidden">{right}</div>
      </div>
      <div className="flex h-full flex-col lg:hidden">
        <div className="flex shrink-0 border-b border-border bg-surface">
          <Tab label="Structure" active={active === "left"} onClick={() => setActive("left")} />
          <Tab label="Details" active={active === "right"} onClick={() => setActive("right")} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{active === "left" ? left : right}</div>
      </div>
    </div>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex-1 py-2.5 text-sm font-medium transition-opacity " +
        (active ? "border-b-2 border-accent text-text-primary" : "text-text-muted hover:opacity-60")
      }
    >
      {label}
    </button>
  );
}
