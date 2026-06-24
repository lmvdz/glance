import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Single app-level ticker (120ms cadence, matching the SPA's one setInterval).
// Spinner + RelativeTime subscribe via useTick()/useNow() instead of each
// holding its own timer.
// ponytail: one interval for the whole tree; if a view ever needs a different
// cadence, pass an interval prop rather than spawning a second provider.
const TICK_MS = 120;

const TickContext = createContext<number>(0);

export function TickProvider({ children, intervalMs = TICK_MS }: { children: ReactNode; intervalMs?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return <TickContext.Provider value={tick}>{children}</TickContext.Provider>;
}

/** Monotonic tick counter; bumps every 120ms. Use to animate spinner frames. */
export function useTick(): number {
  return useContext(TickContext);
}

/** Re-renders on each tick; returns Date.now() for live relative-time display. */
export function useNow(): number {
  useContext(TickContext);
  return Date.now();
}
