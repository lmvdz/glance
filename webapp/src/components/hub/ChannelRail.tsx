import React from 'react';
import { Activity, Circle, Hash, Layers, Radio } from 'lucide-react';
import type { AgentDTO, Channel } from '../../lib/dto';
import { groupActiveWork, type ActiveWorkGroup } from '../../lib/hub';
import { hubHref, workbenchHref } from '../../lib/router';

/**
 * Status dots are SEMANTIC color (state), which brand.md's "one accent, used sparingly" rule
 * deliberately does not govern — a dot encodes information, it is not decoration. Selection and
 * focus are the accent, and there is exactly one of those: ember. The rail previously used a
 * second accent (sky) for the selected unit, which read as a competing brand color rather than a
 * state.
 */
const statusDotClass: Record<ActiveWorkGroup['key'], string> = {
  'needs-you': 'bg-amber-400',
  working: 'bg-sky-400 motion-safe:animate-pulse',
  idle: 'bg-ink-text-subtle',
  done: 'bg-emerald-400',
};

/** One row geometry for every navigable item in the rail — channels, units, doors. */
const ROW =
  'group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] ' +
  'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink';
const ROW_REST = 'text-ink-text-label hover:bg-ink-surface hover:text-ink-text';
const ROW_ON = 'bg-ember/12 text-ember-hi shadow-[inset_2px_0_0_var(--color-ember)]';

/** Section eyebrow — mono, uppercase, tracked. brand.md: caption 11–12px. */
const EYEBROW =
  'mb-1.5 flex h-6 items-center gap-2 px-2.5 font-mono text-[10px] font-medium uppercase ' +
  'tracking-[0.16em] text-ink-text-subtle';

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
    <aside className="flex h-full w-72 flex-shrink-0 flex-col border-r border-ink-border bg-ink text-ink-text-body" aria-label="Room rail">
      <div className="surface-subheader flex h-12 items-center gap-2.5 border-b border-ink-border bg-panel px-3">
        <Radio className="h-4 w-4 flex-shrink-0 text-ember" aria-hidden />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-tight text-ink-text">glance room</div>
          <div className="truncate text-[11px] text-ink-text-muted">Channels + active work</div>
        </div>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-2 py-3" aria-label="Channels and workbench doors">
        <div>
          <div className={`${EYEBROW} justify-between`}>
            <span>Channels</span>
            <Circle className="h-2 w-2 fill-emerald-400 text-emerald-400" aria-hidden />
          </div>
          <div className="flex flex-col gap-0.5">
            {channels.map((channel) => {
              const active = !workbenchActive && channel.id === activeChannelId;
              return (
                <a key={channel.id} href={hubHref(channel.id)} className={`${ROW} ${active ? ROW_ON : ROW_REST}`}>
                  <Hash className="h-3.5 w-3.5 flex-shrink-0 opacity-70" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {channel.unreadCount ? (
                    <span
                      className="rounded-full bg-ember px-1.5 py-px font-mono text-[10px] font-semibold tabular-nums text-ink"
                      aria-label={`${channel.unreadCount} unread in ${channel.name}`}
                    >
                      {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
                    </span>
                  ) : null}
                </a>
              );
            })}
          </div>
        </div>

        <div>
          <div className={EYEBROW}>
            <Activity className="h-3 w-3" aria-hidden /> Active work
          </div>
          <div className="flex flex-col gap-3">
            {groups.length === 0 ? (
              <div className="mx-0.5 rounded-md border border-dashed border-ink-border-2 px-3 py-2.5 text-[12px] text-ink-text-muted">
                No active units.
              </div>
            ) : groups.map((group) => (
              <div key={group.key}>
                <div className="flex h-6 items-center gap-2 px-2.5 text-[11px] text-ink-text-muted">
                  <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusDotClass[group.key]}`} aria-hidden />
                  <span>{group.label}</span>
                  <span className="ml-auto font-mono tabular-nums text-ink-text-subtle">{group.agents.length}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {group.agents.slice(0, 8).map((agent) => {
                    const selected = selectedAgentId === agent.id;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => onSelectAgent(agent.id)}
                        className={`${ROW} ${selected ? ROW_ON : ROW_REST}`}
                      >
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusDotClass[group.key]}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{agent.name || agent.id}</span>
                        <span className="max-w-20 flex-shrink-0 truncate font-mono text-[10px] text-ink-text-subtle">
                          {channelNames.get(agent.channelId ?? 'fleet') ?? '#fleet'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className={EYEBROW}>
            <Layers className="h-3 w-3" aria-hidden /> Workbench doors
          </div>
          <div className="flex flex-col gap-0.5">
            {[
              ['Fleet', workbenchHref('fleet'), 'Factory pulse'],
              ['Tasks', workbenchHref('tasks'), 'Plan work'],
              ['Graph', workbenchHref('graph'), 'System map'],
              ['Capabilities', workbenchHref('capabilities'), 'Tool registry'],
            ].map(([label, href, detail]) => (
              <a key={label} href={href} className={`${ROW} ${ROW_REST}`}>
                <span className="truncate">{label}</span>
                <span className="ml-auto max-w-24 truncate text-[11px] text-ink-text-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                  {detail}
                </span>
              </a>
            ))}
          </div>
        </div>
      </nav>
    </aside>
  );
}
