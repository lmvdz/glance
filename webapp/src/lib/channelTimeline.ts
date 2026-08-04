import type { ChannelEntry } from './dto';
// THE wire-contract seam (concern 08): a TYPE-ONLY import of the daemon's canonical event-kind
// union — vite bundles nothing, no runtime coupling exists, but the kind space now has exactly
// one author. A kind added in src/transcript-event-kinds.ts is a COMPILE error here until
// POINTER_EVENT_KINDS (below) gains its rendering entry — the sync guarantee the old two-file
// text-scrape test approximated, now enforced by tsc.
import type { TranscriptEventKind } from '../../../src/transcript-event-kinds.ts';
import { landCardView, type LandCardKind } from '../components/hub/LandCards';
import { entryAuthorLabel, entryTimeLabel } from './hub';
import { unitHref } from './router';
import { withoutRawRoomEvents } from './voice/roomCall';

export type ChannelCardTone = 'neutral' | 'info' | 'warning' | 'success' | 'destructive';
/** Kinds minted client-side only (optimistic UI, never persisted by the daemon) — namespaced
 *  `local:` on the wire by HubShell's managerCardEntry to keep them out of the daemon's kind
 *  space. See tests/channel-card-kinds-sync.test.ts for the cross-build invariant this protects. */
export type LocalCardKind = 'local:mention-confirm-required' | 'local:mention-steer-failed' | 'local:spawn-proposal';
export type ChannelCardKind = 'message' | TranscriptEventKind | LocalCardKind | 'unknown-event';

/** Epistemic register for the face's TEXT (title/body/detail — the claim content), never chrome
 *  (eyebrow/status/pinned/icon/door stay system-authored regardless). Reserved wire field: no
 *  emitter sets it yet and no styling reads it — the first emitter (concern 03's voice-decision
 *  card) drives the visual treatment. Absent means default rendering, identical to today. */
export type ChannelCardRegister = 'checked' | 'claim' | 'unverified';

export interface PointerCardFace {
  title: string;
  eyebrow?: string;
  body?: string;
  detail?: string;
  status?: string;
  tone?: ChannelCardTone;
  pinned?: Record<string, string | number | boolean | null | undefined>;
  href?: string;
  register?: ChannelCardRegister;
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
  pinned: Array<{ label: string; value: string; full?: string }>;
  land?: { kind: LandCardKind; branch?: string; sha?: string; target?: string; risk?: string; recommendation?: string; outcome?: string; prNumber?: string; prUrl?: string; doneProofVerified?: string };
  replyContext?: { id: string; channelId: string; authorLabel: string; body: string };
  repliedBy?: number;
  actionHref?: string;
  href?: string;
  /** Times this same unanswered question was re-announced after this card. See `foldRepeatedAsks`. */
  askedAgain?: number;
  /** When it was last re-announced. */
  lastAskedAt?: number;
  /** The epistemic register its emitter asserted for the card's TEXT (never its chrome). Concern
   *  03's voice-decision card is the first emitter; `ChannelTimelineRow` styles and announces it. */
  register?: ChannelCardRegister;
  /** The call this card belongs to, when it belongs to one — provenance the row prints so a voice
   *  card is never a floating sentence. */
  callId?: string;
  /** The decision this card is about, so its door opens THAT question rather than a panel. */
  decisionId?: string;
}

/**
 * The room does not ask twice.
 *
 * Seen live: the same unanswered question from the same unit appeared as two identical cards, two
 * minutes apart, while the alarm band was already carrying it across the top of the screen. Three
 * copies of one question. A question repeating itself does not make it more likely to be answered —
 * it makes the room look like it has lost track of what it already said, which is the opposite of
 * what a person needs from a screen whose job is to be trustworthy about what needs them.
 *
 * So a re-announcement folds into the card already on screen and says so, once, in its own line. The
 * FIRST card stays — the time a question was first asked is the fact worth keeping, and how long it
 * has gone unanswered is measured from it.
 *
 * Only `needs-you` folds, and only for the same unit and the same question. Two genuinely different
 * questions from one agent are two things a person has to answer.
 */
export function foldRepeatedAsks(views: readonly ChannelCardView[]): ChannelCardView[] {
  const firstByKey = new Map<string, ChannelCardView>();
  const out: ChannelCardView[] = [];
  for (const view of views) {
    if (view.kind !== 'needs-you') { out.push(view); continue; }
    // Chip labels are title-cased for display ("Agent"), and a needs-you card is authored by the
    // MANAGER rather than the unit — so authorActor is the same for every one of them and is useless
    // as a key on its own. Matching it case-sensitively meant every card keyed on its title alone,
    // and two agents asking the same question folded into one. Prefer the event's own unit ref.
    const unit =
      stringFromPath(view.entry.event?.payload, ['refs', 'unitId']) ??
      view.pinned.find((chip) => chip.label.toLowerCase() === 'agent')?.full ??
      view.pinned.find((chip) => chip.label.toLowerCase() === 'agent')?.value ??
      view.entry.authorActor;
    const key = `${unit} ${normalizeForCompare(view.title)}`;
    const first = firstByKey.get(key);
    if (!first) {
      const fresh = { ...view };
      firstByKey.set(key, fresh);
      out.push(fresh);
      continue;
    }
    first.askedAgain = (first.askedAgain ?? 0) + 1;
    first.lastAskedAt = view.entry.ts;
  }
  return out;
}

/**
 * The line a folded card carries, or nothing when it was only asked once.
 *
 * The time comes from `entryTimeLabel`, the same formatter the card's own header uses. My first pass
 * called `toLocaleTimeString` directly and produced a card headed "20:48" carrying a line reading
 * "08:57 PM" — two clocks on one card, which makes a reader stop and work out whether they are even
 * the same day.
 */
export function askedAgainLine(view: Pick<ChannelCardView, 'askedAgain' | 'lastAskedAt'>, now?: number): string | undefined {
  if (!view.askedAgain) return undefined;
  const when = view.lastAskedAt ? entryTimeLabel(view.lastAskedAt, now) : undefined;
  return `Asked again ${view.askedAgain === 1 ? 'once' : `${view.askedAgain} times`}${when ? `, last at ${when}` : ''}. It is the same question — answering it once is enough.`;
}

export function previewChannelBody(text: string, limit = 120): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

export function buildChannelThreadViews(entries: ChannelEntry[]): ChannelCardView[] {
  // Raw tool bookkeeping never reaches a card. `yield`, heartbeats and empty completions are
  // diagnostic-only (DESIGN.md's "Workspace activity" row) — dropping them HERE covers the room and
  // a unit's own conversation in one place, because both render through this function.
  const baseViews = withoutRawRoomEvents(entries).map(dispatchChannelCard);
  const byId = new Map(baseViews.map((view) => [view.id, view]));
  const replyCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.replyToId) replyCounts.set(entry.replyToId, (replyCounts.get(entry.replyToId) ?? 0) + 1);
  }
  const withReplies = baseViews.map((view) => {
    const parent = view.entry.replyToId ? byId.get(view.entry.replyToId) : undefined;
    const replyContext = parent ? { id: parent.id, channelId: parent.entry.channelId, authorLabel: parent.authorLabel, body: previewChannelBody(parent.body, 96) } : undefined;
    const repliedBy = replyCounts.get(view.id);
    return replyContext || repliedBy ? { ...view, replyContext, repliedBy } : view;
  });
  // Folding comes last, so a re-announcement that someone replied to still carries its reply context
  // onto the card that survives.
  return foldRepeatedAsks(withReplies);
}

// Daemon-emitted kinds only. Compile-time exhaustive: adding a member to ChannelCardKind that
// isn't 'message' | 'unknown-event' | LocalCardKind forces a matching entry here (or the
// `satisfies` fails), and an entry here for a kind that doesn't exist fails the same way.
const POINTER_EVENT_KINDS = {
  'needs-you': true,
  'gate-verdict': true,
  'land-attempt': true,
  'land-assessment': true,
  'land-merge': true,
  'mention-steer': true,
  'goal-overlap': true,
  'plan-card': true,
  'return-emit': true,
  'design-revised': true,
  'token-burn-snapshot': true,
  'unit-spawned': true,
  'unit-turn-finished': true,
  'unit-failed': true,
  'pr-opened': true,
  'verification-ran': true,
  'voice-call': true,
  'voice-decision': true,
  'voice-fleet-action': true,
} satisfies Record<TranscriptEventKind, true>;

// Client-minted kinds (see LocalCardKind). Exhaustive over LocalCardKind the same way.
// Exported (only) for tests/channel-card-kinds-sync.test.ts's runtime collision check —
// the one cross-build invariant tsc cannot see (see that test's doc).
export const LOCAL_CARD_KINDS = {
  'local:mention-confirm-required': true,
  'local:mention-steer-failed': true,
  'local:spawn-proposal': true,
} satisfies Record<LocalCardKind, true>;

/** Narrows a raw wire `eventKind` string to a known ChannelCardKind, or undefined if the daemon
 *  (or webapp) doesn't know how to render it yet. Replaces an unsound `as ChannelCardKind` cast
 *  that indexed iconClass to `undefined` and threw mid-render for any unmapped kind. */
function pointerCardKind(eventKind: string): ChannelCardKind | undefined {
  if (Object.prototype.hasOwnProperty.call(POINTER_EVENT_KINDS, eventKind)) return eventKind as ChannelCardKind;
  if (Object.prototype.hasOwnProperty.call(LOCAL_CARD_KINDS, eventKind)) return eventKind as ChannelCardKind;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Internal-route guard, mirrored from the server schema (`src/schema/channel-card.ts`): a card
 *  href may only ever be a client hash route. Defense in depth for an old daemon that predates the
 *  schema check, or a future mistake — a `javascript:`/`https:` href lands raw in `<a href>`
 *  (`ChannelTimeline.tsx`), so this is dropped rather than trusted. */
function safeHref(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('#/') ? value : undefined;
}

function isRegister(value: unknown): value is ChannelCardRegister {
  return value === 'checked' || value === 'claim' || value === 'unverified';
}

/** Exported for direct testing of the wire→face parse (register round-trip, href guard) —
 *  `dispatchChannelCard` is the only other caller. */
export function faceFromPayload(payload: unknown): PointerCardFace | undefined {
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
    href: safeHref(face.href),
    register: isRegister(face.register) ? face.register : undefined,
  };
}

function hrefFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = safeHref(payload.href);
  if (direct) return direct;
  if (payload.doorSurface === 'plan' && isRecord(payload.refs) && typeof payload.refs.planId === 'string') return `#/workbench/task/${encodeURIComponent(payload.refs.planId)}`;
  if (payload.doorSurface === 'intervence' && isRecord(payload.refs) && typeof payload.refs.unitId === 'string') return `#/intervene/${encodeURIComponent(payload.refs.unitId)}`;
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
  if (kind === 'local:mention-confirm-required') return 'warning';
  if (kind === 'local:mention-steer-failed') return 'destructive';
  // A unit that stopped in a way it did not choose rendered NEUTRAL — identical to a unit starting.
  // Every lifecycle card looked the same, so the one that mattered was invisible among the ones that
  // did not. Failure is the loudest lifecycle fact there is.
  if (kind === 'unit-failed') return 'destructive';
  // Disclosure, not refusal (see squad-manager.ts's goalConflict comment) — nothing was blocked,
  // so this is a heads-up to check, not an alarm.
  if (kind === 'goal-overlap') return 'warning';
  if (kind === 'local:spawn-proposal' || kind === 'mention-steer' || kind === 'plan-card') return 'info';
  // voice-call: connecting/live are ordinary in-progress facts; degraded is a warning (socket lost,
  // liveness unconfirmed); ended is neutral — it's the honest terminal state, not itself bad news.
  if (kind === 'voice-call') return face?.status === 'degraded' ? 'warning' : face?.status === 'ended' ? 'neutral' : 'info';
  // voice-decision: open/awaiting-confirmation genuinely need a human; answered is a success; a
  // decision that never got one (expired/cancelled/failed) is neutral, not a failure of the room.
  if (kind === 'voice-decision') return face?.status === 'answered' ? 'success' : face?.status === 'open' || face?.status === 'awaiting-confirmation' ? 'warning' : 'neutral';
  // voice-fleet-action (concern 12): an executed approval is a success; a routine relayed action is
  // ordinary info; deferred (held for a human) and failed both genuinely want a look; declined is
  // the neutral, honest record of a human saying no.
  if (kind === 'voice-fleet-action') return face?.status === 'executed' ? 'success' : face?.status === 'relayed' ? 'info' : face?.status === 'declined' ? 'neutral' : 'warning';
  return 'neutral';
}

const LIFECYCLE_CARD_KINDS: Record<string, true> = { 'unit-spawned': true, 'unit-turn-finished': true, 'unit-failed': true, 'pr-opened': true, 'verification-ran': true };

function lifecycleUnitId(view: ChannelCardView): string | undefined {
  const payload = view.entry.event?.payload;
  return stringFromPath(payload, ['refs', 'unitId']) ?? stringFromPath(payload, ['face', 'unitId']);
}

/** The owner named by a goal-overlap card — `face.owner`, the same field the card's tone/copy
 *  already reads (squad-manager.ts's `emitGoalOverlapCard`; never the owner's id, per the
 *  disclosure's own privacy contract, see channel-card.ts). */
function goalOverlapOwner(view: ChannelCardView): string | undefined {
  return stringFromPath(view.entry.event?.payload, ['face', 'owner']);
}

/**
 * The two card families a "run" ever folds, and the key each groups on. Kept as one lookup
 * (rather than two separately-exported group functions) because a run is a property of the
 * FLAT, chronological card list — one pass has to decide, card by card, whether it continues the
 * previous group, and that decision needs both families available at once.
 */
function runFamily(kind: ChannelCardView['kind']): 'lifecycle' | 'goal-overlap' | undefined {
  if (LIFECYCLE_CARD_KINDS[kind]) return 'lifecycle';
  if (kind === 'goal-overlap') return 'goal-overlap';
  return undefined;
}

/**
 * Consecutive disclosures that are, in substance, one event form one run. An intervening card
 * from outside the family always breaks it, preserving chronology rather than merely grouping by
 * key.
 *
 * Two families fold today:
 *  - Lifecycle facts (`unit-spawned`/`unit-turn-finished`/`unit-failed`/`pr-opened`/
 *    `verification-ran`) for the SAME UNIT — the original shape this function was named for.
 *  - `goal-overlap` disclosures for the SAME OWNER — a single dispatch sweep that spawns many
 *    new units against one already-busy owner is a legitimate run, not spam (the actual spam —
 *    the SAME pair repeating across daemon restarts — is fixed upstream, at the source: see
 *    goal-overlap-ledger.ts). Each card in the run still names a different candidate; folding
 *    only changes how many rows a person has to read, never what was disclosed.
 */
export function groupLifecycleRuns(views: ChannelCardView[]): ChannelCardView[][] {
  const groups: ChannelCardView[][] = [];
  for (const view of views) {
    const previous = groups.at(-1);
    const first = previous?.[0];
    const family = first && runFamily(first.kind);
    const sameFamily = family && family === runFamily(view.kind);
    const sameGroup =
      sameFamily &&
      first &&
      (family === 'lifecycle' ? lifecycleUnitId(first) === lifecycleUnitId(view) : goalOverlapOwner(first) === goalOverlapOwner(view));
    if (sameGroup) previous!.push(view);
    else groups.push([view]);
  }
  return groups;
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
  return agentId ? unitHref(agentId) : undefined;
}

/**
 * The unit a needs-you card is about, so the room can open its QUESTION rather than its transcript.
 *
 * Found by using the product: the card's only affordance read "Click to step into the agent", which
 * took you to the conversation. The thing a person wants when something is stopped is to answer it —
 * the reference is explicit that a waiting node opens its question, not its history — and the card
 * was the one place that did the opposite.
 */
export function cardUnitId(entry: ChannelEntry): string | undefined {
  if (entry.event?.kind !== 'needs-you') return undefined;
  const payload = entry.event.payload;
  return (
    stringFromPath(payload, ['refs', 'unitId']) ??
    stringFromPath(payload, ['face', 'unitId']) ??
    stringFromPath(payload, ['agentId'])
  );
}


export function dispatchChannelCard(entry: ChannelEntry): ChannelCardView {
  const eventKind = entry.event?.kind;
  if (!eventKind) {
    return { id: entry.id, entry, kind: 'message', tone: entry.kind === 'user' ? 'info' : 'neutral', authorLabel: entryAuthorLabel(entry), title: entryAuthorLabel(entry), body: entry.displayText || entry.text, pinned: [] };
  }
  const cardKind = pointerCardKind(eventKind);
  if (!cardKind) {
    return { id: entry.id, entry, kind: 'unknown-event', tone: 'neutral', authorLabel: entryAuthorLabel(entry), title: labelFromKey(eventKind), eyebrow: 'Event', body: entry.text || 'This room event is from a newer daemon. Update the client to see the full card.', pinned: [] };
  }
  const authorLabel = entryAuthorLabel(entry);
  const landCard = landCardView(entry, entry.event?.payload, authorLabel);
  if (landCard) return { ...landCard, pinned: landCard.pinned.map(({ label, value }) => pinnedChip(label, value)) };
  const face = faceFromPayload(entry.event?.payload);
  const title = face?.title || labelFromKey(eventKind);
  const body = cardBody(face?.body, entry.text, title);
  const pinned = Object.entries(face?.pinned ?? {}).flatMap(([label, value]) => value == null || value === '' || repeatsTitle(String(value), title) ? [] : [pinnedChip(labelFromKey(label), String(value))]);
  const fleetActionUnitId = eventKind === 'voice-fleet-action' ? stringFromPath(entry.event?.payload, ['refs', 'unitId']) : undefined;
  const doorHrefResolved =
    eventKind === 'token-burn-snapshot'
      ? '#/workbench/economics'
      : // voice-fleet-action's door steps into the unit the action touched (when it named one) —
        // the same surface a lifecycle card about that unit opens.
        (face?.href ?? hrefFromPayload(entry.event?.payload) ?? (fleetActionUnitId ? unitHref(fleetActionUnitId) : undefined));
  // Voice cards carry their call (and, for a decision, which question) so the row can print
  // provenance and open the RIGHT door — a decision card whose door opened "the decisions panel"
  // rather than that decision is the same class of lie as a token-burn card offering a plan DAG.
  const callId = cardKind === 'voice-call' || cardKind === 'voice-decision' || cardKind === 'voice-fleet-action' ? stringFromPath(entry.event?.payload, ['refs', 'callId']) : undefined;
  const decisionId = cardKind === 'voice-decision' || cardKind === 'voice-fleet-action' ? stringFromPath(entry.event?.payload, ['refs', 'decisionId']) : undefined;
  return { id: entry.id, entry, kind: cardKind, tone: toneFor(eventKind, face), authorLabel: entryAuthorLabel(entry), title, eyebrow: face?.eyebrow, body, detail: face?.detail, pinned, actionHref: channelCardActionHref(entry), href: doorHrefResolved, register: face?.register, callId, decisionId };
}

/**
 * A pinned chip shows IDENTITY at a glance and keeps the ADDRESS on demand.
 *
 * These chips were rendering `/home/lars/.claude/jobs/c87e3b4e/tmp/love…` under a REPO label and
 * `squad/doc-greet-mrzklccg-3-26b99e03` under BRANCH — an absolute path truncated past the point of
 * carrying information, and a slug whose only human part is buried between a prefix and a hash. The
 * question the chip answers is "which repo / which branch", and the answer to that is a name.
 *
 * `full` is preserved so the exact value stays one hover (or one selection) away — shortening must
 * never mean losing.
 */
export function pinnedChip(label: string, value: string): { label: string; value: string; full?: string } {
  const short = shortenPinnedValue(label, value);
  return short === value ? { label, value } : { label, value: short, full: value };
}

function shortenPinnedValue(label: string, value: string): string {
  const key = label.toLowerCase();
  if (key === 'repo' || key === 'worktree' || key === 'path') {
    const parts = value.split('/').filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1]! : value;
  }
  if (key === 'branch') {
    // `squad/<name>-<spawnid>-<n>-<sha>` → `<name>`. Only strips a suffix that matches the fleet's
    // own generated shape, so a hand-named branch is left exactly as the human wrote it.
    const withoutPrefix = value.replace(/^squad\//, '');
    const trimmed = withoutPrefix.replace(/-[a-z0-9]{6,}-\d+-[0-9a-f]{6,}$/i, '');
    return trimmed || withoutPrefix;
  }
  return value;
}

const DOOR_LABELS: Record<string, string> = {
  'plan-card': 'Open plan DAG',
  'token-burn-snapshot': 'Open fleet economics',
  'needs-you': 'Answer it',
  'gate-verdict': 'Open the proof',
  'land-attempt': 'Open the land record',
  'land-assessment': 'Open the land record',
  'land-merge': 'Open the land record',
  'local:spawn-proposal': 'Open the proposal',
  'return-emit': 'Step into the agent',
  'design-revised': 'Open plan DAG',
  'voice-call': 'Open the call',
  // Deliberately NOT needs-you's "Answer it". A fleet question and a call question are different
  // work with different vocabulary — the fleet's opens a unit's task and diff, this one opens a
  // question the call is blocked on — and two doors reading the same three words is how a person
  // learns that the label does not tell them where they are going.
  'voice-decision': 'Answer the question',
  // voice-fleet-action: the card is the record of what the call did to the fleet — its door steps
  // into the unit the action touched, same surface a lifecycle card opens.
  'voice-fleet-action': 'Open the unit',
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

/**
 * What a folded run of lifecycle events actually amounts to.
 *
 * The fold's job is to let a person NOT read 38 events, which only works if the summary makes a
 * claim they could disagree with. "38 lifecycle updates" is a count: it tells you the size of the
 * thing you are not reading and nothing about whether you should. A verdict — "nothing unusual", or
 * the one thing that was — is what makes the fold safe to leave folded.
 */
const ALARMING_RUN_KINDS: Partial<Record<ChannelCardView['kind'], true>> = { 'unit-failed': true, 'local:mention-steer-failed': true, 'land-assessment': true };

export function runSummary(views: readonly ChannelCardView[]): { count: number; agents: string[]; kinds: string[]; unusual?: string } {
  // goal-overlap has no "Unit" chip (its pinned face is `{owner, basis}` — see channel-card.ts) —
  // fall back to "Owner" before the generic authorLabel (always "manager" for this kind, which
  // told a reader nothing about which owner the run was actually about).
  const agents = [...new Set(views.map((view) => view.pinned.find((item) => item.label === 'Unit')?.value ?? view.pinned.find((item) => item.label === 'Owner')?.value ?? view.authorLabel).filter(Boolean))];
  const kinds = [...new Set(views.map((view) => view.kind).filter((kind) => kind !== 'unknown-event'))];
  // Anything the renderer already considered alarming is, by definition, the thing a person would
  // have wanted surfaced — so it is surfaced rather than folded away under a reassuring count.
  // Keyed on KIND as well as tone. Tone is a rendering decision that can be wrong — it was: a failed
  // unit rendered neutral until this was found — and a fold that inherits that mistake hides exactly
  // the run a person needed. Absence of an alarming tone must not read as "nothing happened".
  const alarming = views.filter((view) => view.tone === 'destructive' || view.tone === 'warning' || ALARMING_RUN_KINDS[view.kind]);
  const unusual = alarming.length === 0
    ? undefined
    : alarming.length === 1
      ? alarming[0]!.title
      : `${alarming.length} of these need a look, starting with ${alarming[0]!.title}`;
  return { count: views.length, agents, kinds, ...(unusual ? { unusual } : {}) };
}
