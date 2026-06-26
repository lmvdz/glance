import { useEffect, useRef } from "react";
import type { AgentDTO } from "../lib/dto";
import { foldInbox } from "../lib/inbox";

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
    const waiting = foldInbox(agents);
    document.title = waiting.length > 0 ? `(${waiting.length}) omp-squad` : "omp-squad";
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const row of waiting) {
        const key = row.kind === "pending" ? `${row.agent.id}:${row.req.id}` : `${row.agent.id}:${row.kind}`;
        if (!prev.current.has(key)) {
          const action = row.kind === "pending" ? row.req.title : row.kind === "landReady" ? "ready to land" : "errored";
          new Notification("omp-squad", { body: `${row.agent.name}: ${action}`, tag: key });
        }
      }
    }
    prev.current = new Set(waiting.map((row) => row.kind === "pending" ? `${row.agent.id}:${row.req.id}` : `${row.agent.id}:${row.kind}`));
  }, [agents]);
}
