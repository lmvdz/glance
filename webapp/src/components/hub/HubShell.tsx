import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Loader2, Search, Users, X } from 'lucide-react';
import { Composer, type ModelOption } from '../chat/Composer';
import { ChannelRail } from './ChannelRail';
import { ChannelTimeline } from './ChannelTimeline';
import { apiJson, jsonInit } from '../../lib/api';
import { buildPromptCommand, ensureConsoleAgent } from '../../lib/chat/sendCore';
import type { AgentDTO, Channel, ChannelEntry, PresenceSnapshot } from '../../lib/dto';
import { latestSeq, presenceCount, reduceChannelEntries } from '../../lib/hub';
import { DEFAULT_CHANNEL_ID, hubHref, type HubRoute } from '../../lib/router';
import { useTaskContext } from '../../context/TaskContext';

const EMPTY_PRESENCE: PresenceSnapshot = { users: [] };
const DEFAULT_CHANNEL: Channel = { id: DEFAULT_CHANNEL_ID, name: DEFAULT_CHANNEL_ID, kind: 'default', createdAt: 0 };
const DEFAULT_MODELS: ModelOption[] = [{ value: '', label: 'Default model' }];

interface ChannelSearchResult {
  entry: ChannelEntry;
  snippet: string;
}

function resultTitle(entry: ChannelEntry): string {
  const actor = entry.authorActor.replace(/^web:/, '').replace(/^db:/, '');
  return `${actor || 'message'} · #${entry.seq}`;
}

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
  const [anchorEntryId, setAnchorEntryId] = useState<string | undefined>();
  const [replyTarget, setReplyTarget] = useState<ChannelEntry | undefined>();
  const [replyFocusKey, setReplyFocusKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChannelSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const lastSeqRef = useRef(0);
  const activeChannelId = route.kind === 'hub' ? route.channelId : DEFAULT_CHANNEL_ID;
  const routedEntryId = route.kind === 'hub' ? route.entryId : undefined;
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


  const handleSend = async (text: string) => {
    if (!text.trim() || sending || route.kind !== 'hub') return;
    setSending(true);
    try {
      const result = await apiJson<{ entry: ChannelEntry }>(`/api/channels/${encodeURIComponent(activeChannelId)}/entries`, jsonInit('POST', { text, replyToId: replyTarget?.id }));
      setEntries((prev) => reduceChannelEntries(prev, [result.entry], activeChannelId));
      lastSeqRef.current = Math.max(lastSeqRef.current, result.entry.seq);
      setAnchorEntryId(result.entry.id);
      setReplyTarget(undefined);
      if (selectedAgent) {
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
            <div className="border-b border-zinc-800 bg-[#0a0a0b] px-4 py-2">
              <label className="relative block">
                <span className="sr-only">Search channel history</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search room history"
                  className="h-9 w-full rounded-full border border-zinc-800 bg-zinc-950 pl-9 pr-9 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
              </label>
              {searchQuery.trim() ? (
                <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl">
                  {searchLoading ? <div className="px-3 py-2 text-xs text-zinc-500">Searching…</div> : searchError ? <div className="px-3 py-2 text-xs text-red-300" role="alert">{searchError}</div> : searchResults.length === 0 ? <div className="px-3 py-2 text-xs text-zinc-500">No matches in durable history.</div> : (
                    <ol className="divide-y divide-zinc-800">
                      {searchResults.map((result) => (
                        <li key={result.entry.id}>
                          <a href={hubHref(result.entry.channelId, result.entry.id)} onClick={() => setAnchorEntryId(result.entry.id)} className="block px-3 py-2 text-left hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-inset">
                            <span className="block text-[11px] font-medium text-zinc-300">{resultTitle(result.entry)}</span>
                            <span className="mt-0.5 block line-clamp-2 text-xs text-zinc-500">{result.snippet}</span>
                          </a>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : null}
            </div>
            <ChannelTimeline entries={entries} loading={loading} error={error} anchorEntryId={anchorEntryId} onReply={(entry) => { setReplyTarget(entry); setReplyFocusKey((key) => key + 1); }} />
            <div className="border-t border-zinc-800 bg-[#0a0a0b]">
              {sending ? <div className="flex h-6 items-center gap-2 px-4 text-[11px] text-zinc-500"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Posting…</div> : null}
              {replyTarget ? (
                <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
                  <div className="min-w-0">
                    <span className="font-medium text-zinc-300">Replying to #{replyTarget.seq}</span>
                    <span className="ml-2 line-clamp-1">{replyTarget.displayText ?? replyTarget.text}</span>
                  </div>
                  <button
                    type="button"
                    aria-label="Cancel reply"
                    onClick={() => setReplyTarget(undefined)}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ) : null}
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
                placeholder={selectedAgent ? `Message #${channel.name} and address ${selectedAgent.name || selectedAgent.id}` : `Message #${channel.name}`}
                focusKey={replyFocusKey}
                onToast={showToast}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
