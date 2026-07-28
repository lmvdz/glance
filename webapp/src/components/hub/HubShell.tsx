import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Loader2, Search, Users, X } from 'lucide-react';
import { Composer, type ModelOption } from '../chat/Composer';
import { ChannelTimeline } from './ChannelTimeline';
import { AgentRecordPanel } from './AgentRecordPanel';
import { RoomFrame, TopBar } from './RoomFrame';
import { DecisionPanel, type DecisionRequest } from './DecisionPanel';
import { AutonomyPanel, type AutonomyState } from './AutonomyPanel';
import { UnitPanel } from './UnitPanel';
import { QuietRoom } from './QuietRoom';
import { VoiceCallHudView } from './VoiceCallHud';
import { VoiceStatusRegion } from './VoiceStatusRegion';
import { VoiceDecisionDoor } from './VoiceDecisionDoor';
import { VoiceArtifactsList, VoiceArtifactViewer } from './VoiceArtifacts';
import { useRoomCall } from '../../hooks/useRoomCall';
import { useRoomCallAudio } from '../../hooks/useRoomCallAudio';
import {
  ALL_AGENTS,
  artifactAgentOptions,
  attentionChipLabel,
  currentPane,
  decisionAnnouncement,
  decisionDoorModel,
  decisionUrgency,
  focusHudRegion,
  groupArtifacts,
  initialPaneStack,
  popPane,
  pushPane,
  reconcileArtifactPane,
  setStackFilter,
  shouldSteer,
  steerStatusLine,
  threadStatus,
  type ArtifactRow,
  type PaneStackEntry,
} from '../../lib/voice/roomCall';
import { agentsToRoomNodes } from '../../lib/roomState';
import { fleetSummary } from '../../lib/roomFrame';
import { VoiceCallArtifactReadError, apiJson, fetchVoiceCallArtifactContent, jsonInit, type VoiceCallArtifactReadFailure } from '../../lib/api';
import { buildPromptCommand, channelAgentSessionId, channelDraftSessionId, ensureConsoleAgent, postChannelMessage } from '../../lib/chat/sendCore';
import { resolveMentionRoute } from '../../lib/mentionGrammar';
import type { AgentDTO, Channel, ChannelEntry, CommandAckDTO, PresenceSnapshot } from '../../lib/dto';
import { latestSeq, presenceCount, reduceChannelEntries } from '../../lib/hub';
import { DEFAULT_CHANNEL_ID, hubHref, unitHref, type HubRoute } from '../../lib/router';
import { useTaskContext } from '../../context/TaskContext';

const EMPTY_PRESENCE: PresenceSnapshot = { users: [] };
const DEFAULT_CHANNEL: Channel = { id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_ID, kind: 'default', createdAt: 0, visibility: 'org-public', unreadCount: 0, lastReadSeq: 0 };
const DEFAULT_MODELS: ModelOption[] = [{ value: '', label: 'Default model' }];

/**
 * Optimistic-UI pattern: mints a client-local card entry that never touches the daemon or the
 * channel store — used for confirm/failure/proposal cards that need to render before (or instead
 * of) a round trip. `kind` MUST carry the `local:` prefix (see LocalCardKind in channelTimeline.ts)
 * so it can never collide with a daemon-emitted TranscriptEventKind, even one reserved for future
 * use (e.g. `spawn-proposal`, reserved in transcript-event-kinds.ts for a future daemon reader).
 */
const managerCardEntry = (channelId: string, text: string, kind: string, payload: unknown): ChannelEntry => ({
  id: `local-card:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  seq: Number.MAX_SAFE_INTEGER,
  channelId,
  authorActor: 'manager',
  kind: 'system',
  text,
  ts: Date.now(),
  status: 'ok',
  format: 'markdown',
  event: { kind, issuer: 'manager', payload },
});

interface ChannelSearchResult {
  entry: ChannelEntry;
  snippet: string;
}

function resultTitle(entry: ChannelEntry): string {
  const actor = entry.authorActor.replace(/^web:/, '').replace(/^db:/, '');
  return `${actor || 'message'} · #${entry.seq}`;
}

/** What this channel IS, said accurately for each kind of channel there is. */
function channelSubtitle(channel: Channel, selectedAgent?: AgentDTO): string {
  if (selectedAgent) return `Addressing ${selectedAgent.name || selectedAgent.id}`;
  if (channel.id === DEFAULT_CHANNEL_ID) return 'Everything the fleet brings to you';
  if (channel.id.startsWith('node:')) return "This unit's own conversation — its detail stays here rather than in the room";
  return channel.visibility === 'private' ? 'A private room — only its members can read this' : 'A room you and your team share';
}

function ChannelHeader({ channel, presence, selectedAgent }: { channel: Channel; presence: PresenceSnapshot; selectedAgent?: AgentDTO }) {
  const count = presenceCount(presence);
  const visible = presence.users.slice(0, 5);
  const overflow = Math.max(0, presence.users.length - visible.length);
  const label = count === 1 ? '1 human present' : `${count} humans present`;
  return (
    <header className="flex min-h-12 flex-shrink-0 items-center justify-between gap-4 border-b border-ink-border bg-panel px-4 py-2 text-ink-text">
      <div className="flex min-w-0 items-center gap-2">
        <Hash className="h-4 w-4 text-ember" aria-hidden />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">{channel.name}</h1>
          {/* Every channel used to describe itself as "Fleet channel", including the ones that are not.
              A node's own conversation saying it is the fleet room is a small lie in a fixed position,
              which is the kind a reader stops noticing and then stops trusting. */}
          <p className="truncate text-[11px] text-ink-text-muted">{channelSubtitle(channel, selectedAgent)}</p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3" aria-label={label}>
        <div className="hidden min-w-0 items-center justify-end gap-1.5 sm:flex">
          {visible.map((user) => (
            <span key={user.id} className="max-w-32 truncate rounded-full border border-ink-border bg-ink-surface px-2 py-1 text-[11px] text-ink-text-label" title={`${user.displayName} · ${user.socketCount} socket${user.socketCount === 1 ? '' : 's'}`}>
              {user.displayName}
              <span className="ml-1 text-ink-text-muted">×{user.socketCount}</span>
            </span>
          ))}
          {overflow > 0 ? <span className="rounded-full border border-ink-border bg-ink-surface px-2 py-1 text-[11px] text-ink-text-muted">+{overflow}</span> : null}
        </div>
        <div className="flex -space-x-1" aria-hidden>
          {visible.map((user) => (
            <div key={user.id} className="flex h-7 w-7 items-center justify-center rounded-full border border-ink bg-ink-surface text-[10px] font-semibold text-ink-text-body" title={`${user.displayName} · ${user.socketCount} socket${user.socketCount === 1 ? '' : 's'}`}>
              {(user.displayName || user.id).slice(0, 1).toUpperCase()}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-ink-text-label">
          <Users className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">{count}</span>
        </div>
      </div>
    </header>
  );
}



export function HubShell({ route, renderWorkbench }: { route: HubRoute; renderWorkbench: (route: Extract<HubRoute, { kind: 'workbench' }>) => React.ReactNode }) {
  const { tasks, agents, features, audit, currentProject, selectedTaskId, channelEntries: liveChannelEntries, presence: livePresence, typing, connected, subscribeConsole, sendConsoleCommand, showToast, commandAcks, openCommandPalette } = useTaskContext();
  const [channels, setChannels] = useState<Channel[]>([DEFAULT_CHANNEL]);
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [presence, setPresence] = useState<PresenceSnapshot>(EMPTY_PRESENCE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [selectedModel, setSelectedModel] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(DEFAULT_MODELS);
  const [sending, setSending] = useState(false);
  const lastSeqRef = useRef(0);
  const typingStopTimer = useRef<number | undefined>(undefined);
  const unreadEventIds = useRef(new Set<string>());
  const pendingMentionTurns = useRef(new Map<string, { channelId: string; target: string }>());
  const [anchorEntryId, setAnchorEntryId] = useState<string | undefined>();
  const [replyTarget, setReplyTarget] = useState<ChannelEntry | undefined>();
  const [replyFocusKey, setReplyFocusKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChannelSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const activeChannelId = route.kind === 'hub' ? route.channelId : DEFAULT_CHANNEL_ID;
  // Declared up here, beside the room's other per-channel state, because `handleSend` below routes
  // composer text through it — the workspace's own derivations live further down, near the render.
  const call = useRoomCall(activeChannelId);
  // Concern 09 (browser-audio-transport): opens the browser's mic/speaker relay only once the
  // daemon itself confirms this call is audio-less AND live (`audioAvailable` is already both
  // `noLocalAudio` and `controlsAvailable`, daemon-checked) — a device-audio call never touches
  // this hook at all beyond the one boolean it reads.
  const callAudio = useRoomCallAudio(activeChannelId, call.binding?.audioAvailable === true);
  const routedEntryId = route.kind === 'hub' ? route.entryId : undefined;
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedAgentId), [agents, selectedAgentId]);
  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId), [tasks, selectedTaskId]);
  const channel = channels.find((item) => item.id === activeChannelId) ?? { ...DEFAULT_CHANNEL, id: activeChannelId, name: activeChannelId };
  const activeTyping = typing.filter((item) => item.channelId === activeChannelId && item.active);
  const typingLabel = activeTyping.length === 0 ? '' : activeTyping.length === 1 ? `${activeTyping[0].displayName} is typing…` : `${activeTyping.map((item) => item.displayName).slice(0, 2).join(', ')} are typing…`;

  useEffect(() => {
    if (typeof window !== 'undefined' && (!window.location.hash || window.location.hash === '#/')) window.location.hash = '#fleet';
  }, []);

  useEffect(() => {
    void apiJson<{ models?: ModelOption[] }>('/api/models').then((data) => {
      if (data.models?.length) setModelOptions(data.models);
    }).catch(() => undefined);
  }, []);

  const loadChannels = useCallback(async () => {
    const payload = await apiJson<{ channels?: Channel[] }>('/api/channels');
    setChannels(payload.channels?.length ? payload.channels : [DEFAULT_CHANNEL]);
  }, []);

  const markRead = useCallback((seq: number) => {
    if (!Number.isFinite(seq) || seq <= 0) return;
    void apiJson(`/api/channels/${encodeURIComponent(activeChannelId)}/read`, jsonInit('POST', { lastReadSeq: seq })).then(() => {
      setChannels((prev) => prev.map((item) => item.id === activeChannelId ? { ...item, lastReadSeq: Math.max(item.lastReadSeq ?? 0, seq), unreadCount: 0 } : item));
    }).catch(() => undefined);
  }, [activeChannelId]);

  useEffect(() => {
    const inactive = liveChannelEntries.filter((entry) => entry.channelId !== activeChannelId && !unreadEventIds.current.has(entry.id));
    if (inactive.length) {
      for (const entry of inactive) unreadEventIds.current.add(entry.id);
      setChannels((prev) => prev.map((channel) => {
        const count = inactive.filter((entry) => entry.channelId === channel.id && entry.seq > (channel.lastReadSeq ?? 0)).length;
        return count ? { ...channel, unreadCount: (channel.unreadCount ?? 0) + count } : channel;
      }));
    }
    const incoming = liveChannelEntries.filter((entry) => entry.channelId === activeChannelId && entry.seq > lastSeqRef.current);
    if (!incoming.length) return;
    setEntries((prev) => reduceChannelEntries(prev, incoming, activeChannelId));
    lastSeqRef.current = Math.max(lastSeqRef.current, latestSeq(incoming));
    markRead(lastSeqRef.current);
  }, [activeChannelId, liveChannelEntries, markRead]);

  useEffect(() => {
    if (livePresence.users.length > 0) setPresence(livePresence);
  }, [livePresence]);

  const resyncSince = useCallback(async (since: number) => {
    const payload = await apiJson<{ entries?: ChannelEntry[] }>(`/api/channels/${encodeURIComponent(activeChannelId)}/entries?since=${since}`);
    const incoming = payload.entries ?? [];
    if (!incoming.length) return;
    setEntries((prev) => reduceChannelEntries(prev, incoming, activeChannelId));
    lastSeqRef.current = Math.max(lastSeqRef.current, latestSeq(incoming));
    markRead(lastSeqRef.current);
  }, [activeChannelId, markRead]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [channelPayload, presencePayload] = await Promise.all([
          apiJson<{ entries?: ChannelEntry[] }>(`/api/channels/${encodeURIComponent(activeChannelId)}/entries?since=0`),
          apiJson<PresenceSnapshot>('/api/room/presence').catch(() => EMPTY_PRESENCE),
        ]);
        if (!alive) return;
        setEntries(reduceChannelEntries([], channelPayload.entries ?? [], activeChannelId));
        lastSeqRef.current = latestSeq(channelPayload.entries ?? []);
        markRead(lastSeqRef.current);
        setPresence(presencePayload);
        setError('');
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load channel');
      } finally {
        if (alive) setLoading(false);
      }
    };
    setLoading(true);
    void loadChannels().catch(() => undefined);
    void load();
    const interval = setInterval(() => {
      void resyncSince(lastSeqRef.current).catch(() => undefined);
      void apiJson<PresenceSnapshot>('/api/room/presence').then(setPresence).catch(() => undefined);
    }, 5000);
    return () => { alive = false; clearInterval(interval); };
  }, [activeChannelId, loadChannels, resyncSince, markRead]);

  useEffect(() => {
    if (!connected || loading) return;
    void resyncSince(lastSeqRef.current).catch(() => undefined);
  }, [connected, loading, resyncSince]);

  useEffect(() => {
    if (!commandAcks.length) return;
    for (const ack of commandAcks) {
      const pending = pendingMentionTurns.current.get(ack.clientTurnId);
      if (!pending) continue;
      if (ack.ok) {
        pendingMentionTurns.current.delete(ack.clientTurnId);
      } else {
        pendingMentionTurns.current.delete(ack.clientTurnId);
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(pending.channelId, `Mention steer failed for ${pending.target}: ${ack.reason}`, 'local:mention-steer-failed', { face: { title: 'Mention steer failed', body: ack.reason, tone: 'destructive', pinned: { target: pending.target } }, ack })], activeChannelId));
      }
    }
  }, [activeChannelId, commandAcks]);

  const dispatchMentionSteer = (target: AgentDTO, steerText: string) => {
    const clientTurnId = `mention:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    pendingMentionTurns.current.set(clientTurnId, { channelId: activeChannelId, target: target.name || target.id });
    sendConsoleCommand({
      type: 'prompt',
      id: target.id,
      message: steerText,
      displayText: steerText,
      clientTurnId,
      source: 'mention',
      channelId: activeChannelId,
      mention: { targetLabel: target.name || target.id },
    } as any);
  };

  useEffect(() => {
    setReplyTarget(undefined);
    setAnchorEntryId(routedEntryId);
  }, [activeChannelId, routedEntryId]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError('');
      setSearchLoading(false);
      return;
    }
    let alive = true;
    setSearchLoading(true);
    const timer = setTimeout(() => {
      void apiJson<{ results?: ChannelSearchResult[] }>(`/api/channels/search?q=${encodeURIComponent(query)}`)
        .then((payload) => {
          if (!alive) return;
          setSearchResults(payload.results ?? []);
          setSearchError('');
        })
        .catch((err) => {
          if (!alive) return;
          setSearchResults([]);
          setSearchError(err instanceof Error ? err.message : 'Search failed');
        })
        .finally(() => {
          if (alive) setSearchLoading(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [searchQuery]);


  const handleTypingActivity = useCallback((text: string) => {
    if (route.kind !== 'hub') return;
    const active = text.trim().length > 0;
    sendConsoleCommand({ type: 'typing', channelId: activeChannelId, active } as any);
    if (typingStopTimer.current) window.clearTimeout(typingStopTimer.current);
    if (active) {
      typingStopTimer.current = window.setTimeout(() => {
        sendConsoleCommand({ type: 'typing', channelId: activeChannelId, active: false } as any);
      }, 1800);
    }
  }, [activeChannelId, route.kind, sendConsoleCommand]);

  useEffect(() => () => {
    if (typingStopTimer.current) window.clearTimeout(typingStopTimer.current);
  }, []);

  const handleSend = async (text: string) => {
    if (!text.trim() || sending || route.kind !== 'hub') return;
    setSending(true);
    try {
      sendConsoleCommand({ type: 'typing', channelId: activeChannelId, active: false } as any);
      const result = await postChannelMessage({ apiJson }, activeChannelId, text, replyTarget?.id);
      setEntries((prev) => reduceChannelEntries(prev, [result.entry], activeChannelId));
      lastSeqRef.current = Math.max(lastSeqRef.current, result.entry.seq);
      setAnchorEntryId(result.entry.id);
      setReplyTarget(undefined);
      const routeResult = resolveMentionRoute(text, agents);
      // Non-mention text, while a call is up, is STEERING — it goes to the session through the
      // daemon, and the room says "delivered" only once the daemon acknowledges the relay. Fleet
      // mention semantics are untouched: an addressed @mention is still a fleet instruction and
      // takes the branch below, exactly as before.
      if (shouldSteer({ callState: call.binding?.state, mentionRoute: routeResult.kind, text })) {
        void call.sendSteer(text);
      }
      if (routeResult.kind === 'steer' && routeResult.target) {
        const target = agents.find((item) => item.id === routeResult.target?.id);
        if (target) dispatchMentionSteer(target, routeResult.text || text);
      } else if (routeResult.kind === 'confirm' && routeResult.target) {
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(activeChannelId, `Confirm before steering working agent @${routeResult.target?.label}.`, 'local:mention-confirm-required', { face: { title: 'Confirm steer', body: routeResult.text, detail: 'Target is already working; queue or confirm before delivery.', tone: 'warning', pinned: { target: routeResult.target?.label } }, target: routeResult.target, text: routeResult.text })], activeChannelId));
      } else if (routeResult.kind === 'spawn' && routeResult.target) {
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(activeChannelId, `Spawn proposal for @${routeResult.target?.label}.`, 'local:spawn-proposal', { face: { title: 'Spawn proposed', body: routeResult.text, detail: 'Non-resident mention enters the existing /api/spawn flow with this channel attached.', tone: 'info', pinned: { target: routeResult.target?.label, channel: activeChannelId } }, target: routeResult.target, text: routeResult.text, channelId: activeChannelId })], activeChannelId));
      } else if (selectedAgent) {
        const sessionId = channelAgentSessionId(activeChannelId, selectedAgent.id);
        const clientTurnId = `hub-turn:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const agentId = await ensureConsoleAgent({ apiJson, subscribeConsole, roster: agents, currentProject, selectedModel }, sessionId, selectedAgent.id);
        sendConsoleCommand(buildPromptCommand({ agentId, agents, features, audit, selectedTask, pageContext: null }, text, { clientTurnId, source: 'composer' }));
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not post to channel', 'error');
    } finally {
      setSending(false);
    }
  };

  const roomNodes = useMemo(() => agentsToRoomNodes(agents), [agents]);
  const [answeringId, setAnsweringId] = useState<string | undefined>(undefined);
  const [autonomyOpen, setAutonomyOpen] = useState(false);
  const [autonomy, setAutonomy] = useState<AutonomyState | undefined>(undefined);
  const [autonomyError, setAutonomyError] = useState('');

  useEffect(() => {
    if (!autonomyOpen) return;
    // Fetched when opened rather than polled: this is a state you go and read, not a ticker.
    setAutonomyError('');
    void apiJson<AutonomyState>('/api/autonomy')
      .then(setAutonomy)
      // A failed read must not look like a slow one. Swallowing the error left the panel saying
      // "reading…" forever, which is a claim that something is on its way — the same absence-as-answer
      // this whole surface exists to stop.
      .catch((err) => setAutonomyError(err instanceof Error ? err.message : String(err)));
  }, [autonomyOpen]);

  // Every gate-class pending across the fleet, in one list, so the panel can say "1 of 3" truthfully
  // rather than pretending each question arrived alone.
  const waiting = useMemo(
    () => agents.flatMap((agent) => (agent.pending ?? []).filter((request) => request.gateClass || request.id.startsWith('gate_')).map((request) => ({ agent, request }))),
    [agents],
  );

  const answering = useMemo((): DecisionRequest | undefined => {
    const index = waiting.findIndex(({ request }) => request.id === answeringId);
    if (index < 0) return undefined;
    const { agent, request } = waiting[index]!;
    return {
      id: request.id,
      agentName: agent.name || agent.id,
      address: agent.name || agent.id,
      stoppedAgoMs: request.createdAt ? Date.now() - request.createdAt : undefined,
      question: request.title,
      context: request.message,
      // Consequences come from the daemon when it has them; until then the option is shown WITHOUT an
      // invented one. A made-up consequence is worse than none — it is a promise nobody made.
      options: (request.options ?? []).map((label) => ({ label, consequence: `${agent.name || agent.id} takes this as the answer and picks the work back up from where it stopped.` })),
      index: index + 1,
      total: waiting.length,
      // So the panel can show what the question is actually about, and reach the conversation when
      // it cannot.
      unitId: agent.id,
      unitHref: unitHref(agent.id),
    };
  }, [waiting, answeringId]);

  const answer = (value: string) => {
    const found = waiting.find(({ request }) => request.id === answeringId);
    if (!found) return;
    sendConsoleCommand({ type: 'answer', id: found.agent.id, requestId: found.request.id, value } as never);
    setAnsweringId(undefined);
  };
  // Plans IN FLIGHT, not every feature ever recorded. The first version counted the whole store and
  // reported "78 plans" beside two running units — the kind of number that teaches a reader to stop
  // believing the line it sits in.
  // Rooms and node conversations, in one list, so the standing panel can answer "where am I".
  const roomViews = useMemo(
    () => channels.map((entry) => ({
      id: entry.id,
      name: entry.name.startsWith('#') ? entry.name : `#${entry.name}`,
      unread: entry.unreadCount ?? 0,
      kind: entry.id.startsWith('node:') ? ('node' as const) : ('room' as const),
    })),
    [channels],
  );

  const livePlans = useMemo(
    () => new Set(agents.map((agent) => agent.featureId).filter((id): id is string => typeof id === 'string' && id.length > 0)).size,
    [agents],
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  // One clock for the whole frame, ticking on a minute rather than every render: the room shows
  // elapsed times, and a value that changes on each paint makes them jitter without being any truer.
  const [frameNow, setFrameNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setFrameNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // The bar on an opened surface says "esc goes back to the room", so escape goes back to the room.
  // Copy that promises a key and is not wired to one is how a person learns to stop believing the
  // words on the screen.
  const inWorkbench = route.kind === 'workbench';
  useEffect(() => {
    if (!inWorkbench) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Not while someone is typing: escape in a field means "abandon what I am writing", and stealing
      // it would throw away their words to satisfy a navigation shortcut.
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      window.location.hash = hubHref(DEFAULT_CHANNEL_ID);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inWorkbench]);

  // Events per hour, from the room's own entries — the fleet's activity as it was actually recorded,
  // not a separate metrics pipeline that could disagree with the timeline beside it.
  const pulse = useMemo(() => {
    const hour = 3_600_000;
    const start = Math.floor((frameNow - 11 * hour) / hour) * hour;
    const buckets = Array.from({ length: 12 }, (_, index) => ({ at: start + index * hour, events: 0, interrupted: false }));
    for (const entry of entries) {
      const index = Math.floor((entry.ts - start) / hour);
      if (index < 0 || index >= buckets.length) continue;
      buckets[index]!.events += 1;
      if (entry.event?.kind === 'needs-you') buckets[index]!.interrupted = true;
    }
    return buckets;
  }, [entries, frameNow]);


  // ── The room-native call workspace (plans/voice-orchestrated-room-integration, concern 03) ─────
  // The thread IS the workspace: the same conversation, with the call's chrome above it, its
  // decisions and artifacts in the panel beside it, and its steering routed through the composer
  // that was already there. No second dashboard, no separate transcript pane. (`call` itself is
  // declared beside `activeChannelId` above — `handleSend` needs it.)
  const [paneStack, setPaneStack] = useState<PaneStackEntry[]>(initialPaneStack);
  const [openDecisionId, setOpenDecisionId] = useState<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState<string | undefined>(undefined);
  const announcedDecisionIds = useRef(new Set<string>());
  const [artifactDoc, setArtifactDoc] = useState<{ id: string; loading: boolean; content?: string; failure?: { reason: VoiceCallArtifactReadFailure; detail?: string } } | undefined>(undefined);
  const hudRef = useRef<HTMLDivElement | null>(null);

  const pane = currentPane(paneStack);

  // A new channel is a new workspace: the stack, the open question and the announcement dedup all
  // reset, so a question from the room you just left can never be answered from this one.
  useEffect(() => {
    setPaneStack(initialPaneStack());
    setOpenDecisionId(undefined);
    setAnnouncement(undefined);
    setArtifactDoc(undefined);
    announcedDecisionIds.current = new Set();
  }, [activeChannelId]);

  // Announce an ARRIVING decision politely and take nothing else. No focus move, no scroll, no
  // panel opening itself over what someone is reading — the chip in the status region is the
  // affordance, and it waits.
  useEffect(() => {
    const next = decisionAnnouncement(announcedDecisionIds.current, call.decisions);
    for (const decision of call.decisions) announcedDecisionIds.current.add(decision.id);
    if (next) setAnnouncement(next);
  }, [call.decisions]);

  const openDecision = useCallback((decisionId?: string) => {
    const target = decisionId ?? call.decisions.find((decision) => decisionUrgency(decision) !== 'settled')?.id;
    if (!target) return;
    setOpenDecisionId(target);
    setPaneStack((stack) => pushPane(stack, { pane: 'decision', agentFilter: currentPane(stack).agentFilter }, 0));
  }, [call.decisions]);

  const openArtifacts = useCallback(() => {
    setPaneStack((stack) => pushPane(stack, { pane: 'artifacts', agentFilter: currentPane(stack).agentFilter }, 0));
  }, []);

  const back = useCallback(() => {
    setPaneStack((stack) => {
      const next = popPane(stack);
      if (currentPane(next).pane !== 'decision') setOpenDecisionId(undefined);
      if (currentPane(next).pane !== 'artifact') setArtifactDoc(undefined);
      return next;
    });
  }, []);

  const openArtifact = useCallback((row: ArtifactRow) => {
    setPaneStack((stack) => pushPane(stack, { pane: 'artifact', agentFilter: currentPane(stack).agentFilter, artifactId: row.id }, currentPane(stack).scrollTop));
    setArtifactDoc({ id: row.id, loading: true });
  }, []);

  // The document read is its own effect keyed on the id, so a re-render (or a poll landing under
  // the reader) never re-fetches the file they are already reading.
  useEffect(() => {
    const id = artifactDoc?.id;
    if (!id || !artifactDoc?.loading) return;
    let alive = true;
    void fetchVoiceCallArtifactContent(activeChannelId, id)
      .then((doc) => {
        if (alive) setArtifactDoc({ id, loading: false, content: doc.content });
      })
      .catch((err) => {
        if (!alive) return;
        // A NAMED failure keeps its name — the viewer says "the snapshot is gone" rather than
        // rendering an empty document, which is the one thing an evidence viewer must never do.
        if (err instanceof VoiceCallArtifactReadError) setArtifactDoc({ id, loading: false, failure: { reason: err.reason, detail: err.detail } });
        else setArtifactDoc({ id, loading: false, failure: { reason: 'read-error', detail: err instanceof Error ? err.message : String(err) } });
      });
    return () => { alive = false; };
  }, [activeChannelId, artifactDoc?.id, artifactDoc?.loading]);

  const activeAgentCount = useMemo(() => roomNodes.filter((node) => node.state === 'in-flight').length, [roomNodes]);
  const status = useMemo(() => threadStatus({ binding: call.binding, decisions: call.decisions, activeAgents: activeAgentCount, gaps: call.gaps }), [call.binding, call.decisions, call.gaps, activeAgentCount]);
  const chipLabel = useMemo(() => attentionChipLabel(call.decisions), [call.decisions]);
  const artifactGroups = useMemo(() => groupArtifacts(call.artifacts, call.binding?.callId, pane.agentFilter), [call.artifacts, call.binding?.callId, pane.agentFilter]);
  const artifactAgents = useMemo(() => artifactAgentOptions(call.artifacts), [call.artifacts]);
  const openDecisionModel = useMemo(() => {
    const decision = call.decisions.find((candidate) => candidate.id === openDecisionId);
    return decision ? decisionDoorModel(decision) : undefined;
  }, [call.decisions, openDecisionId]);
  const waitingDecisions = useMemo(() => call.decisions.filter((decision) => decisionUrgency(decision) !== 'settled'), [call.decisions]);
  const artifactRowById = useMemo(() => new Map(artifactGroups.flatMap((group) => group.rows).map((row) => [row.id, row])), [artifactGroups]);

  // A stack whose top points at an artifact row that has since gone missing (the call ended and a
  // later poll pruned it) renders nothing in the `voicePanel` derivation below, but would keep the
  // phantom entry on top forever — Escape and the panel's own Back would have nothing left to pop
  // back to. Reconciling here, on every change to the stack or the rows it can point at, means the
  // conversation comes back the moment the row disappears rather than staying stuck behind it.
  useEffect(() => {
    setPaneStack((stack) => reconcileArtifactPane(stack, artifactRowById));
  }, [paneStack, artifactRowById]);

  // The last human or agent activity in this thread, for the idle-hangup line. Read from the room's
  // own entries rather than a separate clock, so the copy can never disagree with the timeline.
  const lastActivityAt = useMemo(() => entries.reduce((max, entry) => Math.max(max, entry.ts), 0) || undefined, [entries]);

  const voicePanel =
    pane.pane === 'decision' && openDecisionModel ? (
      <VoiceDecisionDoor
        model={openDecisionModel}
        callId={call.binding?.callId}
        agentLabel="the call"
        index={waitingDecisions.findIndex((decision) => decision.id === openDecisionModel.id) + 1 || undefined}
        total={waitingDecisions.length}
        pendingOptionIndex={call.pendingOption?.decisionId === openDecisionModel.id ? call.pendingOption.optionIndex : undefined}
        refusal={call.refusals[openDecisionModel.id]}
        onChoose={(optionIndex, label) => void call.chooseOption(openDecisionModel.id, optionIndex, label)}
        onConfirm={() => void call.confirm()}
        onCancelConfirm={call.cancelConfirm}
        onClose={back}
      />
    ) : pane.pane === 'artifacts' ? (
      <VoiceArtifactsList
        groups={artifactGroups}
        agentOptions={artifactAgents}
        agentFilter={pane.agentFilter}
        onFilterChange={(value) => setPaneStack((stack) => setStackFilter(stack, value))}
        onOpen={openArtifact}
        onClose={back}
        loading={call.loading}
        binding={call.binding}
        now={frameNow}
        scrollTop={pane.scrollTop}
        onScroll={(scrollTop) => setPaneStack((stack) => stack.map((entry, index) => (index === stack.length - 1 ? { ...entry, scrollTop } : entry)))}
      />
    ) : pane.pane === 'artifact' && pane.artifactId && artifactRowById.get(pane.artifactId) ? (
      <VoiceArtifactViewer
        row={artifactRowById.get(pane.artifactId)!}
        content={artifactDoc?.content}
        loading={artifactDoc?.loading ?? true}
        failure={artifactDoc?.failure}
        onBack={back}
      />
    ) : undefined;

  return (
    <div className="dark flex h-screen w-full overflow-hidden text-sm" style={{ background: '#070708', color: '#E8E8EA' }}>
      {/* The room is the home frame, drawn as the reference draws it: the alarm band across the top
          with the waiting questions readable in place, the conversation as the centre, and the
          addressable tree on the RIGHT. There is no channel column — the previous attempt kept one and
          wedged a strip beside it, which produced a room that read as unchanged because it was. */}
      <main id="omp-main-content" className="flex min-w-0 flex-1 flex-col overflow-hidden" style={{ background: '#070708' }}>
        {/* A surface opened from the room keeps the room's bar and says how to leave. It used to get a
            channel rail with a WORKBENCH DOORS list — a second navigation for a second application,
            and the reason opening anything still felt like leaving. */}
        {route.kind === 'workbench' ? (
          <>
            <TopBar repo={currentProject?.name ?? 'this repo'} summary={fleetSummary(roomNodes, livePlans)} now={frameNow} back={hubHref(DEFAULT_CHANNEL_ID)} onOpenPalette={openCommandPalette} />
            <div className="flex min-h-0 flex-1 flex-col">{renderWorkbench(route)}</div>
          </>
        ) : (
          <RoomFrame
            repo={currentProject?.name ?? 'this repo'}
            onOpenPalette={openCommandPalette}
            rooms={roomViews}
            activeRoomId={activeChannelId}
            onOpenRoom={(id) => { window.location.hash = hubHref(id); }}
            nodes={roomNodes}
            plans={livePlans}
            now={frameNow}
            selectedId={selectedNodeId}
            onSelect={(node) => setSelectedNodeId(node.id)}
            onEnter={(node) => {
              // A waiting node opens its question rather than its transcript: the thing you want when
              // something is stopped is to answer it, not to read about it.
              const pending = waiting.find(({ agent }) => agent.id === node.id);
              if (pending) { setAnsweringId(pending.request.id); return; }
              setSelectedNodeId(node.id);
              window.location.hash = hubHref(`node:${node.id}`);
            }}
            decision={answering ? <DecisionPanel request={answering} onAnswer={answer} onClose={() => setAnsweringId(undefined)} /> : undefined}
            voicePanel={voicePanel}
            unitPanel={
              // Standing inside a unit: its own conversation in the centre, its state beside it. The
              // old workbench put a FLEET roster, a transcript and a LAND/CHANGES/RUN stack on screen
              // at once and named none of the three questions a person actually has.
              activeChannelId.startsWith('node:')
                ? (() => {
                    const unit = agents.find((candidate) => `node:${candidate.id}` === activeChannelId);
                    // `siblings` is the whole roster: the panel derives above/beneath/beside from it,
                    // so it must be able to see the units that are NOT this one.
                    return unit ? <UnitPanel agent={unit} now={frameNow} siblings={agents} onClose={() => { window.location.hash = hubHref(DEFAULT_CHANNEL_ID); }} /> : undefined;
                  })()
                : undefined
            }
            autonomyOpen={autonomyOpen}
            onToggleAutonomy={() => setAutonomyOpen((open) => !open)}
            autonomyPanel={
              autonomy
                ? <AutonomyPanel state={autonomy} onClose={() => setAutonomyOpen(false)} />
                : (
                  <div className="p-5 text-[12.5px] leading-[1.5]" style={{ color: autonomyError ? '#C2704A' : '#6A6A72' }}>
                    {autonomyError
                      ? `Could not read what the fleet may settle: ${autonomyError}. That is not the same as it being allowed to settle nothing — this panel does not know either way right now.`
                      : 'Reading what the fleet may settle…'}
                  </div>
                )
            }
          >
            {selectedAgent ? <AgentRecordPanel agent={selectedAgent} /> : null}
            <ChannelTimeline
              entries={entries}
              loading={loading}
              error={error}
              anchorEntryId={anchorEntryId}
              onAnswerDecision={(decisionId) => openDecision(decisionId)}
              onOpenCall={() => focusHudRegion(hudRef.current)}
              // The call's chrome rides ABOVE the scroller (see ChannelTimeline's own note), so a
              // phase change or a status line arriving never moves the conversation underneath it.
              header={
                // tabIndex={-1} makes this a valid programmatic focus target for the "Open the
                // call" door above (`focusHudRegion`) without adding it to the Tab order — nothing
                // else here focuses it, so it must never intercept a Tab press.
                <div ref={hudRef} tabIndex={-1}>
                  <VoiceCallHudView
                    // A unit's own conversation is not where you start a call — it has its own panel
                    // and its own vocabulary. A call already BOUND to one still renders in full;
                    // only the invitation is withheld.
                    canStart={!activeChannelId.startsWith('node:')}
                    binding={call.binding}
                    starting={call.starting}
                    ending={call.ending}
                    muted={call.muted}
                    muteBusy={call.muteBusy}
                    controlsAvailable={call.controlsAvailable}
                    lastActivityAt={lastActivityAt}
                    now={frameNow}
                    error={call.error || undefined}
                    browserAudio={{ micStatus: callAudio.micStatus, relayStatus: callAudio.relayStatus, error: callAudio.error, onRetry: callAudio.retry }}
                    onStart={call.start}
                    onEnd={call.end}
                    onToggleMute={call.toggleMute}
                  />
                  <VoiceStatusRegion
                    status={status}
                    chipLabel={chipLabel}
                    announcement={announcement}
                    onOpenDecisions={waitingDecisions.length > 0 ? () => openDecision() : undefined}
                    onOpenArtifacts={call.binding ? openArtifacts : undefined}
                    artifactCount={call.artifacts.length}
                  />
                </div>
              }
              onReply={(entry) => { setReplyTarget(entry); setReplyFocusKey((key) => key + 1); }}
              // A waiting card opens the question, with what it is about beside it — the room's own
              // tree already did this; the card was the one place that sent you to the transcript.
              onAnswer={(unitId) => {
                // A card carries whatever the daemon projected onto it, which is usually the unit's
                // NAME ("ompsq-480") while the roster is keyed by its full id
                // ("ompsq-480-ms2kfv09-6-01fcf897"). Matching only on id meant the button did nothing
                // at all — silently, which is the worst of the three outcomes.
                const pending = waiting.find(({ agent }) => agent.id === unitId || agent.name === unitId);
                if (pending) { setAnsweringId(pending.request.id); return; }
                const unit = agents.find((agent) => agent.id === unitId || agent.name === unitId);
                if (unit) { window.location.hash = unitHref(unit.id); return; }
                // Nothing to open is worth saying rather than swallowing: the question this card is
                // about has been answered or the unit is gone.
                showToast('That question is no longer waiting — the unit it belonged to has gone or it has already been answered.', 'info');
              }}
              replyingToId={replyTarget?.id}
              // A quiet ROOM is the designed state — unit telemetry stays at its node — so the empty
              // room is a handover of what happened, not a promise that something will. Only the root
              // room gets this; a quiet node channel really is just an empty conversation.
              emptyState={activeChannelId === DEFAULT_CHANNEL_ID ? <QuietRoom nodes={roomNodes} now={frameNow} pulse={pulse} /> : undefined}
            />
            <div style={{ borderTop: '1px solid #1F1F22', background: '#0A0A0B' }}>
              {/* Steering never claims delivery it has not been given. "Sending" while the relay is
                  in flight, "Delivered to the call" only on the daemon's ok, and a REFUSAL that
                  says what actually happened and that the session did not hear it — never a silent
                  drop, which is the one outcome the concern names explicitly. */}
              {call.steer ? (
                <div
                  className="flex items-start gap-2 px-4 py-1.5 text-[11.5px] leading-[1.5]"
                  style={{ borderBottom: '1px solid #17171A', color: call.steer.status === 'refused' ? '#C2704A' : call.steer.status === 'delivered' ? '#7FB093' : '#8A8A91' }}
                  role={call.steer.status === 'refused' ? 'alert' : 'status'}
                >
                  <span className="min-w-0 flex-1" style={{ textWrap: 'pretty' }}>{steerStatusLine(call.steer)}</span>
                  <button
                    type="button"
                    onClick={call.clearSteer}
                    aria-label="Dismiss the steering status"
                    className="flex h-10 w-10 flex-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                    style={{ color: '#5A5A61' }}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              ) : null}
              {typingLabel ? <div className="flex h-6 items-center gap-2 px-4 text-[11px] text-ink-text-muted">{typingLabel}</div> : null}
              {sending ? <div className="flex h-6 items-center gap-2 px-4 text-[11px] text-ink-text-muted"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Posting…</div> : null}
              {replyTarget ? (
                <div className="flex items-center justify-between gap-3 border-b border-ink-border px-4 py-2 text-xs text-ink-text-label">
                  <div className="min-w-0">
                    <span className="font-medium text-ink-text-label">Replying to #{replyTarget.seq}</span>
                    <span className="ml-2 line-clamp-1">{replyTarget.displayText ?? replyTarget.text}</span>
                  </div>
                  <button
                    type="button"
                    aria-label="Cancel reply"
                    onClick={() => setReplyTarget(undefined)}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-ink-text-muted hover:bg-ink-surface hover:text-ink-text-body focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ) : null}
              <Composer
                tasks={tasks}
                suggestionChips={[]}
                sessionId={channelDraftSessionId(activeChannelId)}
                isLoading={sending}
                isStopShown={false}
                stopPending={false}
                onStop={() => undefined}
                onSend={(value) => void handleSend(value)}
                onInputActivity={handleTypingActivity}
                selectedModel={selectedModel}
                modelOptions={modelOptions}
                onModelChange={setSelectedModel}
                agent={selectedAgent}
                agents={agents}
                placeholder={selectedAgent ? `Message ${channel.name} and address ${selectedAgent.name || selectedAgent.id}` : `Message ${channel.name}`}
                focusKey={replyFocusKey}
                onToast={showToast}
              />
            </div>
          </RoomFrame>
        )}
      </main>
    </div>
  );
}
