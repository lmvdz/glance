import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Loader2, Users } from 'lucide-react';
import { Composer, type ModelOption } from '../chat/Composer';
import { ChannelRail } from './ChannelRail';
import { ChannelTimeline } from './ChannelTimeline';
import { apiJson, jsonInit } from '../../lib/api';
import { buildPromptCommand, ensureConsoleAgent } from '../../lib/chat/sendCore';
import { resolveMentionRoute, mentionEchoText } from '../../lib/mentionGrammar';
import type { AgentDTO, Channel, ChannelEntry, CommandAckDTO, PresenceSnapshot } from '../../lib/dto';
import { latestSeq, presenceCount, reduceChannelEntries } from '../../lib/hub';
import { DEFAULT_CHANNEL_ID, type HubRoute } from '../../lib/router';
import { useTaskContext } from '../../context/TaskContext';

const EMPTY_PRESENCE: PresenceSnapshot = { users: [] };
const DEFAULT_CHANNEL: Channel = { id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_ID, kind: 'default', createdAt: 0 };
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

function ChannelHeader({ channel, presence, selectedAgent }: { channel: Channel; presence: PresenceSnapshot; selectedAgent?: AgentDTO }) {
  const count = presenceCount(presence);
  return (
    <header className="flex h-10 flex-shrink-0 items-center justify-between border-b border-zinc-800 bg-[#0c0c0e] px-4 text-zinc-100">
      <div className="flex min-w-0 items-center gap-2">
        <Hash className="h-4 w-4 text-amber-300" aria-hidden />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">{channel.name}</h1>
          <p className="truncate text-[11px] text-zinc-500">{selectedAgent ? `Addressing ${selectedAgent.name || selectedAgent.id}` : 'Fleet channel'}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex -space-x-1" aria-hidden>
          {presence.users.slice(0, 4).map((user) => (
            <div key={user.id} className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-950 bg-zinc-800 text-[10px] font-semibold text-zinc-200" title={user.displayName}>
              {(user.displayName || user.id).slice(0, 1).toUpperCase()}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-400" aria-label={`${count} present`}>
          <Users className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">{count}</span>
        </div>
      </div>
    </header>
  );
}



export function HubShell({ route, renderWorkbench }: { route: HubRoute; renderWorkbench: (route: Extract<HubRoute, { kind: 'workbench' }>) => React.ReactNode }) {
  const { tasks, agents, features, audit, currentProject, selectedTaskId, channelEntries: liveChannelEntries, presence: livePresence, connected, subscribeConsole, sendConsoleCommand, showToast, commandAcks } = useTaskContext();
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
  const pendingMentionTurns = useRef(new Map<string, { channelId: string; target: string }>());
  const lastMentionTurnByAgent = useRef(new Map<string, string>());
  const [anchorEntryId, setAnchorEntryId] = useState<string | undefined>();
  const activeChannelId = route.kind === 'hub' ? route.channelId : DEFAULT_CHANNEL_ID;
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedAgentId), [agents, selectedAgentId]);
  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId), [tasks, selectedTaskId]);
  const channel = channels.find((item) => item.id === activeChannelId) ?? { ...DEFAULT_CHANNEL, id: activeChannelId, name: activeChannelId };

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

  useEffect(() => {
    const incoming = liveChannelEntries.filter((entry) => entry.channelId === activeChannelId && entry.seq > lastSeqRef.current);
    if (!incoming.length) return;
    setEntries((prev) => reduceChannelEntries(prev, incoming, activeChannelId));
    lastSeqRef.current = Math.max(lastSeqRef.current, latestSeq(incoming));
  }, [activeChannelId, liveChannelEntries]);

  useEffect(() => {
    if (livePresence.users.length > 0) setPresence(livePresence);
  }, [livePresence]);

  const resyncSince = useCallback(async (since: number) => {
    const payload = await apiJson<{ entries?: ChannelEntry[] }>(`/api/channels/${encodeURIComponent(activeChannelId)}/entries?since=${since}`);
    const incoming = payload.entries ?? [];
    if (!incoming.length) return;
    setEntries((prev) => reduceChannelEntries(prev, incoming, activeChannelId));
    lastSeqRef.current = Math.max(lastSeqRef.current, latestSeq(incoming));
  }, [activeChannelId]);

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
  }, [activeChannelId, loadChannels, resyncSince]);

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
    const previous = lastMentionTurnByAgent.current.get(target.id);
    lastMentionTurnByAgent.current.set(target.id, clientTurnId);
    pendingMentionTurns.current.set(clientTurnId, { channelId: activeChannelId, target: target.name || target.id });
    sendConsoleCommand({
      type: 'prompt',
      id: target.id,
      message: steerText,
      displayText: steerText,
      clientTurnId,
      source: 'mention',
      channelId: activeChannelId,
      mention: { targetLabel: target.name || target.id, echoText: mentionEchoText('operator', target.name || target.id, steerText, previous) },
    } as any);
  };

  const handleSend = async (text: string) => {
    if (!text.trim() || sending || route.kind !== 'hub') return;
    setSending(true);
    try {
      const result = await apiJson<{ entry: ChannelEntry }>(`/api/channels/${encodeURIComponent(activeChannelId)}/entries`, jsonInit('POST', { text }));
      setEntries((prev) => reduceChannelEntries(prev, [result.entry], activeChannelId));
      lastSeqRef.current = Math.max(lastSeqRef.current, result.entry.seq);
      setAnchorEntryId(result.entry.id);
      const routeResult = resolveMentionRoute(text, agents);
      if (routeResult.kind === 'steer' && routeResult.target) {
        const target = agents.find((item) => item.id === routeResult.target?.id);
        if (target) dispatchMentionSteer(target, routeResult.text || text);
      } else if (routeResult.kind === 'confirm' && routeResult.target) {
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(activeChannelId, `Confirm before steering working agent @${routeResult.target?.label}.`, 'mention-confirm-required', { face: { title: 'Confirm steer', body: routeResult.text, detail: 'Target is already working; queue or confirm before delivery.', tone: 'warning', pinned: { target: routeResult.target?.label } }, target: routeResult.target, text: routeResult.text })], activeChannelId));
      } else if (routeResult.kind === 'spawn' && routeResult.target) {
        setEntries((prev) => reduceChannelEntries(prev, [managerCardEntry(activeChannelId, `Spawn proposal for @${routeResult.target?.label}.`, 'spawn-proposal', { face: { title: 'Spawn proposed', body: routeResult.text, detail: 'Non-resident mention enters the existing /api/spawn flow with this channel attached.', tone: 'info', pinned: { target: routeResult.target?.label, channel: activeChannelId } }, target: routeResult.target, text: routeResult.text, channelId: activeChannelId })], activeChannelId));
      } else if (selectedAgent) {
        const sessionId = `hub:${activeChannelId}:${selectedAgent.id}`;
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

  return (
    <div className="dark flex h-screen w-full overflow-hidden bg-[#0a0a0b] text-sm text-zinc-200">
      <ChannelRail channels={channels} activeChannelId={activeChannelId} agents={agents} selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} workbenchActive={route.kind === 'workbench'} />
      <main id="omp-main-content" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#0a0a0b]">
        {route.kind === 'workbench' ? renderWorkbench(route) : (
          <>
            <ChannelHeader channel={channel} presence={presence} selectedAgent={selectedAgent} />
            <ChannelTimeline entries={entries} loading={loading} error={error} anchorEntryId={anchorEntryId} />
            <div className="border-t border-zinc-800 bg-[#0a0a0b]">
              {sending ? <div className="flex h-6 items-center gap-2 px-4 text-[11px] text-zinc-500"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Posting…</div> : null}
              <Composer
                tasks={tasks}
                suggestionChips={[]}
                sessionId={`hub:${activeChannelId}`}
                isLoading={sending}
                isStopShown={false}
                stopPending={false}
                onStop={() => undefined}
                onSend={(value) => void handleSend(value)}
                selectedModel={selectedModel}
                modelOptions={modelOptions}
                onModelChange={setSelectedModel}
                agent={selectedAgent}
                agents={agents}
                placeholder={selectedAgent ? `Message #${channel.name} and address ${selectedAgent.name || selectedAgent.id}` : `Message #${channel.name}`}
                onToast={showToast}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
