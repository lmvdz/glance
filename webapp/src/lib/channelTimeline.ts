import type { ChannelEntry } from './dto';
import { entryAuthorLabel } from './hub';

export type ChannelCardTone = 'neutral' | 'info' | 'warning' | 'success' | 'destructive';
export type ChannelCardKind = 'message' | 'needs-you' | 'gate-verdict' | 'land-merge' | 'mention-steer' | 'mention-confirm-required' | 'mention-steer-failed' | 'spawn-proposal' | 'unknown-event';

export interface PointerCardFace {
  title: string;
  eyebrow?: string;
  body?: string;
  detail?: string;
  status?: string;
  tone?: ChannelCardTone;
  pinned?: Record<string, string | number | boolean | null | undefined>;
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
  replyContext?: { id: string; channelId: string; authorLabel: string; body: string };
  repliedBy?: number;
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

const POINTER_EVENT_KINDS: Record<string, true> = { 'needs-you': true, 'gate-verdict': true, 'land-merge': true, 'mention-steer': true, 'mention-confirm-required': true, 'mention-steer-failed': true, 'spawn-proposal': true };

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

function isTone(value: unknown): value is ChannelCardTone {
  return value === 'neutral' || value === 'info' || value === 'warning' || value === 'success' || value === 'destructive';
}

function toneFor(kind: string, face?: PointerCardFace): ChannelCardTone {
  if (face?.tone) return face.tone;
  if (kind === 'needs-you') return 'warning';
  if (kind === 'gate-verdict') return face?.status === 'pass' || face?.status === 'approved' ? 'success' : face?.status === 'fail' || face?.status === 'veto' ? 'destructive' : 'info';
  if (kind === 'land-merge') return face?.status === 'merged' || face?.status === 'landed' ? 'success' : 'info';
  if (kind === 'mention-confirm-required') return 'warning';
  if (kind === 'mention-steer-failed') return 'destructive';
  if (kind === 'spawn-proposal' || kind === 'mention-steer') return 'info';
  return 'neutral';
}

function labelFromKey(key: string): string {
  return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}


export function dispatchChannelCard(entry: ChannelEntry): ChannelCardView {
  const eventKind = entry.event?.kind;
  if (!eventKind) {
    return { id: entry.id, entry, kind: 'message', tone: entry.kind === 'user' ? 'info' : 'neutral', authorLabel: entryAuthorLabel(entry), title: entryAuthorLabel(entry), body: entry.displayText || entry.text, pinned: [] };
  }
  if (!POINTER_EVENT_KINDS[eventKind]) {
    return { id: entry.id, entry, kind: 'unknown-event', tone: 'neutral', authorLabel: entryAuthorLabel(entry), title: labelFromKey(eventKind), eyebrow: 'Event', body: entry.text || 'This room event is from a newer daemon. Update the client to see the full card.', pinned: [] };
  }
  const face = faceFromPayload(entry.event?.payload);
  const title = face?.title || labelFromKey(eventKind);
  const body = face?.body || entry.text || 'Card update';
  const pinned = Object.entries(face?.pinned ?? {}).flatMap(([label, value]) => value == null || value === '' ? [] : [{ label: labelFromKey(label), value: String(value) }]);
  return { id: entry.id, entry, kind: eventKind as ChannelCardKind, tone: toneFor(eventKind, face), authorLabel: entryAuthorLabel(entry), title, eyebrow: face?.eyebrow, body, detail: face?.detail, pinned };
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
