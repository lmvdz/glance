import type { AgentDTO, Channel, ChannelEntry, PresenceSnapshot } from './dto';

export type ChannelLoadState = 'loading' | 'ready' | 'error';

export interface ChannelViewState {
  channels: Channel[];
  entries: ChannelEntry[];
  presence: PresenceSnapshot;
  activeChannelId: string;
  loadState: ChannelLoadState;
  error?: string;
}

export interface ActiveWorkGroup {
  key: 'needs-you' | 'working' | 'idle' | 'done';
  label: string;
  agents: AgentDTO[];
}

const GROUP_ORDER: ActiveWorkGroup['key'][] = ['needs-you', 'working', 'idle', 'done'];

export function mergeChannelEntry(entries: ChannelEntry[], entry: ChannelEntry): ChannelEntry[] {
  const existing = entries.findIndex((item) => item.id === entry.id);
  const next = existing >= 0 ? entries.map((item) => (item.id === entry.id ? entry : item)) : [...entries, entry];
  return next.sort((a, b) => a.seq - b.seq || a.ts - b.ts || a.id.localeCompare(b.id));
}

export function reduceChannelEntries(entries: ChannelEntry[], incoming: ChannelEntry[], channelId: string): ChannelEntry[] {
  let next = entries.filter((entry) => entry.channelId === channelId);
  for (const entry of incoming) {
    if (entry.channelId === channelId) next = mergeChannelEntry(next, entry);
  }
  return next;
}

export function groupActiveWork(agents: AgentDTO[]): ActiveWorkGroup[] {
  const groups: Record<ActiveWorkGroup['key'], AgentDTO[]> = { 'needs-you': [], working: [], idle: [], done: [] };
  for (const agent of agents) {
    const status = String(agent.status ?? '').toLowerCase();
    const needsInput = status.includes('await') || status.includes('approval') || status.includes('input') || status.includes('blocked') || status.includes('error');
    if (needsInput) groups['needs-you'].push(agent);
    else if (status.includes('running') || status.includes('working') || status.includes('active')) groups.working.push(agent);
    else if (status.includes('done') || status.includes('complete') || status.includes('merged')) groups.done.push(agent);
    else groups.idle.push(agent);
  }
  const labels: Record<ActiveWorkGroup['key'], string> = { 'needs-you': 'Needs you', working: 'Working', idle: 'Idle', done: 'Done' };
  return GROUP_ORDER.map((key) => ({ key, label: labels[key], agents: groups[key] })).filter((group) => group.agents.length > 0);
}

export function presenceCount(presence: PresenceSnapshot): number {
  return presence.users.length;
}

export function latestSeq(entries: ChannelEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
}

export function entryAuthorLabel(entry: ChannelEntry): string {
  const name = entry.authorDisplayName?.trim() || entry.authorActor.replace(/^web:/, '').replace(/^db:/, '').replace(/^user:/, '').replace(/^agent:/, '');
  if (entry.authorOrigin === 'agent' || entry.authorActor.startsWith('agent:')) return `${name} · agent`;
  if (entry.kind === 'user' || entry.authorOrigin === 'local' || entry.authorOrigin === 'remote' || entry.authorActor.startsWith('user:') || entry.authorActor.startsWith('db:') || entry.authorActor.startsWith('web:')) return `${name} · human`;
  if (entry.authorActor.startsWith('manager')) return `${entry.authorDisplayName?.trim() || 'glance'} · system`;
  return `${name} · system`;
}
