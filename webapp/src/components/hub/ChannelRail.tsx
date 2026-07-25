import React from 'react';
import { Activity, Circle, Hash, Layers, Radio } from 'lucide-react';
import type { AgentDTO, Channel } from '../../lib/dto';
import { groupActiveWork, type ActiveWorkGroup } from '../../lib/hub';
import { hubHref, workbenchHref } from '../../lib/router';

const statusDotClass: Record<ActiveWorkGroup['key'], string> = {
  'needs-you': 'bg-amber-400',
  working: 'bg-sky-400 motion-safe:animate-pulse',
  idle: 'bg-ink-text-muted',
  done: 'bg-emerald-400',
};

export function ChannelRail({
  channels,
  activeChannelId,
  agents,
  selectedAgentId,
  onSelectAgent,
  workbenchActive,
}: {
  channels: Channel[];
  activeChannelId: string;
  agents: AgentDTO[];
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  workbenchActive: boolean;
}) {
  const groups = groupActiveWork(agents);
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name.startsWith('#') ? channel.name : `#${channel.name}`]));
  return (
    <aside className="flex h-full w-72 flex-shrink-0 flex-col border-r border-ink-border/80 bg-ink text-ink-text-body shadow-[inset_-1px_0_0_rgba(255,255,255,0.03)]" aria-label="Room rail">
      <div className="surface-subheader flex h-10 items-center gap-2 border-b border-ink-border/80 bg-panel px-3">
        <Radio className="h-4 w-4 text-ember" aria-hidden />
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold tracking-tight text-ink-text">glance room</div>
          <div className="truncate text-[10px] text-ink-text-muted">Channels + active work</div>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Channels and workbench doors">
        <div className="mb-3">
          <div className="mb-1 flex h-6 items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-text-muted">
            <span>Channels</span>
            <Circle className="h-2.5 w-2.5 fill-emerald-400 text-emerald-400" aria-hidden />
          </div>
          <div className="space-y-0.5">
            {channels.map((channel) => {
              const active = !workbenchActive && channel.id === activeChannelId;
              return (
                <a
                  key={channel.id}
                  href={hubHref(channel.id)}
                  className={`group flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-[background-color,color,transform] duration-200 hover:translate-x-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink ${active ? 'bg-ember/15 text-ember-hi' : 'text-ink-text-muted hover:bg-panel hover:text-ink-text'}`}
                >
                  <Hash className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {channel.unreadCount ? <span className="rounded-full bg-ember px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink" aria-label={`${channel.unreadCount} unread in ${channel.name}`}>{channel.unreadCount > 99 ? '99+' : channel.unreadCount}</span> : null}
                </a>
              );
            })}
          </div>
        </div>

        <div className="mb-3">
          <div className="mb-1 flex h-6 items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-text-muted">
            <Activity className="h-3 w-3" aria-hidden /> Active work
          </div>
          <div className="space-y-2">
            {groups.length === 0 ? (
              <div className="rounded-lg border border-ink-border bg-ink/60 px-3 py-2 text-xs text-ink-text-muted">No active units.</div>
            ) : groups.map((group) => (
              <div key={group.key}>
                <div className="flex h-6 items-center gap-2 px-2 text-[11px] text-ink-text-muted">
                  <span className={`h-2 w-2 rounded-full ${statusDotClass[group.key]}`} aria-hidden />
                  <span>{group.label}</span>
                  <span className="ml-auto tabular-nums">{group.agents.length}</span>
                </div>
                <div className="space-y-0.5">
                  {group.agents.slice(0, 8).map((agent) => {
                    const selected = selectedAgentId === agent.id;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => onSelectAgent(agent.id)}
                        className={`group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-[background-color,color,transform] duration-200 hover:translate-x-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink ${selected ? 'bg-sky-400/15 text-sky-100' : 'text-ink-text-muted hover:bg-panel hover:text-ink-text'}`}
                      >
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusDotClass[group.key]}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{agent.name || agent.id}</span>
                        <span className="max-w-20 flex-shrink-0 truncate text-[10px] text-ink-text-subtle">{channelNames.get(agent.channelId ?? 'fleet') ?? '#fleet'}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 flex h-6 items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-text-muted">
            <Layers className="h-3 w-3" aria-hidden /> Workbench doors
          </div>
          <div className="space-y-0.5">
            {[
              ['Fleet', workbenchHref('fleet'), 'Factory pulse'],
              ['Tasks', workbenchHref('tasks'), 'Plan work'],
              ['Graph', workbenchHref('graph'), 'System map'],
              ['Capabilities', workbenchHref('capabilities'), 'Tool registry'],
            ].map(([label, href, detail]) => (
              <a key={label} href={href} className="group flex h-7 items-center gap-2 rounded-md px-2 text-xs text-ink-text-muted transition-[background-color,color,transform] duration-200 hover:translate-x-0.5 hover:bg-panel hover:text-ink-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink">
                <span className="truncate">{label}</span>
                <span className="ml-auto max-w-24 truncate text-[10px] text-ink-text-subtle opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">{detail}</span>
              </a>
            ))}
          </div>
        </div>
      </nav>
    </aside>
  );
}
