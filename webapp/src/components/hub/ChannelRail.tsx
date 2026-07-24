import React from 'react';
import { Activity, Circle, Hash, Layers, Radio } from 'lucide-react';
import type { AgentDTO, Channel } from '../../lib/dto';
import { groupActiveWork, type ActiveWorkGroup } from '../../lib/hub';
import { hubHref, workbenchHref } from '../../lib/router';

const statusDotClass: Record<ActiveWorkGroup['key'], string> = {
  'needs-you': 'bg-amber-400',
  working: 'bg-sky-400 motion-safe:animate-pulse',
  idle: 'bg-zinc-500',
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
  return (
    <aside className="flex h-full w-72 flex-shrink-0 flex-col border-r border-zinc-800/80 bg-[#0a0a0b] text-zinc-200 shadow-[inset_-1px_0_0_rgba(255,255,255,0.03)]" aria-label="Room rail">
      <div className="surface-subheader flex h-10 items-center gap-2 border-b border-zinc-800/80 bg-[#0c0c0e] px-3">
        <Radio className="h-4 w-4 text-amber-300" aria-hidden />
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold tracking-tight text-zinc-100">glance room</div>
          <div className="truncate text-[10px] text-zinc-500">Channels + active work</div>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Channels and workbench doors">
        <div className="mb-3">
          <div className="mb-1 flex h-6 items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
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
                  className={`group flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-[background-color,color,transform] duration-200 hover:translate-x-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b] ${active ? 'bg-amber-400/15 text-amber-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'}`}
                >
                  <Hash className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                  <span className="truncate">{channel.name}</span>
                </a>
              );
            })}
          </div>
        </div>

        <div className="mb-3">
          <div className="mb-1 flex h-6 items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            <Activity className="h-3 w-3" aria-hidden /> Active work
          </div>
          <div className="space-y-2">
            {groups.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">No active units.</div>
            ) : groups.map((group) => (
              <div key={group.key}>
                <div className="flex h-6 items-center gap-2 px-2 text-[11px] text-zinc-500">
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
                        className={`group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-[background-color,color,transform] duration-200 hover:translate-x-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b] ${selected ? 'bg-sky-400/15 text-sky-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'}`}
                      >
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusDotClass[group.key]}`} aria-hidden />
                        <span className="truncate">{agent.name || agent.id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 flex h-6 items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            <Layers className="h-3 w-3" aria-hidden /> Workbench doors
          </div>
          <div className="space-y-0.5">
            {[
              ['Fleet', workbenchHref('fleet'), 'Factory pulse'],
              ['Tasks', workbenchHref('tasks'), 'Plan work'],
              ['Graph', workbenchHref('graph'), 'System map'],
              ['Capabilities', workbenchHref('capabilities'), 'Tool registry'],
            ].map(([label, href, detail]) => (
              <a key={label} href={href} className="group flex h-7 items-center gap-2 rounded-md px-2 text-xs text-zinc-400 transition-[background-color,color,transform] duration-200 hover:translate-x-0.5 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]">
                <span className="truncate">{label}</span>
                <span className="ml-auto max-w-24 truncate text-[10px] text-zinc-600 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">{detail}</span>
              </a>
            ))}
          </div>
        </div>
      </nav>
    </aside>
  );
}
