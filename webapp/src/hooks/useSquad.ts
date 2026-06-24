import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDTO, ClientCommand, CommandInfo, FeatureDTO, SquadEvent, TranscriptEntry } from "../lib/dto";
import { apiFetch, connectSquad, type SquadSocket } from "../lib/ws";

/** Keep at most this many transcript entries per agent in memory. */
const TRANSCRIPT_CAP = 800;

export interface SquadState {
  agents: AgentDTO[];
  features: FeatureDTO[];
  transcripts: Map<string, TranscriptEntry[]>;
  commands: Map<string, CommandInfo[]>;
  connected: boolean;
  send: (cmd: ClientCommand) => void;
  subscribe: (id: string) => void;
}

/**
 * Single source of fleet state for the SPA: subscribes to the SquadServer WS
 * (roster/agent/removed/transcript/commands) and fetches /api/features. Replaces
 * piyaz's TanStack Query + SSE. `subscribe(id)` asks for one agent's transcript
 * replay and is re-issued automatically on reconnect for the open agent.
 */
export function useSquad(): SquadState {
  const [agents, setAgents] = useState<Map<string, AgentDTO>>(() => new Map());
  const [features, setFeatures] = useState<FeatureDTO[]>([]);
  const [transcripts, setTranscripts] = useState<Map<string, TranscriptEntry[]>>(() => new Map());
  const [commands, setCommands] = useState<Map<string, CommandInfo[]>>(() => new Map());
  const [connected, setConnected] = useState(false);
  const sockRef = useRef<SquadSocket | null>(null);
  const subscribedRef = useRef<string | null>(null);

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
        const id = subscribedRef.current;
        if (id) sockRef.current?.send({ type: "subscribe", id });
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
          case "transcript": {
            const { id, entry } = ev;
            setTranscripts((prev) => {
              const m = new Map(prev);
              const arr = m.get(id) ?? [];
              m.set(id, arr.length >= TRANSCRIPT_CAP ? [...arr.slice(arr.length - TRANSCRIPT_CAP + 1), entry] : [...arr, entry]);
              return m;
            });
            break;
          }
          case "commands": {
            const { id, commands: list } = ev;
            setCommands((prev) => {
              const m = new Map(prev);
              m.set(id, list);
              return m;
            });
            break;
          }
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

  const send = useCallback((cmd: ClientCommand) => sockRef.current?.send(cmd), []);
  const subscribe = useCallback((id: string) => {
    subscribedRef.current = id;
    sockRef.current?.send({ type: "subscribe", id });
  }, []);

  return {
    agents: [...agents.values()],
    features,
    transcripts,
    commands,
    connected,
    send,
    subscribe,
  };
}
