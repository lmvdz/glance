import type { ChannelEntry } from './dto';
import { landCardView, type LandCardKind } from '../components/hub/LandCards';
import { entryAuthorLabel } from './hub';

export type ChannelCardTone = 'neutral' | 'info' | 'warning' | 'success' | 'destructive';
export type ChannelCardKind = 'message' | 'needs-you' | 'gate-verdict' | LandCardKind | 'mention-steer' | 'mention-confirm-required' | 'mention-steer-failed' | 'spawn-proposal' | 'plan-card' | 'token-burn-snapshot' | 'unknown-event';

export interface PointerCardFace {
  title: string;
  eyebrow?: string;
  body?: string;
  detail?: string;
  status?: string;
  tone?: ChannelCardTone;
  pinned?: Record<string, string | number | boolean | null | undefined>;
  href?: string;
}

export interface ChannelCardView {
  id: string;
  entry: ChannelEntry;
  kind: ChannelCardKind;
  tone: ChannelCardTone;
  authorLabel: string;
  title: string;
  eyebrow?: string;
  body: string;
  detail?: string;
  pinned: Array<{ label: string; value: string }>;
  land?: { kind: LandCardKind; branch?: string; sha?: string; target?: string; risk?: string; recommendation?: string; outcome?: string; prNumber?: string; prUrl?: string; doneProofVerified?: string };
  replyContext?: { id: string; channelId: string; authorLabel: string; body: string };
  repliedBy?: number;
  actionHref?: string;
  href?: string;
}

export function previewChannelBody(text: string, limit = 120): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

export function buildChannelThreadViews(entries: ChannelEntry[]): ChannelCardView[] {
  const baseViews = entries.map(dispatchChannelCard);
  const byId = new Map(baseViews.map((view) => [view.id, view]));
  const replyCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.replyToId) replyCounts.set(entry.replyToId, (replyCounts.get(entry.replyToId) ?? 0) + 1);
  }
  return baseViews.map((view) => {
    const parent = view.entry.replyToId ? byId.get(view.entry.replyToId) : undefined;
    const replyContext = parent ? { id: parent.id, channelId: parent.entry.channelId, authorLabel: parent.authorLabel, body: previewChannelBody(parent.body, 96) } : undefined;
    const repliedBy = replyCounts.get(view.id);
    return replyContext || repliedBy ? { ...view, replyContext, repliedBy } : view;
  });
}

const POINTER_EVENT_KINDS: Record<string, true> = { 'needs-you': true, 'gate-verdict': true, 'land-attempt': true, 'land-assessment': true, 'land-merge': true, 'mention-steer': true, 'mention-confirm-required': true, 'mention-steer-failed': true, 'spawn-proposal': true, 'token-burn-snapshot': true, 'plan-card': true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function faceFromPayload(payload: unknown): PointerCardFace | undefined {
  if (!isRecord(payload) || !isRecord(payload.face)) return undefined;
  const face = payload.face;
  const pinned = isRecord(face.pinned) ? Object.fromEntries(Object.entries(face.pinned).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) || value == null)) as PointerCardFace['pinned'] : undefined;
  return {
    title: typeof face.title === 'string' ? face.title : '',
    eyebrow: typeof face.eyebrow === 'string' ? face.eyebrow : undefined,
    body: typeof face.body === 'string' ? face.body : undefined,
    detail: typeof face.detail === 'string' ? face.detail : undefined,
    status: typeof face.status === 'string' ? face.status : undefined,
    tone: isTone(face.tone) ? face.tone : undefined,
    pinned,
  };
}

function hrefFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.href === 'string') return payload.href;
  if (payload.doorSurface === 'plan' && isRecord(payload.refs) && typeof payload.refs.planId === 'string') return `#/workbench/task/${encodeURIComponent(payload.refs.planId)}`;
  return undefined;
}

function isTone(value: unknown): value is ChannelCardTone {
  return value === 'neutral' || value === 'info' || value === 'warning' || value === 'success' || value === 'destructive';
}

function toneFor(kind: string, face?: PointerCardFace): ChannelCardTone {
  if (face?.tone) return face.tone;
  if (kind === 'needs-you') return 'warning';
  if (kind === 'gate-verdict') return face?.status === 'pass' || face?.status === 'approved' ? 'success' : face?.status === 'fail' || face?.status === 'veto' ? 'destructive' : 'info';
  if (kind === 'land-merge') return face?.status === 'merged' || face?.status === 'landed' ? 'success' : 'info';
  if (kind === 'token-burn-snapshot') return face?.status === 'deny' ? 'destructive' : face?.status === 'ask' ? 'warning' : 'info';
  if (kind === 'mention-confirm-required') return 'warning';
  if (kind === 'mention-steer-failed') return 'destructive';
  if (kind === 'spawn-proposal' || kind === 'mention-steer' || kind === 'plan-card') return 'info';
  return 'neutral';
}

function labelFromKey(key: string): string {
  return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function normalizeForCompare(value: string): string {
  // Titles are built from the same source string as the body, then decorated ("Needs you · X",
  // "needs you · X…") and truncated with an ellipsis. Compare the informational core, not the chrome.
  return value.replace(/[…]/g, '').replace(/^[^·]*·\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when `value` tells the reader nothing the title has not already said. */
export function repeatsTitle(value: string | undefined, title: string): boolean {
  if (!value) return true;
  const a = normalizeForCompare(value);
  const b = normalizeForCompare(title);
  if (!a) return true;
  return a === b || b.startsWith(a) || a.startsWith(b);
}

/**
 * The body a card should actually print. `face.body || entry.text` (the old rule) rendered every
 * needs-you card twice, because `entry.text` is the sentence the title was built from.
 */
export function cardBody(faceBody: string | undefined, entryText: string | undefined, title: string): string {
  if (faceBody && !repeatsTitle(faceBody, title)) return faceBody;
  if (entryText && !repeatsTitle(entryText, title)) return entryText;
  return '';
}


function stringFromPath(value: unknown, path: readonly string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === 'string' && cursor ? cursor : undefined;
}

export function channelCardActionHref(entry: ChannelEntry): string | undefined {
  if (entry.event?.kind !== 'needs-you') return undefined;
  const payload = entry.event.payload;
  const agentId =
    stringFromPath(payload, ['refs', 'unitId']) ??
    stringFromPath(payload, ['face', 'unitId']) ??
    stringFromPath(payload, ['agentId']);
  return agentId ? `#/intervene/${encodeURIComponent(agentId)}` : undefined;
}


export function dispatchChannelCard(entry: ChannelEntry): ChannelCardView {
  const eventKind = entry.event?.kind;
  if (!eventKind) {
    return { id: entry.id, entry, kind: 'message', tone: entry.kind === 'user' ? 'info' : 'neutral', authorLabel: entryAuthorLabel(entry), title: entryAuthorLabel(entry), body: entry.displayText || entry.text, pinned: [] };
  }
  if (!POINTER_EVENT_KINDS[eventKind]) {
    return { id: entry.id, entry, kind: 'unknown-event', tone: 'neutral', authorLabel: entryAuthorLabel(entry), title: labelFromKey(eventKind), eyebrow: 'Event', body: entry.text || 'This room event is from a newer daemon. Update the client to see the full card.', pinned: [] };
  }
  const authorLabel = entryAuthorLabel(entry);
  const landCard = landCardView(entry, entry.event?.payload, authorLabel);
  if (landCard) return landCard;
  const face = faceFromPayload(entry.event?.payload);
  const title = face?.title || labelFromKey(eventKind);
  const body = cardBody(face?.body, entry.text, title);
  const pinned = Object.entries(face?.pinned ?? {}).flatMap(([label, value]) => value == null || value === '' || repeatsTitle(String(value), title) ? [] : [{ label: labelFromKey(label), value: String(value) }]);
  const doorHrefResolved = eventKind === 'token-burn-snapshot' ? '#/workbench/economics' : (face?.href ?? hrefFromPayload(entry.event?.payload));
  return { id: entry.id, entry, kind: eventKind as ChannelCardKind, tone: toneFor(eventKind, face), authorLabel: entryAuthorLabel(entry), title, eyebrow: face?.eyebrow, body, detail: face?.detail, pinned, actionHref: channelCardActionHref(entry), href: doorHrefResolved };
}

const DOOR_LABELS: Record<string, string> = {
  'plan-card': 'Open plan DAG',
  'token-burn-snapshot': 'Open fleet economics',
  'needs-you': 'Step into the agent',
  'gate-verdict': 'Open the proof',
  'land-attempt': 'Open the land record',
  'land-assessment': 'Open the land record',
  'land-merge': 'Open the land record',
  'spawn-proposal': 'Open the proposal',
};

/** Label for a card's door button. Was hardcoded to "Open plan DAG" for every kind — a token-burn
 *  card offering to open a plan DAG is a lie about where the click goes. */
export function doorLabel(kind: string): string {
  return DOOR_LABELS[kind] ?? 'Open';
}

export function reduceChannelEntryWindow(entries: ChannelEntry[], incoming: ChannelEntry[], channelId: string, cap = 500): ChannelEntry[] {
  const byId = new Map<string, ChannelEntry>();
  for (const entry of entries) if (entry.channelId === channelId) byId.set(entry.id, entry);
  for (const entry of incoming) if (entry.channelId === channelId) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.ts - b.ts || a.id.localeCompare(b.id)).slice(-cap);
}

export function latestChannelSeq(entries: readonly ChannelEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
}
