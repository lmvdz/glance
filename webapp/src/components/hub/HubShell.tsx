import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Loader2, Users } from 'lucide-react';
import { Composer, type ModelOption } from '../chat/Composer';
import { ChannelRail } from './ChannelRail';
import { ChannelTimeline } from './ChannelTimeline';
import { apiJson } from '../../lib/api';
import { buildPromptCommand, channelAgentSessionId, channelDraftSessionId, ensureConsoleAgent, postChannelMessage } from '../../lib/chat/sendCore';
import type { AgentDTO, Channel, ChannelEntry, PresenceSnapshot } from '../../lib/dto';
import { latestSeq, presenceCount, reduceChannelEntries } from '../../lib/hub';
import { DEFAULT_CHANNEL_ID, type HubRoute } from '../../lib/router';
import { useTaskContext } from '../../context/TaskContext';

const EMPTY_PRESENCE: PresenceSnapshot = { users: [] };
const DEFAULT_CHANNEL: Channel = { id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_ID, kind: 'default', createdAt: 0 };
const DEFAULT_MODELS: ModelOption[] = [{ value: '', label: 'Default model' }];

function ChannelHeader({ channel, presence, selectedAgent }: { channel: Channel; presence: PresenceSnapshot; selectedAgent?: AgentDTO }) {
  const count = presenceCount(presence);
  const visible = presence.users.slice(0, 5);
  const overflow = Math.max(0, presence.users.length - visible.length);
  const label = count === 1 ? '1 human present' : `${count} humans present`;
  return (
    <header className="flex min-h-12 flex-shrink-0 items-center justify-between gap-4 border-b border-zinc-800 bg-[#0c0c0e] px-4 py-2 text-zinc-100">
      <div className="flex min-w-0 items-center gap-2">
        <Hash className="h-4 w-4 text-amber-300" aria-hidden />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">{channel.name}</h1>
          <p className="truncate text-[11px] text-zinc-500">{selectedAgent ? `Addressing ${selectedAgent.name || selectedAgent.id}` : 'Fleet channel'}</p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3" aria-label={label}>
        <div className="hidden min-w-0 items-center justify-end gap-1.5 sm:flex">
          {visible.map((user) => (
            <span key={user.id} className="max-w-32 truncate rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300" title={`${user.displayName} · ${user.socketCount} socket${user.socketCount === 1 ? '' : 's'}`}>
              {user.displayName}
              <span className="ml-1 text-zinc-500">×{user.socketCount}</span>
            </span>
          ))}
          {overflow > 0 ? <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-500">+{overflow}</span> : null}
        </div>
        <div className="flex -space-x-1" aria-hidden>
          {visible.map((user) => (
            <div key={user.id} className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-950 bg-zinc-800 text-[10px] font-semibold text-zinc-200" title={`${user.displayName} · ${user.socketCount} socket${user.socketCount === 1 ? '' : 's'}`}>
              {(user.displayName || user.id).slice(0, 1).toUpperCase()}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Users className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">{count}</span>
        </div>
      </div>
    </header>
  );
}



export function HubShell({ route, renderWorkbench }: { route: HubRoute; renderWorkbench: (route: Extract<HubRoute, { kind: 'workbench' }>) => React.ReactNode }) {
  const { tasks, agents, features, audit, currentProject, selectedTaskId, channelEntries: liveChannelEntries, presence: livePresence, connected, subscribeConsole, sendConsoleCommand, showToast } = useTaskContext();
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

  const handleSend = async (text: string) => {
    if (!text.trim() || sending || route.kind !== 'hub') return;
    setSending(true);
    try {
      const result = await postChannelMessage({ apiJson }, activeChannelId, text);
      setEntries((prev) => reduceChannelEntries(prev, [result.entry], activeChannelId));
      lastSeqRef.current = Math.max(lastSeqRef.current, result.entry.seq);
      setAnchorEntryId(result.entry.id);
      if (selectedAgent) {
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
                sessionId={channelDraftSessionId(activeChannelId)}
                isLoading={sending}
                isStopShown={false}
                stopPending={false}
                onStop={() => undefined}
                onSend={(value) => void handleSend(value)}
                selectedModel={selectedModel}
                modelOptions={modelOptions}
                onModelChange={setSelectedModel}
                agent={selectedAgent}
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
