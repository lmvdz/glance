import { useEffect, useRef } from "react";
import type { AgentDTO } from "../lib/dto";

/**
 * Ambient attention routing: reflects the waiting count in the document title
 * and fires a desktop notification when an agent newly needs input or errors.
 * "Route attention, don't demand it."
 */
export function useLiveness(agents: AgentDTO[]): void {
  const prev = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const waiting = agents.filter((a) => a.status === "input" || a.status === "error");
    document.title = waiting.length > 0 ? `(${waiting.length}) omp-squad` : "omp-squad";
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const a of waiting) {
        if (!prev.current.has(a.id)) {
          new Notification("omp-squad", { body: `${a.name} needs you`, tag: a.id });
        }
      }
    }
    prev.current = new Set(waiting.map((a) => a.id));
  }, [agents]);
}
