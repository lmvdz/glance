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

/**
 * The token a person sees while typing, and the address it expands to on send.
 *
 * The composer used to insert the full `[@pike](omp://agent/pike-ms24cs99-2-0a509ab2)` straight into
 * the textarea, so you typed to Pike and watched a UUID appear mid-sentence. Painting a chip over it
 * does not work either: the chip is eight characters wide and the address is forty-five, so the text
 * after it is shoved across the line by the difference.
 *
 * So the visible text carries the token `@pike` and the address is restored at send. Identity at a
 * glance, address on demand — the same rule the room applies to branches and repos.
 */
export function mentionToken(target: MentionTarget): string {
  return `@${target.label.replace(/\s+/g, '-')}`;
}

/**
 * Restore addresses before the text goes on the wire. Unknown tokens are left exactly as typed.
 *
 * ONE pass, not one per target: expanding sequentially rewrites text that later passes then match
 * inside. Expanding "@pike-two" first produces "[@pike two](omp://…)", and a following pass for
 * "@pike" happily matches the "@pike" now sitting inside that link and corrupts it. A single scan
 * with the longest token winning at each position cannot do that, because it never revisits what it
 * has already written.
 */
export function expandMentionTokens(text: string, targets: readonly MentionTarget[]): string {
  if (targets.length === 0) return text;
  const ordered = [...targets].sort((a, b) => mentionToken(b).length - mentionToken(a).length);
  let out = '';
  let i = 0;
  outer: while (i < text.length) {
    if (text[i] === '@') {
      const before = i === 0 ? '' : text[i - 1]!;
      // A token only counts at a word boundary — "a@pike.dev" is an address, not a mention.
      if (!/[\w@-]/.test(before)) {
        for (const target of ordered) {
          const token = mentionToken(target);
          if (text.startsWith(token, i)) {
            const after = text[i + token.length] ?? '';
            if (!/[\w-]/.test(after)) {
              out += serializeMention(target);
              i += token.length;
              continue outer;
            }
          }
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}
