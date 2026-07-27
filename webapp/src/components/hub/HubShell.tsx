import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Loader2, Search, Users, X } from 'lucide-react';
import { Composer, type ModelOption } from '../chat/Composer';
import { ChannelRail } from './ChannelRail';
import { ChannelTimeline } from './ChannelTimeline';
import { AgentRecordPanel } from './AgentRecordPanel';
import { RoomFrame } from './RoomFrame';
import { DecisionPanel, type DecisionRequest } from './DecisionPanel';
import { AutonomyPanel, type AutonomyState } from './AutonomyPanel';
import { UnitPanel } from './UnitPanel';
import { QuietRoom } from './QuietRoom';
import { agentsToRoomNodes } from '../../lib/roomState';
import { apiJson, jsonInit } from '../../lib/api';
import { buildPromptCommand, channelAgentSessionId, channelDraftSessionId, ensureConsoleAgent, postChannelMessage } from '../../lib/chat/sendCore';
import { resolveMentionRoute } from '../../lib/mentionGrammar';
import type { AgentDTO, Channel, ChannelEntry, CommandAckDTO, PresenceSnapshot } from '../../lib/dto';
import { latestSeq, presenceCount, reduceChannelEntries } from '../../lib/hub';
import { DEFAULT_CHANNEL_ID, hubHref, type HubRoute } from '../../lib/router';
import { useTaskContext } from '../../context/TaskContext';

const EMPTY_PRESENCE: PresenceSnapshot = { users: [] };
const DEFAULT_CHANNEL: Channel = { id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_ID, kind: 'default', createdAt: 0, visibility: 'org-public', unreadCount: 0, lastReadSeq: 0 };
const DEFAULT_MODELS: ModelOption[] = [{ value: '', label: 'Default model' }];

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
  const { tasks, agents, features, audit, currentProject, selectedTaskId, channelEntries: liveChannelEntries, presence: livePresence, typing, connected, subscribeConsole, sendConsoleCommand, showToast, commandAcks } = useTaskContext();
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
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(pending.channelId, `Mention steer failed for ${pending.target}: ${ack.reason}`, 'mention-steer-failed', { face: { title: 'Mention steer failed', body: ack.reason, tone: 'destructive', pinned: { target: pending.target } }, ack })], activeChannelId));
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
      if (routeResult.kind === 'steer' && routeResult.target) {
        const target = agents.find((item) => item.id === routeResult.target?.id);
        if (target) dispatchMentionSteer(target, routeResult.text || text);
      } else if (routeResult.kind === 'confirm' && routeResult.target) {
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(activeChannelId, `Confirm before steering working agent @${routeResult.target?.label}.`, 'mention-confirm-required', { face: { title: 'Confirm steer', body: routeResult.text, detail: 'Target is already working; queue or confirm before delivery.', tone: 'warning', pinned: { target: routeResult.target?.label } }, target: routeResult.target, text: routeResult.text })], activeChannelId));
      } else if (routeResult.kind === 'spawn' && routeResult.target) {
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(activeChannelId, `Spawn proposal for @${routeResult.target?.label}.`, 'spawn-proposal', { face: { title: 'Spawn proposed', body: routeResult.text, detail: 'Non-resident mention enters the existing /api/spawn flow with this channel attached.', tone: 'info', pinned: { target: routeResult.target?.label, channel: activeChannelId } }, target: routeResult.target, text: routeResult.text, channelId: activeChannelId })], activeChannelId));
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

  return (
    <div className="dark flex h-screen w-full overflow-hidden text-sm" style={{ background: '#070708', color: '#E8E8EA' }}>
      {/* The room is the home frame, drawn as the reference draws it: the alarm band across the top
          with the waiting questions readable in place, the conversation as the centre, and the
          addressable tree on the RIGHT. There is no channel column — the previous attempt kept one and
          wedged a strip beside it, which produced a room that read as unchanged because it was. */}
      {route.kind === 'workbench' ? (
        <ChannelRail channels={channels} activeChannelId={activeChannelId} agents={agents} selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} workbenchActive />
      ) : null}
      <main id="omp-main-content" className="flex min-w-0 flex-1 flex-col overflow-hidden" style={{ background: '#070708' }}>
        {route.kind === 'workbench' ? renderWorkbench(route) : (
          <RoomFrame
            repo={currentProject?.name ?? 'this repo'}
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
            unitPanel={
              // Standing inside a unit: its own conversation in the centre, its state beside it. The
              // old workbench put a FLEET roster, a transcript and a LAND/CHANGES/RUN stack on screen
              // at once and named none of the three questions a person actually has.
              activeChannelId.startsWith('node:')
                ? (() => {
                    const unit = agents.find((candidate) => `node:${candidate.id}` === activeChannelId);
                    return unit ? <UnitPanel agent={unit} now={frameNow} onClose={() => { window.location.hash = hubHref(DEFAULT_CHANNEL_ID); }} /> : undefined;
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
              onReply={(entry) => { setReplyTarget(entry); setReplyFocusKey((key) => key + 1); }}
              replyingToId={replyTarget?.id}
              // A quiet ROOM is the designed state — unit telemetry stays at its node — so the empty
              // room is a handover of what happened, not a promise that something will. Only the root
              // room gets this; a quiet node channel really is just an empty conversation.
              emptyState={activeChannelId === DEFAULT_CHANNEL_ID ? <QuietRoom nodes={agentsToRoomNodes(agents)} now={Date.now()} /> : undefined}
            />
            <div style={{ borderTop: '1px solid #1F1F22', background: '#0A0A0B' }}>
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
