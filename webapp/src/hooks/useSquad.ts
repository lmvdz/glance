import { useEffect, useRef, useState } from "react";
import type { AgentDTO, ClientCommand, FeatureDTO, SquadEvent } from "../lib/dto";
import { apiFetch, connectSquad, type SquadSocket } from "../lib/ws";

export interface SquadState {
  agents: AgentDTO[];
  features: FeatureDTO[];
  connected: boolean;
  send: (cmd: ClientCommand) => void;
}

/**
 * Single source of fleet state for the SPA: subscribes to the SquadServer WS
 * (roster/agent/removed) and fetches /api/features (initial + on features-changed).
 * Replaces piyaz's TanStack Query + SSE entirely.
 */
export function useSquad(): SquadState {
  const [agents, setAgents] = useState<Map<string, AgentDTO>>(() => new Map());
  const [features, setFeatures] = useState<FeatureDTO[]>([]);
  const [connected, setConnected] = useState(false);
  const sockRef = useRef<SquadSocket | null>(null);

  useEffect(() => {
    let alive = true;
    const loadFeatures = async () => {
      try {
        const r = await apiFetch("/api/features");
        if (r.ok && alive) setFeatures((await r.json()) as FeatureDTO[]);
      } catch {
        /* daemon unreachable — keep last good features */
      }
    };
    const sock = connectSquad({
      onOpen: () => {
        setConnected(true);
        loadFeatures();
      },
      onClose: () => setConnected(false),
      onEvent: (ev: SquadEvent) => {
        switch (ev.type) {
          case "roster":
            setAgents(new Map(ev.agents.map((a) => [a.id, a])));
            break;
          case "agent": {
            const next = ev.agent;
            setAgents((prev) => {
              const m = new Map(prev);
              m.set(next.id, next);
              return m;
            });
            break;
          }
          case "removed":
            setAgents((prev) => {
              const m = new Map(prev);
              m.delete(ev.id);
              return m;
            });
            break;
          case "features-changed":
            loadFeatures();
            break;
          default:
            break;
        }
      },
    });
    sockRef.current = sock;
    return () => {
      alive = false;
      sock.close();
    };
  }, []);

  return {
    agents: [...agents.values()],
    features,
    connected,
    send: (cmd) => sockRef.current?.send(cmd),
  };
}
