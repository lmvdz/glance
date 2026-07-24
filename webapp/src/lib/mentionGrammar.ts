import type { AgentDTO } from './dto';
import type { Task } from '../types';

export type MentionTargetKind = 'agent' | 'issue' | 'capability';

export interface MentionTarget {
  kind: MentionTargetKind;
  id: string;
  label: string;
  status?: AgentDTO['status'];
}

export interface MentionSection {
  id: 'agents' | 'issues';
  label: string;
  items: MentionTarget[];
}

export interface MentionRoute {
  kind: 'none' | 'steer' | 'confirm' | 'spawn';
  target?: MentionTarget;
  text: string;
  mentionText?: string;
}

const normalize = (value: string) => value.trim().toLowerCase();
const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export function serializeMention(target: MentionTarget): string {
  const safeLabel = target.label.replace(/[\[\]]/g, '').trim() || target.id;
  return `[@${safeLabel}](omp://${target.kind}/${encodeURIComponent(target.id)})`;
}

export function mentionLabel(target: MentionTarget): string {
  return `@${target.label}`;
}

export function buildMentionSections(agents: readonly AgentDTO[], tasks: readonly Task[], query: string): MentionSection[] {
  const q = normalize(query.replace(/^@/, ''));
  const matches = (value: string) => !q || normalize(value).includes(q);
  const agentItems = agents
    .filter((agent) => matches(agent.name || agent.id) || matches(agent.id))
    .map((agent): MentionTarget => ({ kind: 'agent', id: agent.id, label: agent.name || agent.id, status: agent.status }));
  const issueItems = tasks
    .filter((task) => matches(task.title) || matches(task.id))
    .map((task): MentionTarget => ({ kind: 'issue', id: task.id, label: task.title }));
  return [
    { id: 'agents', label: 'Agents', items: agentItems },
    { id: 'issues', label: 'Issues', items: issueItems },
  ];
}

export function flattenMentionSections(sections: readonly MentionSection[]): MentionTarget[] {
  return sections.flatMap((section) => section.items);
}

const LINK_RE = /\[@([^\]]+)\]\(omp:\/\/(agent|issue|capability)\/([^\)]+)\)/g;

export function stripMentionLinks(text: string): string {
  return text.replace(LINK_RE, '').replace(/\s+/g, ' ').trim();
}

export function resolveMentionRoute(text: string, agents: readonly AgentDTO[]): MentionRoute {
  const raw = text.trim();
  const match = [...raw.matchAll(LINK_RE)].find((m) => m[2] === 'agent' || m[2] === 'capability');
  if (!match) {
    const bare = raw.match(/(?:^|\s)@([a-zA-Z0-9._-]{2,})/);
    if (!bare) return { kind: 'none', text: raw };
    const name = bare[1]!;
    const target = agents.find((agent) => normalize(agent.name) === normalize(name) || normalize(agent.id) === normalize(name));
    const mentionText = `@${name}`;
    const steerText = raw.replace(mentionText, '').replace(/\s+/g, ' ').trim();
    if (target) return routeForAgent({ kind: 'agent', id: target.id, label: target.name || target.id, status: target.status }, steerText, mentionText);
    return { kind: 'spawn', target: { kind: 'capability', id: slug(name) || name, label: name }, text: steerText || raw, mentionText };
  }
  const label = match[1]!;
  const kind = match[2] as MentionTargetKind;
  const id = decodeURIComponent(match[3]!);
  const mentionText = match[0]!;
  const steerText = stripMentionLinks(raw);
  if (kind === 'agent') {
    const agent = agents.find((item) => item.id === id);
    if (!agent) return { kind: 'spawn', target: { kind: 'agent', id, label }, text: steerText || raw, mentionText };
    return routeForAgent({ kind: 'agent', id: agent.id, label: agent.name || label || agent.id, status: agent.status }, steerText, mentionText);
  }
  if (kind === 'capability') return { kind: 'spawn', target: { kind, id, label }, text: steerText || raw, mentionText };
  return { kind: 'none', text: raw };
}

function routeForAgent(target: MentionTarget, text: string, mentionText: string): MentionRoute {
  if (target.status === 'working' || target.status === 'starting') return { kind: 'confirm', target, text, mentionText };
  return { kind: 'steer', target, text, mentionText };
}

export function mentionEchoText(actor: string, targetLabel: string, text: string, previousClientTurnId?: string): string {
  const suffix = previousClientTurnId ? ` Later steer supersedes ${previousClientTurnId}; last write wins.` : ' Last write wins; all steers remain visible.';
  return `${actor} steered @${targetLabel}: ${text}${suffix}`;
}
