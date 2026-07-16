/**
 * Shared chat-session persistence (webapp-voice-lane concern 08).
 *
 * `AssistantChat.tsx` used to own `Session`/`Message` plus every localStorage read/write inline —
 * that was fine while it was the ONLY writer. It no longer is: DESIGN.md's "Transcript coherence"
 * row requires the voice call's spoken summaries to land as durable model `Message`s in the BOUND
 * session, and the live `VoiceSession` is owned at provider level (App.tsx, beside `TaskContext`)
 * specifically so it survives `AssistantChat` unmounting (Back/close/session-delete — see
 * `VoiceCallContext.tsx`). Provider-level code can't reach into `AssistantChat`'s local `useState`,
 * so this module is the one place both sides read/write the same `localStorage['assistant-chat-
 * sessions']` blob, in the same `Session[]` shape, and notify each other when it changes.
 *
 * Everything except the three browser-only functions at the bottom (`loadPersistedSessions`,
 * `persistSessions`, `subscribeSessionStore`) is pure and directly unit-tested.
 *
 * DEBRIEF LANE (webapp-voice-lane concern 04, DESIGN.md's "Debrief lane" row): `Session.metadata.
 * voiceDebrief` is the ts-cursor a fresh voice call reads at connect time to decide what finished
 * "while you were away". Wall-clock `ts` ONLY, never `seq` — `seq` is assigned at stream start,
 * mutated in place, and resets on a daemon restart, so it cannot durably mark "already spoken".
 * `advanceVoiceDebriefCursor`/`commitVoiceDebrief` are the two-phase commit's browser-side half:
 * `VoiceCallContext`'s `queueInjection(items, onDone)` only calls them once the debrief's OWN
 * response completes uncancelled (concern 03's primitive) — a barge-in or early hang-up leaves the
 * cursor untouched and the next call simply re-debriefs the same backlog.
 *
 * EPISODE-IN-DEBRIEF (comprehension concern 11): the weekly state-of-the-codebase brief
 * (`src/weekly-episode.ts`'s `EpisodeMeta.generatedAt`) rides this SAME `voiceDebrief.cursorTs` —
 * no second cursor field. `VoiceCallContext.tsx`'s connect-time effect compares an episode's
 * `generatedAt` against this cursor exactly like a qualifying transcript entry's `ts`, and folds
 * the episode into the same two-phase `queueInjection` commit as the transcript debrief below (see
 * that file's own comment for why the COMMITTED value is wall-clock "now", not the episode's own
 * stale `generatedAt`, whenever an episode was included).
 *
 * KNOWN GAP (report, not hacked around): while `AssistantChat` is mounted and showing the bound
 * session, a voice-authored write lands here, `notifySessionStoreListeners()` fires, and
 * `AssistantChat`'s own subscriber (added in this pass) merges it into its local `sessions` state
 * via `mergeSessions` — so the operator DOES see the spoken summary appear live, not just after a
 * remount. What this module does NOT solve: two independent tabs/windows writing to the same
 * session within the same millisecond (`updatedAt` tie) — `mergeSessions` keeps whichever side
 * currently holds the array, which is a best-effort dedupe, not last-write-wins by wall clock.
 * Out of scope for a single-operator SPA; noted for the record.
 */

import type { SpawnedUnitRecord } from '../spawnProposal';

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  /** Stamped on a user turn at send time so render-time coverage dedupe can match this durable
   *  copy against the transcript entry the server echoes back with the same id. */
  clientTurnId?: string;
  /** Set when a turn never reached (or never echoed from) the server. */
  undelivered?: boolean;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  metadata?: {
    status?: 'waiting' | 'active' | 'autonomous' | 'completed';
    tasksDiscussed?: string[];
    stage?: string;
    agentId?: string;
    /** Debrief lane ts-cursor (concern 04) — absent means "never debriefed" (first call, or every
     *  debrief so far skipped silently for lack of backlog). `cursorTs` only ever moves forward
     *  (see `advanceVoiceDebriefCursor`); `lastCallEndedAt` is stamped by `endCall()` on every call,
     *  purely for observability + seeding a fresh cursor on this session's first-ever call end.
     *  Also gates the weekly episode brief (concern 11) — see this file's module doc comment. */
    voiceDebrief?: { cursorTs: number; lastCallEndedAt?: number };
  };
  spawnedUnits?: SpawnedUnitRecord[];
}

export const CHAT_SESSIONS_KEY = 'assistant-chat-sessions';
const CHAT_WELCOME_MESSAGE = "Ask me anything about the current fleet, or tell me what to do. I’ll keep this as a chat unless you explicitly ask me to start work.";

export const createInitialSession = (now = Date.now()): Session => ({
  id: 'default',
  title: 'Initial conversation',
  metadata: { status: 'active', tasksDiscussed: [], stage: 'Planning' },
  messages: [{ role: 'model', text: CHAT_WELCOME_MESSAGE, timestamp: now }],
  updatedAt: now,
});

const isSession = (value: unknown): value is Session => {
  const rec = value && typeof value === 'object' ? (value as Partial<Session>) : {};
  return typeof rec.id === 'string' && typeof rec.title === 'string' && Array.isArray(rec.messages) && typeof rec.updatedAt === 'number';
};

/** Old localStorage blobs may carry a `reaction` field on messages from the (now removed) thumbs
 *  up/down UI. Strip it so it doesn't ride forward into freshly re-persisted state. */
const stripLegacyReaction = (message: Message): Message => {
  if (!message || typeof message !== 'object' || !('reaction' in message)) return message;
  const { reaction: _reaction, ...rest } = message as Message & { reaction?: unknown };
  return rest as Message;
};

export function normalizeAssistantSessions(value: unknown, now = Date.now()): Session[] {
  if (!Array.isArray(value)) return [createInitialSession(now)];
  const sessions = value
    .filter(isSession)
    .map((session) => ({ ...session, messages: session.messages.map(stripLegacyReaction) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.length ? sessions : [createInitialSession(now)];
}

// =============================================================================
// Pure mutations — the voice provider's writes, and the merge AssistantChat applies when an
// external (voice-authored) write lands while it's mounted.
// =============================================================================

/** Append a durable model `Message` (a spoken summary) to `sessionId`'s thread. Returns the SAME
 *  array reference when `sessionId` isn't found or `text` is blank — callers use `!==` to decide
 *  whether a write actually happened (see `appendSpokenSummary` below). */
export function appendModelMessage(sessions: Session[], sessionId: string, text: string, now: number): Session[] {
  const trimmed = text.trim();
  if (!trimmed) return sessions;
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    changed = true;
    return { ...session, messages: [...session.messages, { role: 'model' as const, text: trimmed, timestamp: now }], updatedAt: now };
  });
  return changed ? next : sessions;
}

/** Append a durable USER `Message` (a voice-spoken prompt — MAJOR-2a) to `sessionId`'s thread,
 *  stamped with the dispatch's own `clientTurnId` so it rides the EXISTING render-time coverage
 *  dedupe `partitionSessionMessages` (AssistantChat.tsx) already applies to `role:'user'` messages:
 *  once the transcript echoes that same `clientTurnId` back as a real entry, this durable copy is
 *  suppressed and the operator's spoken turn renders from the transcript itself, as the USER — not
 *  as a `role:'model'` bubble (the bug this fixes: `appendSpokenSummary` used to persist BOTH the
 *  operator's prompt and the assistant's completion as `role:'model'`). Returns the SAME array
 *  reference when `sessionId` isn't found or `text` is blank, same discipline as `appendModelMessage`.
 *
 *  `clientTurnId` is optional: a plain voice turn (the operator speaking to the voice model with
 *  no `prompt_agent` dispatch behind it — VoiceCallContext's caption flush) never reaches the
 *  agent transcript, so it has no echo to dedupe against and no turn id to carry. */
export function appendUserMessage(sessions: Session[], sessionId: string, text: string, clientTurnId: string | undefined, now: number): Session[] {
  const trimmed = text.trim();
  if (!trimmed) return sessions;
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    changed = true;
    return {
      ...session,
      messages: [...session.messages, { role: 'user' as const, text: trimmed, timestamp: now, ...(clientTurnId ? { clientTurnId } : {}) }],
      updatedAt: now,
    };
  });
  return changed ? next : sessions;
}

/** Patch `metadata.agentId` on `sessionId` — mirrors `AssistantChat.handleSend`'s own
 *  `nextAgentId !== priorAgentId` update, for the voice dispatcher's bootstrap/dead-agent-recovery
 *  mint (concern 07's `onAgentBound`). No-op (same reference) if already set to this id.
 *
 *  MEDIUM-3: bumps `updatedAt` to `now` on every real change. Without this, `mergeSessions` (whose
 *  tie-break keeps CURRENT's copy on an equal `updatedAt`) would see the binding write as a no-op
 *  update, so the very next `persistSessions` from `AssistantChat` (e.g. its own unrelated
 *  `updateSessionMessages` bump) could overwrite localStorage with a copy that never picked up the
 *  freshly-bound `agentId` — the voice bootstrap binding silently lost across a reload. */
export function updateSessionAgentId(sessions: Session[], sessionId: string, agentId: string, now = Date.now()): Session[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId || session.metadata?.agentId === agentId) return session;
    changed = true;
    return { ...session, metadata: { ...session.metadata, agentId }, updatedAt: now };
  });
  return changed ? next : sessions;
}

const VOICE_DEBRIEF_DAY_MS = 24 * 60 * 60 * 1000;

/** The debrief lane's two-phase commit primitive (concern 04): bump `sessionId`'s
 *  `voiceDebrief.cursorTs` to `cursorTs` — but ONLY forward. `VoiceCallContext`'s
 *  `queueInjection(items, ({cancelled}) => ...)` calls this exclusively from the `cancelled:false`
 *  branch (the debrief's own response actually completed) and from `sweepPromptWatchers`' live
 *  narration `onDone` (a completion narrated DURING the call counts as "heard" too) — never from
 *  effect cleanup, never unconditionally at call end. A `cursorTs` at or behind the existing value
 *  is a no-op (same array reference) — a stale/racing commit (e.g. a superseded call's late-
 *  resolving injection) must never erase a later advance. Bumps `updatedAt` on a real move
 *  (MEDIUM-3 class — see `updateSessionAgentId`'s doc comment: a non-bumping write is invisible to
 *  `mergeSessions`' tie-break and can be silently clobbered by the very next unrelated persist).
 *  Preserves any existing `lastCallEndedAt` on the same metadata field. */
export function advanceVoiceDebriefCursor(sessions: Session[], sessionId: string, cursorTs: number, now = Date.now()): Session[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const existing = session.metadata?.voiceDebrief;
    if (existing && cursorTs <= existing.cursorTs) return session; // never move backward
    changed = true;
    return { ...session, metadata: { ...session.metadata, voiceDebrief: { ...existing, cursorTs } }, updatedAt: now };
  });
  return changed ? next : sessions;
}

/** `endCall()`'s explicit stamp (a REAL user intent — never the effect cleanup, since StrictMode's
 *  synthetic double-cleanup and every other teardown path must not touch this). Always records
 *  `lastCallEndedAt = now`. When this session has never had a debrief cursor before (`voiceDebrief`
 *  entirely absent — first call ever, or every debrief so far returned null and skipped silently),
 *  ALSO seeds `cursorTs` at `max(now, now - 24h)` — collapses to `now` in practice, kept as the
 *  same 24h-floor formula `buildVoiceDebrief` itself applies at build time (belt-and-braces against
 *  a future caller passing an out-of-band `now`) — so the NEXT call's debrief starts from THIS
 *  call's end instead of relying solely on `buildVoiceDebrief`'s own clamp. Never touches an
 *  EXISTING `cursorTs` — only `advanceVoiceDebriefCursor`'s two-phase commit may move that. Bumps
 *  `updatedAt` — MEDIUM-3 class, same as every other write in this module. */
export function recordVoiceCallEnded(sessions: Session[], sessionId: string, now = Date.now()): Session[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    changed = true;
    const existing = session.metadata?.voiceDebrief;
    const cursorTs = existing?.cursorTs ?? Math.max(now, now - VOICE_DEBRIEF_DAY_MS);
    return { ...session, metadata: { ...session.metadata, voiceDebrief: { cursorTs, lastCallEndedAt: now } }, updatedAt: now };
  });
  return changed ? next : sessions;
}

/** Append a durable `SpawnedUnitRecord` (voice-lane spawn — concern 04) to `sessionId`'s
 *  `spawnedUnits`, the same durable "I asked -> here's the PR" record `AssistantChat`'s own typed
 *  spawn-confirm flow writes (`handleConfirmSpawn`) — so a voice-dispatched spawn becomes visible to
 *  the NEXT call's debrief tracked-agent set (`VoiceCallContext`) exactly like a typed one already
 *  is. Bumps `updatedAt` — MEDIUM-3 class. Returns the SAME array reference when the session isn't
 *  found. */
export function appendSpawnedUnit(sessions: Session[], sessionId: string, record: SpawnedUnitRecord, now = Date.now()): Session[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    changed = true;
    return { ...session, spawnedUnits: [...(session.spawnedUnits ?? []), record], updatedAt: now };
  });
  return changed ? next : sessions;
}

/** Fold an externally-written `persisted` snapshot into `current` — id-by-id, newer `updatedAt`
 *  wins, ties keep `current`'s own copy. Returns `current` UNCHANGED (same reference) when nothing
 *  actually moved, which is load-bearing: `VoiceCallContext`'s own writes echo back through this
 *  same path (write → notify → AssistantChat's subscriber → this function), and returning the same
 *  reference is what makes React's `setState` bail out instead of looping forever on a
 *  self-notification (see the module doc comment's known-gap note for the one case this doesn't
 *  perfectly resolve). */
export function mergeSessions(current: Session[], persisted: Session[]): Session[] {
  let changed = false;
  const byId = new Map(current.map((session) => [session.id, session]));
  for (const incoming of persisted) {
    const existing = byId.get(incoming.id);
    if (!existing || incoming.updatedAt > existing.updatedAt) {
      byId.set(incoming.id, incoming);
      changed = true;
    }
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// =============================================================================
// Browser-only read/write/notify — the one place either side touches localStorage.
// =============================================================================

const listeners = new Set<() => void>();

/** Notified after EVERY successful `persistSessions` call, regardless of which side wrote —
 *  `AssistantChat` uses this to pick up a voice-authored spoken summary live; `VoiceCallContext`
 *  uses it to detect the pinned session being deleted out from under an active call. */
export function subscribeSessionStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifySessionStoreListeners(): void {
  for (const listener of listeners) listener();
}

export function loadPersistedSessions(): Session[] {
  if (typeof window === 'undefined') return normalizeAssistantSessions(null);
  let parsed: unknown = null;
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null; // storage blocked (private mode) or corrupt JSON — fall back to a fresh session
  }
  return normalizeAssistantSessions(parsed);
}

/** Like `loadPersistedSessions`, but distinguishes a storage/parse FAILURE (`null`) from a
 *  genuinely empty/missing blob (still normalizes to the default single session, same array shape
 *  `loadPersistedSessions` would return) — LOW-7: `VoiceCallContext`'s deletion watch needs this
 *  distinction, since `loadPersistedSessions`' own fallback-to-a-fresh-session-list behavior means
 *  a transient storage hiccup mid-call (private-mode storage blip, a corrupt write from another
 *  tab) would otherwise read EXACTLY like "the bound session is gone" — the fresh default list
 *  never contains the bound session id either way, so the deletion watch would false-positive and
 *  end the call with a toast over nothing. Every OTHER caller keeps using `loadPersistedSessions`:
 *  falling back to a fresh session list on failure is the right behavior for them (they're
 *  reading/writing sessions, not deciding "was this one deleted"). */
export function loadPersistedSessionsOrNull(): Session[] | null {
  if (typeof window === 'undefined') return normalizeAssistantSessions(null); // not a failure — no browser to fail in
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_KEY);
    return normalizeAssistantSessions(raw ? JSON.parse(raw) : null);
  } catch {
    return null; // storage blocked (private mode) or corrupt JSON — a genuine FAILURE, not "empty"
  }
}

export function persistSessions(sessions: Session[]): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions));
    } catch {
      // storage blocked — nothing durable to write, but listeners still hear about the in-memory change
    }
  }
  notifySessionStoreListeners();
}

/** The voice dispatcher's `onSpokenSummary` lands here (`VoiceCallContext.tsx`). Read-modify-write
 *  against the CURRENT persisted snapshot (not any in-memory copy the caller might be holding) —
 *  the provider has no local `sessions` array of its own, only the pinned `sessionId`. */
export function appendSpokenSummary(sessionId: string, text: string, now = Date.now()): void {
  const sessions = loadPersistedSessions();
  const next = appendModelMessage(sessions, sessionId, text, now);
  if (next !== sessions) persistSessions(next);
}

/** The voice dispatcher's `onSpokenSummary` `role:'user'` half (MAJOR-2a) lands here — same
 *  read-modify-write shape as `appendSpokenSummary`, but persists as a user Message stamped with
 *  the dispatch's `clientTurnId` (see `appendUserMessage`'s own doc comment for why).
 *  `VoiceCallContext`'s caption flush also lands plain (dispatch-less) voice turns here, with no
 *  `clientTurnId` — those turns exist nowhere else, so there is nothing to dedupe them against. */
export function appendSpokenUserMessage(sessionId: string, text: string, clientTurnId: string | undefined, now = Date.now()): void {
  const sessions = loadPersistedSessions();
  const next = appendUserMessage(sessions, sessionId, text, clientTurnId, now);
  if (next !== sessions) persistSessions(next);
}

/** The voice dispatcher's `onAgentBound` lands here — same read-modify-write shape as
 *  `appendSpokenSummary`. */
export function bindSessionAgent(sessionId: string, agentId: string, now = Date.now()): void {
  const sessions = loadPersistedSessions();
  const next = updateSessionAgentId(sessions, sessionId, agentId, now);
  if (next !== sessions) persistSessions(next);
}

/** The debrief lane's two-phase commit lands here — `VoiceCallContext`'s `queueInjection` onDone
 *  (cancelled:false) and `sweepPromptWatchers`' live-narration onDone both call this. Same read-
 *  modify-write shape as `appendSpokenSummary`. */
export function commitVoiceDebrief(sessionId: string, cursorTs: number, now = Date.now()): void {
  const sessions = loadPersistedSessions();
  const next = advanceVoiceDebriefCursor(sessions, sessionId, cursorTs, now);
  if (next !== sessions) persistSessions(next);
}

/** `endCall()`'s explicit `lastCallEndedAt` stamp (+ cursor seed for a never-debriefed session) —
 *  same read-modify-write shape as `appendSpokenSummary`. */
export function stampVoiceCallEnded(sessionId: string, now = Date.now()): void {
  const sessions = loadPersistedSessions();
  const next = recordVoiceCallEnded(sessions, sessionId, now);
  if (next !== sessions) persistSessions(next);
}

/** The voice dispatcher's `onAgentSpawned` lands here — same read-modify-write shape as
 *  `appendSpokenSummary`. `record` is built by the caller (`VoiceCallContext`) from the
 *  dispatcher's `{id, name, prompt}` event. */
export function recordVoiceSpawn(sessionId: string, record: SpawnedUnitRecord, now = Date.now()): void {
  const sessions = loadPersistedSessions();
  const next = appendSpawnedUnit(sessions, sessionId, record, now);
  if (next !== sessions) persistSessions(next);
}
