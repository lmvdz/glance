import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDTO, ArtifactCommentDTO, CapabilitySnapshotDTO, ChannelEntry, ClientCommand, CommandAckDTO, CommandInfo, FeatureDTO, PresenceSnapshot, ProjectDTO, PublicCapabilityCatalogDTO, SquadEvent, TranscriptEntry } from "../lib/dto";
import { apiJson } from "../lib/api";
import { connectSquad, type SquadSocket } from "../lib/ws";
import { latestSeq, mergeChannelEntry } from "../lib/hub";

const TRANSCRIPT_CAP = 800;

const EMPTY_CAPABILITIES: CapabilitySnapshotDTO = { sources: [], packs: [], installs: [] };

/**
 * Coerce a capability snapshot from the server into one the UI can trust.
 *
 * The panels read `capabilities.packs.length` / `.map(...)` directly, so a body
 * that is missing a field — an older/newer daemon whose `/api/capabilities`
 * shape has drifted, or any partial payload — would throw
 * "can't access property length, packs is undefined" and take down the whole
 * app the moment the nav (which shows a `packs.length` badge) renders. Normalize
 * at the boundary so every consumer sees arrays, whatever the server sent.
 */
export function normalizeCapabilities(value: Partial<CapabilitySnapshotDTO> | null | undefined): CapabilitySnapshotDTO {
  return {
    sources: Array.isArray(value?.sources) ? value.sources : [],
    packs: Array.isArray(value?.packs) ? value.packs : [],
    installs: Array.isArray(value?.installs) ? value.installs : [],
  };
}

/**
 * Coerce the `/api/capability-catalog` body into the array the UI expects.
 *
 * The endpoint returns `{ catalog: [...] }`, and the workbench nav reads
 * `publicCatalog.length` directly. A version-skewed daemon that returns a bare
 * array, an error body, or any shape without a `catalog` array would otherwise
 * leave `publicCatalog` as `undefined` (a missing field is not a thrown error,
 * so the `.catch` fallback never fires) and crash the app the moment the
 * Capability-registry card mounts. Normalize at the boundary so the state is
 * always an array, whatever the server sent.
 */
export function normalizeCatalog(value: unknown): PublicCapabilityCatalogDTO[] {
  if (Array.isArray(value)) return value as PublicCapabilityCatalogDTO[];
  const catalog = (value as { catalog?: unknown } | null | undefined)?.catalog;
  return Array.isArray(catalog) ? (catalog as PublicCapabilityCatalogDTO[]) : [];
}

export interface SquadState {
  agents: AgentDTO[];
  features: FeatureDTO[];
  projects: ProjectDTO[];
  capabilities: CapabilitySnapshotDTO;
  publicCatalog: PublicCapabilityCatalogDTO[];
  transcripts: Map<string, TranscriptEntry[]>;
  commands: Map<string, CommandInfo[]>;
  commentEvents: ArtifactCommentDTO[];
  commandAcks: CommandAckDTO[];
  resolvedCommentEvents: Map<string, number>;
  channelEntries: ChannelEntry[];
  presence: PresenceSnapshot;
  connected: boolean;
  reload: () => Promise<void>;
  send: (command: ClientCommand) => void;
  subscribe: (id: string) => void;
  unsubscribe: (id: string) => void;
}

export function appendTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const match = entry.id ? entries.findIndex((item) => item.id === entry.id) : -1;
  if (match >= 0) {
    const next = entries.slice();
    next[match] = entry;
    return next;
  }
  if (entries.some((item) => !entry.id && item.ts === entry.ts && item.kind === entry.kind && item.text === entry.text)) return entries;
  if (entry.id && entries.length >= TRANSCRIPT_CAP) {
    // The window is at cap and this id isn't present — it may be a late
    // upsert for an entry the cap already evicted. Appending it at the end
    // would put a stale entry after everything newer; drop it instead.
    //
    // Order by `ts` (epoch ms), NOT `seq`: `seq` is an in-memory counter on
    // the daemon that resets to 0 on restart, while persisted+replayed
    // transcripts keep their old high seqs. Comparing seqs here means every
    // live entry after a restart (seq 1, 2, 3…) reads as "older than the
    // head" and gets dropped forever — the chat permanently freezes. `ts` is
    // wall-clock and stays monotonic across restarts.
    //
    // Only drop when both sides actually have a `ts` to compare; if either
    // is missing, fail open and append rather than risk freezing the chat
    // over a rare reorder.
    const head = entries[0];
    if (head && typeof entry.ts === "number" && typeof head.ts === "number" && entry.ts < head.ts) return entries;
  }
  return entries.length >= TRANSCRIPT_CAP ? [...entries.slice(entries.length - TRANSCRIPT_CAP + 1), entry] : [...entries, entry];
}

/**
 * Ids in `subscribed` that no longer appear in the live agent roster —
 * called on every `roster` snapshot (and on an explicit `removed` event) so
 * `subscribedRef` doesn't grow forever across reconnects. Without this, a
 * dead agent id stays in the set and gets re-subscribed on every socket
 * reopen (see `onOpen`'s replay loop below), which piles up server-side
 * subscriptions for agents that no longer exist.
 */
export function staleSubscriptionIds(subscribed: ReadonlySet<string>, liveIds: Iterable<string>): string[] {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  return [...subscribed].filter((id) => !live.has(id));
}

export function useSquad(): SquadState {
  const [agents, setAgents] = useState<Map<string, AgentDTO>>(() => new Map());
  const [features, setFeatures] = useState<FeatureDTO[]>([]);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [publicCatalog, setPublicCatalog] = useState<PublicCapabilityCatalogDTO[]>([]);
  const [transcripts, setTranscripts] = useState<Map<string, TranscriptEntry[]>>(() => new Map());
  const [commands, setCommands] = useState<Map<string, CommandInfo[]>>(() => new Map());
  const [capabilities, setCapabilities] = useState<CapabilitySnapshotDTO>(EMPTY_CAPABILITIES);
  const [commentEvents, setCommentEvents] = useState<ArtifactCommentDTO[]>([]);
  const [resolvedCommentEvents, setResolvedCommentEvents] = useState<Map<string, number>>(() => new Map());
  const [commandAcks, setCommandAcks] = useState<CommandAckDTO[]>([]);
  const [channelEntries, setChannelEntries] = useState<ChannelEntry[]>([]);
  const [presence, setPresence] = useState<PresenceSnapshot>({ users: [] });
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<SquadSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const latestChannelSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const [nextProjects, nextFeatures, nextAgents, nextCapabilities, nextCatalog] = await Promise.all([
      apiJson<ProjectDTO[]>("/api/projects").catch(() => []),
      apiJson<FeatureDTO[]>("/api/features").catch(() => []),
      apiJson<AgentDTO[]>("/api/agents").catch(() => []),
      apiJson<CapabilitySnapshotDTO>("/api/capabilities").catch(() => EMPTY_CAPABILITIES),
      apiJson<{ catalog: PublicCapabilityCatalogDTO[] }>("/api/capability-catalog").then(normalizeCatalog).catch(() => []),
    ]);
    setProjects(nextProjects);
    setFeatures(nextFeatures);
    setCapabilities(normalizeCapabilities(nextCapabilities));
    setPublicCatalog(nextCatalog ?? []);
    if (nextAgents.length) setAgents(new Map(nextAgents.map((agent) => [agent.id, agent])));
  }, []);

  useEffect(() => {
    let alive = true;
    const safeReload = () => {
      if (alive) void reload();
    };
    safeReload();
    const socket = connectSquad({
      onOpen: () => {
        setConnected(true);
        safeReload();
        for (const id of subscribedRef.current) socketRef.current?.send({ type: "subscribe", id });
      },
      onClose: () => setConnected(false),
      onEvent: (event: SquadEvent) => {
        switch (event.type) {
          case "roster":
            // Full roster snapshot — prune any subscription for an id that
            // no longer exists so it stops re-subscribing on reconnect.
            for (const id of staleSubscriptionIds(subscribedRef.current, event.agents.map((agent) => agent.id))) {
              subscribedRef.current.delete(id);
            }
            setAgents(new Map(event.agents.map((agent) => [agent.id, agent])));
            break;
          case "agent":
            setAgents((previous) => {
              const next = new Map(previous);
              next.set(event.agent.id, event.agent);
              return next;
            });
            break;
          case "removed":
            subscribedRef.current.delete(event.id);
            setAgents((previous) => {
              const next = new Map(previous);
              next.delete(event.id);
              return next;
            });
            break;
          case "features-changed":
            safeReload();
            break;
          case "comment":
            setCommentEvents((previous) => previous.some((item) => item.id === event.comment.id) ? previous : [...previous.slice(-199), event.comment]);
            break;
          case "comment-resolved":
            setResolvedCommentEvents((previous) => {
              const next = new Map(previous);
              next.set(event.id, event.resolvedAt);
              return next;
            });
            break;
          case "transcript":
            setTranscripts((previous) => {
              const next = new Map(previous);
              next.set(event.id, appendTranscriptEntry(next.get(event.id) ?? [], event.entry));
              return next;
            });
            break;
          case "commands":
            setCommands((previous) => {
              const next = new Map(previous);
              next.set(event.id, event.commands);
              return next;
            });
            break;
          case "command-ack":
            setCommandAcks((previous) => [...previous.slice(-199), event]);
            break;
          case "channel-entry":
            setChannelEntries((previous) => {
              const next = mergeChannelEntry(previous, event.entry).slice(-500);
              latestChannelSeqRef.current = Math.max(latestChannelSeqRef.current, latestSeq(next));
              return next;
            });
            break;
          case "presence":
            setPresence(event.presence);
            break;
          default:
            break;
        }
      },
      channelSince: () => latestChannelSeqRef.current,
    });
    socketRef.current = socket;
    return () => {
      alive = false;
      socket.close();
    };
  }, [reload]);

  const send = useCallback((command: ClientCommand) => socketRef.current?.send(command), []);
  const subscribe = useCallback((id: string) => {
    subscribedRef.current.add(id);
    socketRef.current?.send({ type: "subscribe", id });
  }, []);
  const unsubscribe = useCallback((id: string) => {
    subscribedRef.current.delete(id);
  }, []);

  return { agents: [...agents.values()], features, projects, capabilities, publicCatalog, transcripts, commands, commentEvents, resolvedCommentEvents, commandAcks, channelEntries, presence, connected, reload, send, subscribe, unsubscribe };
}
