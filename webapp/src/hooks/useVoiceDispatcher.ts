import { useCallback, useEffect, useRef } from 'react';
import { apiJson, jsonInit } from '../lib/api';
import { ensureConsoleAgent, buildPromptCommand } from '../lib/chat/sendCore';
import { interruptCommand, interruptibleAgents } from '../lib/agent-control';
import {
  buildCompletionInjectionItems,
  buildDeliveryFailureInjectionItems,
  buildFreshAgentNoticeItems,
  buildVoiceRecap,
  completionOutcome,
  decideToolCall,
  dispatchedOutput,
  failedOutput,
  findCompletionEntry,
  findEchoEntry,
  formatFleetStatus,
  isBoundAgentLive,
  type DispatcherDecisionState,
} from '../lib/voice/tools';
import type { PendingFunctionCall, VoiceSession } from '../lib/voice/voiceSession';
import type { AgentDTO, AuditEntry, ClientCommand, FeatureDTO, TranscriptEntry } from '../lib/dto';
import type { Project } from '../types';
import { useTaskContext } from '../context/TaskContext';
import { usePageContext, type PageContext } from '../context/PageContext';

/**
 * Voice tool dispatcher hook (webapp-voice-lane concern 07) — the bridge from `VoiceSession`
 * `function_call`s to the fleet, threaded under `TaskContext` (per DESIGN.md's "Dispatcher
 * placement" row: `connectSquad` is a factory, so a plain lib module here would open a SECOND
 * socket; a hook reaches the one live socket via `useTaskContext().sendConsoleCommand`).
 *
 * SURFACE GAP (report, don't hack around): `VoiceSessionOptions` (voiceSession.ts) fixes its
 * callbacks at construction time — there is no `session.on('functionCall', ...)` setter. This
 * hook therefore does NOT take a `VoiceSession` and "wire into" it after the fact; instead it
 * hands back stable `onFunctionCall`/`getRecap` callbacks for the CALLER (concern 08, which owns
 * `VoiceSession` construction at provider level per DESIGN.md's "Session ownership" row) to pass
 * straight into `createVoiceSession(mintFn, { onFunctionCall, getRecap, ... })`. `registerSession`
 * is how the caller then hands this hook the constructed instance back, so its own handler can
 * call `session.sendFunctionOutput`/`session.queueInjection` — breaking what would otherwise be a
 * construction-order cycle (the hook needs the session; the session needs the hook's callbacks).
 *
 * SECOND SURFACE GAP (RESOLVED — MINOR-5): `src/voice-token.ts`'s `mintOpenAiToken` now pins its
 * own `VOICE_SESSION_TOOLS` array into the mint request server-side, kept deep-equal with this
 * package's `lib/voice/tools.ts` `VOICE_TOOL_DEFS` by `tests/voice-token.test.ts`'s cross-build sync
 * pin (the daemon (`src/`) and this webapp package build separately, so the two arrays are
 * duplicated by necessity, not drifted-apart by accident). See the final report for the remaining
 * gap — RESOLVED at the 2026-07-13 live pass: the mint now pins `transcription: {model:
 * 'whisper-1'}`, so `onCaption`'s `'user'` branch (used below for spoken displayText) is LIVE.
 * whisper delivers the transcript asynchronously (often mid-reply, usually via the `completed`
 * event rather than deltas), so the buffer below may or may not be populated by dispatch time —
 * `message` (the model's own paraphrase) remains the fallback.
 */

/** Live finding 2026-07-15 (DB mode): a cold bootstrap — mint the console agent, boot its omp
 *  process, ACP handshake, THEN deliver the prompt and wait for the transcript echo — can honestly
 *  take >10s, and the old 10s window fired a false "not sure that got delivered" warning on healthy
 *  dispatches. 20s keeps the honest-failure lane (a genuinely lost send still gets confessed) while
 *  covering a slow cold boot. */
const ECHO_TIMEOUT_MS = 20_000;
/** Mirrors `AssistantChat.tsx`'s `stopTimeoutRef` 8s debounce window for its own `handleStop`. */
const INTERRUPT_DEBOUNCE_MS = 8_000;
/** How long a just-minted agent id is trusted as "live" before the roster broadcast catches up.
 *  UNLIKE `sendCore.ts`'s private `recentlyMinted` cache — which evicts the instant the roster
 *  actually contains the id, however long that takes — this is a flat wall-clock window: kept local
 *  and deliberately simpler on purpose, since this dispatcher does NOT want
 *  `ensureConsoleAgent`'s silent-transparent-remint behavior for an already-bound-but-DEAD agent
 *  (see the binding section below), only for a fresh bootstrap mint. `isBoundAgentLive` (MINOR-6,
 *  `lib/voice/tools.ts`) additionally treats an EMPTY roster as no signal either way regardless of
 *  this window — a transient WS-flap read must never be misread as "the agent is gone". A full
 *  evict-on-roster-arrival match to `recentlyMinted` would remove this constant entirely; not done
 *  here (out of this fix's scope) but noted as the fuller alignment MINOR-6 asked for. */
const MINT_GRACE_MS = 5_000;

type CompletionWatcher =
  | { kind: 'prompt'; clientTurnId: string; echoed: false; cursor: number; label: string }
  | { kind: 'prompt'; clientTurnId: string; echoed: true; cursor: number; label: string }
  | { kind: 'spawn'; echoed: true; cursor: number; label: string };

export interface UseVoiceDispatcherOptions {
  /** The chat session this voice call is pinned to — `ensureConsoleAgent`'s single-flight key. */
  sessionId: string;
  /** The console agent id pinned at call start (concern 08 owns computing this from the active
   *  session). Absent means "mint one on first prompt_agent" (bootstrap). Kept in sync via a ref
   *  that this hook itself may advance past the prop (a dead-agent recovery mint) — `onAgentBound`
   *  is how the caller's own state catches back up. */
  agentId?: string;
  /** Model to mint a fresh console agent with, if this hook ever needs to (bootstrap or
   *  dead-agent recovery). `TaskContext` doesn't expose the composer's own `selectedModel` state
   *  (it's local to `AssistantChat`); defaults to '' (daemon default) — see the final report. */
  selectedModel?: string;
  /** Fired whenever this hook mints (or re-mints) the bound console agent, so the caller can
   *  persist the new id onto its own session state (mirrors `AssistantChat.handleSend`'s
   *  `nextAgentId !== priorAgentId` update). */
  onAgentBound?: (agentId: string) => void;
  /** Fired with a lightweight text summary of what was spoken/said each turn, for the caller to
   *  persist as a durable message if it wants (concern 08's job — this hook never touches
   *  storage). Covers both the operator's prompt (role:'user', stamped with the dispatch's own
   *  `clientTurnId` so the caller can persist it in a way the existing user-side render dedupe
   *  already covers once the transcript echoes it back — see `SpokenSummaryEvent`'s doc comment)
   *  and the narrated completion (role:'model', no clientTurnId of its own). */
  onSpokenSummary?: (event: SpokenSummaryEvent) => void;
  /** Fired once a `spawn_agent` dispatch's `/api/spawn` call succeeds (concern 04's durable-voice-
   *  spawns fix) — the caller persists this onto the bound session's `spawnedUnits` so a voice-
   *  spawned agent is visible to the NEXT call's debrief tracked-agent set, exactly like a typed
   *  spawn already is. `prompt` rides along despite DESIGN.md's own `{id, name}` shorthand: the
   *  caller's durable `SpawnedUnitRecord` has a REQUIRED `prompt` field ("the exact prompt sent to
   *  `/api/spawn`" — spawnProposal.ts), and `dispatchSpawnAgent` already has it in scope (the tool
   *  call's own argument) — omitting it would force the caller to either fabricate a placeholder or
   *  leave the field dishonestly blank. */
  onAgentSpawned?: (agent: { id: string; name: string; prompt: string }) => void;
  /** Fired when a completion narration `sweepPromptWatchers` just queued was actually SPOKEN — i.e.
   *  its own `queueInjection` batch resolved `{cancelled: false}` — with the narrated entry's own
   *  `ts`. The debrief lane's other cursor-advance path (`VoiceCallContext`'s call-start debrief is
   *  the first): a completion narrated LIVE, mid-call, counts as "heard" exactly the same as one
   *  spoken from the away-summary, so the persisted cursor must move past it too — otherwise the
   *  operator's very NEXT call would re-debrief something they were just told about seconds ago. */
  onCompletionNarrated?: (entryTs: number) => void;
  /** Fired when a live completion narration was CUT (barge-in / teardown — its `onDone` came back
   *  `cancelled: true`), with the completion entry's `ts`. Review finding: the caller uses this as
   *  an unheard-floor so a LATER successful narration's forward-only cursor commit can't advance
   *  past this never-heard completion and silently drop it from every future debrief. */
  onNarrationLost?: (entryTs: number) => void;
}

/**
 * MAJOR-2 fix: `onSpokenSummary` used to fire a bare `text` string for BOTH the operator's spoken
 * prompt (at dispatch) and the assistant's narrated completion (at completion) — the caller had no
 * way to tell them apart, so both persisted as `role:'model'` with no `clientTurnId`. That broke two
 * things downstream: the operator's OWN spoken prompt rendered as a model bubble (wrong speaker),
 * and the completion summary had nothing to dedupe it against the transcript's own `message_end`
 * entry once that landed, so it rendered twice.
 *
 * This discriminated union lets the caller (`VoiceCallContext.tsx`) persist each half correctly:
 * `role:'user'` with the SAME `clientTurnId` `dispatchPromptAgent` already sent in the dispatched
 * command — `partitionSessionMessages` (AssistantChat.tsx) already dedupes `role:'user'` durable
 * Messages by `clientTurnId` match against the real transcript, so this rides the EXISTING
 * dedupe/speaker-correctness machinery for free instead of needing a parallel one. `role:'model'`
 * carries no `clientTurnId` (a voice completion summary isn't itself a dispatched turn) — its
 * double-render is instead fixed by extending `partitionSessionMessages` with a text-match dedupe
 * against finished assistant transcript entries (see that function's own doc comment).
 */
export type SpokenSummaryEvent =
  | { role: 'user'; text: string; clientTurnId: string }
  | { role: 'model'; text: string };

export interface UseVoiceDispatcherResult {
  /** Pass directly as `VoiceSessionOptions.onFunctionCall` when constructing the session. Stable
   *  identity across renders (an internal ref-forwarding wrapper) — safe to depend on in a
   *  `useMemo([], ...)` that builds the `VoiceSession` once. */
  onFunctionCall: (call: PendingFunctionCall) => void;
  /** Pass directly as `VoiceSessionOptions.getRecap`. Stable identity, same as above. */
  getRecap: () => string;
  /** Pass directly as `VoiceSessionOptions.onCaption` (composed with the caller's own UI caption
   *  handler, if any — this hook only needs the `'user'` deltas, for `prompt_agent`'s spoken
   *  displayText). Stable identity, same as above. */
  onCaption: (text: string, speaker: 'assistant' | 'user', final?: boolean) => void;
  /** Hand the hook the constructed `VoiceSession` right after building it (and again if the
   *  caller ever tears down and rebuilds one, e.g. on `disconnect()`+reconnect at a NEW instance —
   *  not needed for `voiceSession.ts`'s own internal rotation, which keeps the same instance). */
  registerSession: (session: VoiceSession | null) => void;
}

/** Present-tense label for narration text ("the console agent", or a spawned agent's own name if
 *  the roster already has it by the time its completion lands). */
function labelForAgent(agents: AgentDTO[], agentId: string, fallback: string): string {
  return agents.find((a) => a.id === agentId)?.name ?? fallback;
}

// =============================================================================
// Framework-free dispatch core (MAJOR-1 / MAJOR-2 / MINOR-9) — factored out of the hook body so its
// async bootstrap-lock timing and echo-triggered lock release are directly testable with plain
// `{current}` ref cells and fake deps, without a React render (this package has no DOM/hook-render
// test harness — see `useVoiceDispatcher.test.ts`'s own doc comment). `useVoiceDispatcher` below
// wires real `useRef`s and live `useTaskContext()` values into these on every call; a real
// `useRef({...}).current` object and a plain test double are interchangeable here since both are
// just mutable `{current: T}` cells.
// =============================================================================

/** Mutable-cell shape for every ref these functions touch.
 *
 *  LOW batch: `watchersRef` maps an agent id to a LIST of watchers, not a single one — the
 *  single-flight lock (`promptInFlightRef`) releases at the ECHO (MAJOR-2), not at completion, so a
 *  second `prompt_agent` dispatch to the SAME agent is reachable (and legitimate — the operator
 *  steering mid-turn) before the first dispatch's own completion has narrated. A single-watcher Map
 *  keyed by agentId would have the second dispatch's watcher silently overwrite the first's,
 *  dropping its completion narration on the floor. */
export interface DispatcherRefs {
  boundAgentIdRef: { current: string | undefined };
  hasEverBoundRef: { current: boolean };
  justMintedAtRef: { current: number | undefined };
  pendingFreshAgentNoticeRef: { current: boolean };
  promptInFlightRef: { current: boolean };
  watchersRef: { current: Map<string, CompletionWatcher[]> };
  echoTimersRef: { current: Map<string, ReturnType<typeof setTimeout>> };
  userCaptionBufferRef: { current: string };
}

export interface DispatchPromptAgentDeps {
  sessionId: string;
  selectedModel: string;
  agents: AgentDTO[];
  features: FeatureDTO[];
  audit: AuditEntry[];
  currentProject: Project | null;
  /** What the operator is currently LOOKING AT (the live page-context store, read at speak-time).
   *  Grounds an ambiguous spoken referent — "make the title of the plan short" needs to carry
   *  "you're viewing plan X" or the fleet agent can't resolve it. Same value the typed path passes
   *  (AssistantChat), just wired to the voice dispatcher too. */
  pageContext: PageContext | null;
  transcripts: Map<string, TranscriptEntry[]>;
  sendConsoleCommand: (command: ClientCommand) => void;
  subscribeConsole: (agentId: string) => void;
  onAgentBound?: (agentId: string) => void;
  onSpokenSummary?: (event: SpokenSummaryEvent) => void;
  /** Injectable for tests — default to the real implementations imported above. */
  ensureConsoleAgentFn?: typeof ensureConsoleAgent;
  buildPromptCommandFn?: typeof buildPromptCommand;
  setTimerFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/**
 * `prompt_agent`'s full dispatch: bootstrap mint (if no agent is bound yet), arm the echo
 * single-flight watcher, and send the command + ack.
 *
 * MAJOR-1: `refs.promptInFlightRef.current` is claimed TRUE as the very FIRST statement, before the
 * bootstrap mint's `await`. `onFunctionCall` calls this function via `void dispatchPromptAgent(...)`
 * from fully synchronous code, so a second concurrent bootstrap `prompt_agent` call (no agent bound
 * yet, so `decideToolCall`'s `hasBoundAgent` gate doesn't apply to either call) is processed by
 * `onFunctionCall` strictly after this function's synchronous prelude has already run and returned
 * control at its first `await` — it observes the lock already held and is blocked by
 * `decideToolCall`'s `promptInFlight` gate, instead of racing a second mint+dispatch against this
 * one. Reset in the mint-failure catch: a failed bootstrap never actually dispatched anything and
 * must not wedge every future `prompt_agent` call blocked forever.
 */
export async function dispatchPromptAgent(
  session: Pick<VoiceSession, 'sendFunctionOutput' | 'queueInjection'>,
  callId: string,
  message: string,
  refs: DispatcherRefs,
  deps: DispatchPromptAgentDeps,
): Promise<void> {
  const ensureConsoleAgentFn = deps.ensureConsoleAgentFn ?? ensureConsoleAgent;
  const buildPromptCommandFn = deps.buildPromptCommandFn ?? buildPromptCommand;
  const setTimerFn = deps.setTimerFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  const isBootstrap = !refs.boundAgentIdRef.current;
  let targetId = refs.boundAgentIdRef.current;

  // MAJOR-1: claim the single-flight lock before any await — see the doc comment above.
  refs.promptInFlightRef.current = true;

  if (isBootstrap) {
    try {
      targetId = await ensureConsoleAgentFn(
        { apiJson, subscribeConsole: deps.subscribeConsole, roster: deps.agents, currentProject: deps.currentProject, selectedModel: deps.selectedModel },
        deps.sessionId,
      );
    } catch (err) {
      refs.promptInFlightRef.current = false; // MAJOR-1: never dispatched — don't wedge the lock open
      // Live finding 2026-07-15: the daemon's create error names the ACTUAL problem ("the working
      // directory does not exist — ~/sui/omp-graph") — swallowing it into a generic "could not
      // start" left the operator with no idea anything was wrong for an entire afternoon. Carry
      // the reason through (fenced/truncated: it can echo daemon paths, never instructions).
      const reason = err instanceof Error && err.message ? ` — ${err.message.replace(/[\r\n\t]+/g, ' ').slice(0, 200)}` : '';
      session.sendFunctionOutput(callId, failedOutput(`could not start a console agent${reason}`));
      return;
    }
    refs.boundAgentIdRef.current = targetId;
    refs.hasEverBoundRef.current = true;
    refs.justMintedAtRef.current = Date.now();
    deps.onAgentBound?.(targetId);
  }
  // targetId is guaranteed defined past this point (either it was already bound and live —
  // decideToolCall's dead-agent gate already ruled out bound-but-dead before this ran — or the
  // bootstrap mint above just set it).
  const agentId = targetId as string;

  const spokenText = refs.userCaptionBufferRef.current.trim();
  refs.userCaptionBufferRef.current = '';
  const clientTurnId = `voice:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const cursor = deps.transcripts.get(agentId)?.length ?? 0;

  // LOW batch: PUSH onto this agent's watcher list, never overwrite — a second prompt_agent
  // dispatch to the same agent (reachable once the first's promptInFlight lock releases at its
  // echo, well before its completion) must not silently drop the first dispatch's own
  // still-pending completion watcher.
  {
    const list = refs.watchersRef.current.get(agentId) ?? [];
    list.push({ kind: 'prompt', clientTurnId, echoed: false, cursor, label: labelForAgent(deps.agents, agentId, 'the agent') });
    refs.watchersRef.current.set(agentId, list);
  }
  const echoTimer = setTimerFn(() => {
    refs.echoTimersRef.current.delete(clientTurnId);
    const list = refs.watchersRef.current.get(agentId);
    const idx = list?.findIndex((w) => w.kind === 'prompt' && !w.echoed && w.clientTurnId === clientTurnId) ?? -1;
    if (!list || idx === -1) return; // already echoed/superseded
    list.splice(idx, 1);
    if (list.length === 0) refs.watchersRef.current.delete(agentId);
    else refs.watchersRef.current.set(agentId, list);
    refs.promptInFlightRef.current = false;
    session.queueInjection(buildDeliveryFailureInjectionItems(labelForAgent(deps.agents, agentId, 'the agent')));
  }, ECHO_TIMEOUT_MS);
  refs.echoTimersRef.current.set(clientTurnId, echoTimer);

  const command = buildPromptCommandFn(
    { agentId, agents: deps.agents, features: deps.features, audit: deps.audit, selectedTask: undefined, pageContext: deps.pageContext },
    message,
    { clientTurnId, source: 'voice', displayText: spokenText || message },
  );
  deps.sendConsoleCommand(command);
  // MAJOR-2(a): role:'user', stamped with the SAME clientTurnId just sent in `command` — the caller
  // persists this as a durable user Message that `partitionSessionMessages`' existing clientTurnId
  // dedupe covers once the transcript echoes it back, so it renders as the operator's own turn (not
  // a model bubble) and never double-renders.
  deps.onSpokenSummary?.({ role: 'user', text: spokenText || message, clientTurnId });

  if (refs.pendingFreshAgentNoticeRef.current) {
    refs.pendingFreshAgentNoticeRef.current = false;
    // MINOR-7: a dedicated fresh-agent/no-memory notice, not buildCompletionInjectionItems (whose
    // template says "finished" — actively wrong for a just-started replacement agent).
    session.queueInjection(buildFreshAgentNoticeItems(labelForAgent(deps.agents, agentId, 'the agent')));
  }

  session.sendFunctionOutput(callId, dispatchedOutput(isBootstrap ? 'started a new console agent and sent it your message' : 'dispatched — telling the agent now'));
}

export interface DispatchSpawnAgentRefs {
  spawnInFlightRef: { current: boolean };
  watchersRef: { current: Map<string, CompletionWatcher[]> };
}

export interface DispatchSpawnAgentDeps {
  transcripts: Map<string, TranscriptEntry[]>;
  /** Concern 04's durable-voice-spawns dep — see `UseVoiceDispatcherOptions.onAgentSpawned`'s doc
   *  comment for why `prompt` rides along here despite the concern doc's `{id, name}` shorthand. */
  onAgentSpawned?: (agent: { id: string; name: string; prompt: string }) => void;
  /** Injectable for tests — defaults to the real `apiJson` imported above. */
  apiJsonFn?: typeof apiJson;
}

/**
 * `spawn_agent`'s full dispatch — factored out the same way `dispatchPromptAgent` is (framework-
 * free, directly testable without a React render).
 *
 * LOW batch: a 2xx `/api/spawn` response with a missing/malformed `agent` field must not `.id`
 * deref past the `catch` with no `sendFunctionOutput` ever sent — that would wedge the session in
 * `toolPending` forever (nothing else acks this call, and the reducer never leaves `toolPending`
 * without an ack — see `nextVoiceState`'s `toolPending` cell). Guarded the same way
 * `ensureConsoleAgent` guards a missing `agentId` (sendCore.ts): throw inside the `try`, let the
 * existing `catch` produce the honest `failedOutput` instead of adding a second ack path to keep in
 * sync with the first.
 */
export async function dispatchSpawnAgent(
  session: Pick<VoiceSession, 'sendFunctionOutput'>,
  callId: string,
  prompt: string,
  refs: DispatchSpawnAgentRefs,
  deps: DispatchSpawnAgentDeps,
): Promise<void> {
  const apiJsonFn = deps.apiJsonFn ?? apiJson;
  refs.spawnInFlightRef.current = true;
  let agent: AgentDTO;
  try {
    // MEDIUM-5: audit source tagging — tell the daemon this spawn came from the voice lane.
    const result = await apiJsonFn<{ agent: AgentDTO }>('/api/spawn', jsonInit('POST', { prompt, source: 'voice' }));
    if (!result?.agent?.id) throw new Error('/api/spawn returned no agent');
    agent = result.agent;
  } catch {
    session.sendFunctionOutput(callId, failedOutput('could not spawn a new agent'));
    return;
  } finally {
    refs.spawnInFlightRef.current = false;
  }
  // Concern 04: the caller persists this as a durable SpawnedUnitRecord — see the dep's doc comment
  // for why `prompt` (this function's own argument, already in scope) rides along.
  deps.onAgentSpawned?.({ id: agent.id, name: agent.name, prompt });
  const cursor = deps.transcripts.get(agent.id)?.length ?? 0;
  // LOW batch: push, don't overwrite — a spawned agent's own id is fresh per spawn, so this can
  // only collide with a prior watcher if a PRIOR spawn's watcher (same id — never happens, ids are
  // unique per spawn) is still pending, but keeping this consistent with the list-based
  // dispatchPromptAgent path costs nothing and rules out any future regression here.
  const list = refs.watchersRef.current.get(agent.id) ?? [];
  list.push({ kind: 'spawn', echoed: true, cursor, label: agent.name });
  refs.watchersRef.current.set(agent.id, list);
  session.sendFunctionOutput(callId, dispatchedOutput(`spawned ${agent.name} — tracking it, I'll let you know when it finishes`));
}

export interface SweepWatchersDeps {
  transcripts: Map<string, TranscriptEntry[]>;
  agents: AgentDTO[];
  onSpokenSummary?: (event: SpokenSummaryEvent) => void;
  /** Concern 04: fired with a completion's own `ts` once its narration was actually SPOKEN
   *  (`{cancelled: false}`) — see `UseVoiceDispatcherOptions.onCompletionNarrated`'s doc comment. */
  onCompletionNarrated?: (entryTs: number) => void;
  /** The cancelled branch's twin — see `UseVoiceDispatcherOptions.onNarrationLost`. */
  onNarrationLost?: (entryTs: number) => void;
  clearTimerFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * The completion-watcher sweep: drains every per-agent `CompletionWatcher` against the current
 * transcript snapshot — flips an un-echoed prompt watcher to echoed once the durable echo lands,
 * then (whether just-echoed, already-echoed, or a no-echo-needed spawn) narrates once a finished
 * assistant turn shows up at/after the watcher's cursor.
 *
 * MAJOR-2: `promptInFlightRef` is cleared the MOMENT the echo lands, not at completion (which can be
 * minutes later for a long-running turn). The single-flight guard's job is only to prevent a SECOND
 * `prompt_agent` racing the FIRST one's delivery confirmation — once the transcript confirms this
 * one landed, a second dispatch is safe, and holding the lock through the whole turn just blocks the
 * operator from steering mid-turn for no reason. Completion narration is unaffected: it still only
 * fires once `findCompletionEntry` finds a finished turn, same as before this fix.
 */
/**
 * LOW batch: iterates each agent's WATCHER LIST (not a single watcher) — the single-flight lock
 * releases at the echo (MAJOR-2), so a second `prompt_agent` dispatch to the same agent can be in
 * flight, with its own independent watcher, before the first's completion has narrated.
 *
 * FIFO ordering (a completion entry can only ever belong to ONE watcher): `TranscriptEntry` has no
 * per-turn id on the ASSISTANT side (only user-kind entries carry `clientTurnId`), so two sibling
 * watchers for the same agent can't tell "which finished-assistant entry is mine" apart by content
 * alone — only by ORDER (earlier-dispatched turn's completion comes first in the transcript).
 * `floor` tracks the highest transcript index already claimed by an earlier watcher in this SAME
 * pass; it's re-derived fresh each sweep call, but its effect is baked into `cursor` for any watcher
 * that keeps waiting (`remaining.push`) so a later sweep — after the watcher that established the
 * floor has already completed and been removed — doesn't let a still-pending sibling re-claim an
 * entry that's already been narrated.
 */
export function sweepPromptWatchers(session: Pick<VoiceSession, 'queueInjection'>, refs: DispatcherRefs, deps: SweepWatchersDeps): void {
  const clearTimerFn = deps.clearTimerFn ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  for (const [agentId, watchers] of [...refs.watchersRef.current.entries()]) {
    const entries = deps.transcripts.get(agentId) ?? [];
    const remaining: CompletionWatcher[] = [];
    let floor = -1; // highest transcript index already claimed by an earlier sibling watcher this pass

    for (const watcher of watchers) {
      let current = watcher;

      if (current.kind === 'prompt' && !current.echoed) {
        const echo = findEchoEntry(entries, current.clientTurnId);
        if (!echo) {
          remaining.push(current); // still waiting on delivery confirmation (or the echo timeout will fire)
          continue;
        }
        const echoIndex = entries.indexOf(echo);
        const timer = refs.echoTimersRef.current.get(current.clientTurnId);
        if (timer) {
          clearTimerFn(timer);
          refs.echoTimersRef.current.delete(current.clientTurnId);
        }
        // MAJOR-2: release the single-flight lock right here — see the function doc comment.
        refs.promptInFlightRef.current = false;
        // Fall through to the completion check below in this SAME pass (not `continue`) — a short
        // response can complete in the very same transcript broadcast as its echo, and `transcripts`
        // might not change again for a while if we deferred that check to the next sweep, silently
        // missing the narration.
        current = { kind: 'prompt', clientTurnId: current.clientTurnId, echoed: true, cursor: echoIndex + 1, label: current.label };
      }

      // Echoed prompt, or a spawn (which needs no echo — the /api/spawn 200 already confirmed it):
      // watch for the next finished assistant turn, never earlier than a sibling watcher's own
      // already-claimed completion (see the function doc comment).
      const searchFrom = Math.max(current.cursor, floor + 1);
      const completion = findCompletionEntry(entries, searchFrom);
      if (!completion) {
        remaining.push({ ...current, cursor: searchFrom }); // bump persists the floor across sweeps
        continue;
      }
      floor = entries.indexOf(completion);
      const label = labelForAgent(deps.agents, agentId, current.label);
      const completionTs = completion.ts;
      // Concern 04: the debrief lane's OTHER cursor-advance path — a completion narrated LIVE
      // counts as "heard" exactly like one spoken from the away-summary, so onCompletionNarrated
      // only fires once THIS narration's own response actually completed uncancelled (a barge-in
      // mid-narration must not advance the cursor past something the operator never actually heard).
      session.queueInjection(buildCompletionInjectionItems(label, completion.text, completionOutcome(completion.status)), ({ cancelled }) => {
        if (!cancelled) deps.onCompletionNarrated?.(completionTs);
        else deps.onNarrationLost?.(completionTs);
      });
      // MAJOR-2(a): role:'model', no clientTurnId — this isn't a dispatched turn of its own. Its
      // double-render risk is fixed on the OTHER side, by extending partitionSessionMessages
      // (AssistantChat.tsx) to dedupe a role:'model' durable Message against a matching finished
      // assistant transcript entry by exact text, consumed once.
      deps.onSpokenSummary?.({ role: 'model', text: completion.text });
      // This watcher is done — dropped, not pushed to `remaining`.
    }

    if (remaining.length === 0) refs.watchersRef.current.delete(agentId);
    else refs.watchersRef.current.set(agentId, remaining);
  }
}

export interface TimerCleanupRefs {
  interruptTimerRef: { current: ReturnType<typeof setTimeout> | null };
  echoTimersRef: { current: Map<string, ReturnType<typeof setTimeout>> };
}

/** MINOR-9: clears every pending echo timer plus the interrupt debounce timer. Called from the
 *  hook's unmount cleanup effect so tearing the component down mid-dispatch doesn't leave timers
 *  firing (and invoking stale closures over an unmounted session/refs) after the hook itself is
 *  gone. Framework-free and exported so the clearing behavior is directly testable without
 *  mounting/unmounting a real component. */
export function clearAllPendingTimers(refs: TimerCleanupRefs, clearTimerFn: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout): void {
  if (refs.interruptTimerRef.current) {
    clearTimerFn(refs.interruptTimerRef.current);
    refs.interruptTimerRef.current = null;
  }
  for (const timer of refs.echoTimersRef.current.values()) clearTimerFn(timer);
  refs.echoTimersRef.current.clear();
}

export function useVoiceDispatcher(opts: UseVoiceDispatcherOptions): UseVoiceDispatcherResult {
  const { sessionId, agentId: pinnedAgentId, selectedModel = '', onAgentBound, onSpokenSummary, onAgentSpawned, onCompletionNarrated, onNarrationLost } = opts;
  const { agents, features, audit, transcripts, currentProject, sendConsoleCommand, subscribeConsole } = useTaskContext();
  // The live page-context store (single shared store under the root PageContextProvider, published
  // by whichever view is mounted). Read here so a spoken prompt grounds to what the operator is
  // looking at AT SPEAK-TIME — `handleFunctionCallRef.current` is rebuilt every render, so the
  // value the tool call closes over is always current, not captured at call-start.
  const pageContext = usePageContext();

  const sessionRef = useRef<VoiceSession | null>(null);

  // ---------------------------------------------------------------------------
  // Binding (DESIGN.md "Session binding" row)
  // ---------------------------------------------------------------------------
  const boundAgentIdRef = useRef<string | undefined>(pinnedAgentId);
  const hasEverBoundRef = useRef<boolean>(!!pinnedAgentId);
  const justMintedAtRef = useRef<number | undefined>(undefined);
  /** Set when a bound agent was found dead and cleared (not a first-ever mint) — the next
   *  successful mint owes the model a "this is a fresh agent, no memory" notice. */
  const pendingFreshAgentNoticeRef = useRef(false);

  // Adopt the caller's prop when it moves to a NEW id this hook doesn't already know about
  // (session/project switch mid-call, or the caller catching up after `onAgentBound`). Never
  // clobbers an internal rebind this hook just made with a stale prop the caller hasn't
  // re-rendered with yet — since `onAgentBound` fires synchronously with the internal update,
  // the two converge on the caller's very next render regardless.
  useEffect(() => {
    if (pinnedAgentId && pinnedAgentId !== boundAgentIdRef.current) {
      boundAgentIdRef.current = pinnedAgentId;
      hasEverBoundRef.current = true;
    }
  }, [pinnedAgentId]);

  // ---------------------------------------------------------------------------
  // Single-flight + debounce guards (mutable, not React state — nothing here should re-render)
  // ---------------------------------------------------------------------------
  const promptInFlightRef = useRef(false);
  const spawnInFlightRef = useRef(false);
  const interruptPendingRef = useRef(false);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const echoTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** Per-target completion watchers — the bound console agent AND any spawned agent each get an
   *  independent entry, so a spawn's completion narrates on its own timeline from the console
   *  agent's (concern text: "if multiple prompts are in flight, narrate per-completion"). */
  const watchersRef = useRef<Map<string, CompletionWatcher[]>>(new Map());
  /** Accumulates the live `'user'`-speaker caption text since the last prompt_agent dispatch
   *  consumed it — see the module doc comment: whisper's transcript arrives asynchronously, so
   *  this may still be empty at dispatch time (falls back to the model's `message` paraphrase). */
  const userCaptionBufferRef = useRef('');

  // Bundles the refs above for the framework-free dispatch core (MAJOR-1/MAJOR-2/MINOR-9) — a
  // fresh wrapper object each render, pointing at the SAME stable `useRef` cells, so it's cheap to
  // rebuild and never goes stale.
  const refs: DispatcherRefs = {
    boundAgentIdRef,
    hasEverBoundRef,
    justMintedAtRef,
    pendingFreshAgentNoticeRef,
    promptInFlightRef,
    watchersRef,
    echoTimersRef,
    userCaptionBufferRef,
  };

  // Clear a pending interrupt debounce as soon as the bound agent is no longer interruptible —
  // mirrors AssistantChat.tsx's own effect that resets `stopPending` once `!isStopShown`, rather
  // than always waiting out the full 8s window.
  useEffect(() => {
    const boundId = boundAgentIdRef.current;
    if (!boundId) return;
    const stillInterruptible = interruptibleAgents(agents).some((a) => a.id === boundId);
    if (!stillInterruptible && interruptPendingRef.current) {
      interruptPendingRef.current = false;
      if (interruptTimerRef.current) {
        clearTimeout(interruptTimerRef.current);
        interruptTimerRef.current = null;
      }
    }
  }, [agents]);

  // ---------------------------------------------------------------------------
  // Completion-watcher sweep — runs whenever ANY transcript changes; each watcher only looks at
  // its own target agent's entries. Delegates to `sweepPromptWatchers` (MAJOR-2: releases the
  // prompt single-flight lock at the echo, not at completion).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    sweepPromptWatchers(session, refs, { transcripts, agents, onSpokenSummary, onCompletionNarrated, onNarrationLost });
  }, [transcripts, agents]);

  // MINOR-9: clear every pending echo timer + the interrupt debounce timer on unmount — a component
  // teardown mid-dispatch must not leave timers firing (and invoking stale closures) afterward.
  useEffect(() => {
    return () => clearAllPendingTimers({ interruptTimerRef, echoTimersRef });
  }, []);

  // ---------------------------------------------------------------------------
  // fleet_status
  // ---------------------------------------------------------------------------
  function executeFleetStatus(session: VoiceSession, callId: string): void {
    session.sendFunctionOutput(callId, formatFleetStatus(agents));
  }

  // ---------------------------------------------------------------------------
  // prompt_agent — delegates to `dispatchPromptAgent` (MAJOR-1: single-flight lock claimed before
  // any await; MINOR-7: dedicated fresh-agent notice).
  // ---------------------------------------------------------------------------
  async function executePromptAgent(session: VoiceSession, callId: string, message: string): Promise<void> {
    await dispatchPromptAgent(session, callId, message, refs, {
      sessionId,
      selectedModel,
      agents,
      features,
      audit,
      currentProject,
      pageContext,
      transcripts,
      sendConsoleCommand,
      subscribeConsole,
      onAgentBound,
      onSpokenSummary,
    });
  }

  // ---------------------------------------------------------------------------
  // spawn_agent — delegates to `dispatchSpawnAgent` (LOW batch: validates the /api/spawn response
  // before dereferencing `agent.id`, so a malformed 2xx can't wedge the session in toolPending).
  // ---------------------------------------------------------------------------
  async function executeSpawnAgent(session: VoiceSession, callId: string, prompt: string): Promise<void> {
    await dispatchSpawnAgent(session, callId, prompt, { spawnInFlightRef, watchersRef }, { transcripts, onAgentSpawned });
  }

  // ---------------------------------------------------------------------------
  // interrupt
  // ---------------------------------------------------------------------------
  function executeInterrupt(session: VoiceSession, callId: string): void {
    const agentId = boundAgentIdRef.current;
    if (!agentId) {
      // decideToolCall already gates this (hasBoundAgent false -> failed before 'execute'); kept
      // as a defensive no-op rather than sending to an empty id if ever reached some other way.
      session.sendFunctionOutput(callId, failedOutput('no agent to interrupt'));
      return;
    }
    sendConsoleCommand(interruptCommand(agentId, 'voice')); // MEDIUM-5: audit source tagging
    interruptPendingRef.current = true;
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    interruptTimerRef.current = setTimeout(() => {
      interruptPendingRef.current = false;
      interruptTimerRef.current = null;
    }, INTERRUPT_DEBOUNCE_MS);
    session.sendFunctionOutput(callId, dispatchedOutput('sent the stop signal'));
  }

  // ---------------------------------------------------------------------------
  // Public, stable callbacks (ref-forwarding pattern: identity never changes across renders, so
  // whatever `createVoiceSession(mintFn, { onFunctionCall, getRecap, onCaption })` call the caller
  // memoizes with `useMemo(..., [])` keeps seeing live data through these wrappers)
  // ---------------------------------------------------------------------------
  const handleFunctionCallRef = useRef<((call: PendingFunctionCall) => void) | undefined>(undefined);
  handleFunctionCallRef.current = (call: PendingFunctionCall) => {
    const session = sessionRef.current;
    if (!session) return; // nothing sane to answer through
    const boundAgentId = boundAgentIdRef.current;
    const hasBoundAgent = !!boundAgentId;
    // MINOR-6: an EMPTY roster (a transient WS reconnect flap) is never read as "the agent is
    // gone" — only a non-empty roster that genuinely lacks the bound id is real evidence of death.
    // Previously this destroyed the binding on ANY tool call (including fleet_status, which doesn't
    // even need a bound agent) the instant a roster broadcast happened to be empty.
    const withinMintGrace = justMintedAtRef.current !== undefined && Date.now() - justMintedAtRef.current < MINT_GRACE_MS;
    const agentLive = hasBoundAgent && isBoundAgentLive(agents, boundAgentId as string, withinMintGrace);

    if (hasBoundAgent && !agentLive) {
      // The bound agent just went dead (this check, not decideToolCall's read of it, is the
      // single source of truth for detecting the transition) — clear the binding so the NEXT
      // user-confirmed prompt_agent call goes through the bootstrap-mint path automatically
      // (rather than failing forever), and remember to tell the model the replacement has no
      // memory once that mint lands.
      boundAgentIdRef.current = undefined;
      pendingFreshAgentNoticeRef.current = true;
    }

    const state: DispatcherDecisionState = {
      hasBoundAgent,
      agentLive,
      promptInFlight: promptInFlightRef.current,
      spawnInFlight: spawnInFlightRef.current,
      interruptPending: interruptPendingRef.current,
    };
    const decision = decideToolCall(call, state);
    if (decision.kind === 'output') {
      session.sendFunctionOutput(call.callId, decision.output);
      return;
    }
    switch (decision.args.tool) {
      case 'fleet_status':
        executeFleetStatus(session, call.callId);
        return;
      case 'prompt_agent':
        void executePromptAgent(session, call.callId, decision.args.message);
        return;
      case 'spawn_agent':
        void executeSpawnAgent(session, call.callId, decision.args.prompt);
        return;
      case 'interrupt':
        executeInterrupt(session, call.callId);
        return;
    }
  };
  const onFunctionCall = useRef((call: PendingFunctionCall) => handleFunctionCallRef.current?.(call)).current;

  const getRecapRef = useRef<(() => string) | undefined>(undefined);
  getRecapRef.current = () => {
    const boundId = boundAgentIdRef.current;
    if (!boundId) return '';
    return buildVoiceRecap(transcripts.get(boundId) ?? []);
  };
  const getRecap = useRef(() => getRecapRef.current?.() ?? '').current;

  const onCaptionRef = useRef<((text: string, speaker: 'assistant' | 'user', final?: boolean) => void) | undefined>(undefined);
  onCaptionRef.current = (text, speaker, final) => {
    // Only the 'user' side feeds prompt_agent's spoken displayText (see the module doc comment —
    // live since the mint pins whisper-1 input transcription; arrival timing is asynchronous).
    // A FINAL user caption is one complete whisper utterance — REPLACE the buffer rather than
    // append (live finding 2026-07-15: appending concatenated every utterance since the last
    // dispatch, so a turn-1 "Hello." rode into turn-2's dispatched displayText as
    // "Hello.Can you tell me about…"). Streaming deltas (non-final) still accumulate.
    if (speaker === 'user') userCaptionBufferRef.current = final ? text : userCaptionBufferRef.current + text;
  };
  const onCaption = useRef((text: string, speaker: 'assistant' | 'user', final?: boolean) => onCaptionRef.current?.(text, speaker, final)).current;

  const registerSession = useCallback((session: VoiceSession | null) => {
    sessionRef.current = session;
  }, []);

  return { onFunctionCall, getRecap, onCaption, registerSession };
}
