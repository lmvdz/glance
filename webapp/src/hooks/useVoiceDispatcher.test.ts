/**
 * `useVoiceDispatcher` regression tests (blind-review findings MAJOR-1 / MAJOR-2 / MINOR-9).
 *
 * This package has no DOM/hook-render test harness (no `happy-dom`/jsdom, no
 * `@testing-library/react` — every other `.test.tsx` in this repo only reaches for
 * `renderToStaticMarkup`, which never runs effects or re-renders). The bugs these tests pin are
 * genuinely about async/imperative ORDERING inside the hook (when a ref flips true relative to an
 * `await`; when a watcher-sweep effect clears a lock relative to completion), which can't be
 * expressed as a pure decision table the way `lib/voice/tools.ts`'s `decideToolCall` is tested.
 *
 * So `useVoiceDispatcher.ts` factors the two buggy code paths out as plain, exported,
 * framework-free functions (`dispatchPromptAgent`, `sweepPromptWatchers`, `clearAllPendingTimers`)
 * that take `{current}` ref cells and plain dep objects instead of closing over `useRef`/
 * `useContext` — a real `useRef(...).current` object and a plain test double are interchangeable,
 * so these tests exercise the EXACT same code the hook calls, without a React render.
 */
import { describe, expect, test } from 'bun:test';
import { clearAllPendingTimers, dispatchPromptAgent, sweepPromptWatchers, type DispatcherRefs, type DispatchPromptAgentDeps, type SweepWatchersDeps, type TimerCleanupRefs } from './useVoiceDispatcher';
import { ALREADY_DISPATCHED_DETAIL, decideToolCall, type DispatcherDecisionState } from '../lib/voice/tools';
import type { VoiceSession, PendingFunctionCall } from '../lib/voice/voiceSession';
import type { TranscriptEntry } from '../lib/dto';

// =============================================================================
// Fakes
// =============================================================================

function makeRefs(overrides: Partial<DispatcherRefs> = {}): DispatcherRefs {
  return {
    boundAgentIdRef: { current: undefined },
    hasEverBoundRef: { current: false },
    justMintedAtRef: { current: undefined },
    pendingFreshAgentNoticeRef: { current: false },
    promptInFlightRef: { current: false },
    watchersRef: { current: new Map() },
    echoTimersRef: { current: new Map() },
    userCaptionBufferRef: { current: '' },
    ...overrides,
  };
}

function makeFakeSession() {
  const outputs: { callId: string; output: unknown }[] = [];
  const injections: unknown[][] = [];
  const session: Pick<VoiceSession, 'sendFunctionOutput' | 'queueInjection'> = {
    sendFunctionOutput: (callId: string, output: unknown) => {
      outputs.push({ callId, output });
    },
    queueInjection: (items: unknown[]) => {
      injections.push(items);
    },
  };
  return { session, outputs, injections };
}

function baseDeps(overrides: Partial<DispatchPromptAgentDeps> = {}): DispatchPromptAgentDeps {
  return {
    sessionId: 'session-1',
    selectedModel: '',
    agents: [],
    features: [],
    audit: [],
    currentProject: null,
    transcripts: new Map(),
    sendConsoleCommand: () => {},
    subscribeConsole: () => {},
    buildPromptCommandFn: (() => ({ type: 'prompt', id: 'x', message: 'x', displayText: 'x' })) as unknown as DispatchPromptAgentDeps['buildPromptCommandFn'],
    setTimerFn: () => 0 as unknown as ReturnType<typeof setTimeout>,
    ...overrides,
  };
}

function promptAgentCall(callId: string, message: string): PendingFunctionCall {
  return { callId, name: 'prompt_agent', arguments: JSON.stringify({ message }), trigger: 'user' };
}

function decisionState(refs: DispatcherRefs, extra: Partial<DispatcherDecisionState> = {}): DispatcherDecisionState {
  return {
    hasBoundAgent: !!refs.boundAgentIdRef.current,
    agentLive: true,
    promptInFlight: refs.promptInFlightRef.current,
    spawnInFlight: false,
    interruptPending: false,
    ...extra,
  };
}

// =============================================================================
// MAJOR-1: bootstrap double-dispatch
// =============================================================================

describe('MAJOR-1: bootstrap prompt_agent single-flight', () => {
  test('two concurrent bootstrap prompt_agent calls -> exactly one dispatch, the second is blocked "already dispatched"', async () => {
    const refs = makeRefs();
    const { session, outputs } = makeFakeSession();

    let ensureCalls = 0;
    let resolveEnsure!: (id: string) => void;
    const ensureConsoleAgentFn = (() => {
      return new Promise<string>((resolve) => {
        ensureCalls++;
        resolveEnsure = resolve;
      });
    }) as unknown as DispatchPromptAgentDeps['ensureConsoleAgentFn'];
    const deps = baseDeps({ ensureConsoleAgentFn });

    // Call 1 arrives: no agent bound yet, nothing in flight -> decideToolCall executes.
    const call1 = promptAgentCall('call-1', 'do the first thing');
    const decision1 = decideToolCall(call1, decisionState(refs));
    expect(decision1.kind).toBe('execute');
    const dispatch1 = dispatchPromptAgent(session, call1.callId, 'do the first thing', refs, deps);

    // Call 2 arrives SYNCHRONOUSLY, before dispatch1's bootstrap mint has resolved (or even had a
    // chance to run a microtask). Pre-fix, promptInFlightRef was only set true AFTER the mint's
    // await, so this second decideToolCall call would ALSO see hasBoundAgent:false,
    // promptInFlight:false and execute a second time.
    const call2 = promptAgentCall('call-2', 'do a second thing');
    const decision2 = decideToolCall(call2, decisionState(refs));
    expect(decision2).toEqual({ kind: 'output', output: { status: 'blocked', detail: ALREADY_DISPATCHED_DETAIL } });
    if (decision2.kind === 'output') session.sendFunctionOutput(call2.callId, decision2.output);

    // Only ONE mint was ever started — the second call never reached dispatchPromptAgent at all.
    expect(ensureCalls).toBe(1);

    resolveEnsure('agent-1');
    await dispatch1;

    expect(outputs).toContainEqual({ callId: 'call-1', output: { status: 'dispatched', detail: 'started a new console agent and sent it your message' } });
    expect(outputs).toContainEqual({ callId: 'call-2', output: { status: 'blocked', detail: ALREADY_DISPATCHED_DETAIL } });
    expect(refs.boundAgentIdRef.current).toBe('agent-1');
  });

  test('a mint failure resets the lock so the NEXT prompt_agent call is not wedged blocked forever', async () => {
    const refs = makeRefs();
    const { session, outputs } = makeFakeSession();
    const ensureConsoleAgentFn = (async () => {
      throw new Error('mint failed');
    }) as unknown as DispatchPromptAgentDeps['ensureConsoleAgentFn'];
    const deps = baseDeps({ ensureConsoleAgentFn });

    await dispatchPromptAgent(session, 'call-1', 'hi', refs, deps);

    expect(outputs).toEqual([{ callId: 'call-1', output: { status: 'failed', detail: 'could not start a console agent' } }]);
    expect(refs.promptInFlightRef.current).toBe(false); // MAJOR-1: reset in the mint-failure catch

    // A follow-up bootstrap call is allowed through decideToolCall, not blocked by a stuck lock.
    const call2 = promptAgentCall('call-2', 'try again');
    expect(decideToolCall(call2, decisionState(refs)).kind).toBe('execute');
  });
});

// =============================================================================
// MAJOR-2: the single-flight lock clears at the echo, not at completion
// =============================================================================

describe('MAJOR-2: promptInFlight releases at the echo, before completion', () => {
  test('a second prompt_agent is blocked before the echo lands, and allowed the moment it does — well before completion', () => {
    const refs = makeRefs({
      boundAgentIdRef: { current: 'agent-1' },
      hasEverBoundRef: { current: true },
      promptInFlightRef: { current: true },
      watchersRef: { current: new Map([['agent-1', { kind: 'prompt', clientTurnId: 'turn-1', echoed: false, cursor: 0, label: 'the agent' }]]) },
    });
    const { session, injections } = makeFakeSession();
    const sweepDeps: SweepWatchersDeps = { transcripts: new Map(), agents: [] };

    // No echo yet — still locked, a second prompt_agent is blocked.
    sweepPromptWatchers(session, refs, sweepDeps);
    expect(refs.promptInFlightRef.current).toBe(true);
    expect(decideToolCall(promptAgentCall('call-2', 'again'), decisionState(refs)).kind).toBe('output');

    // The echo lands (a durable user-kind transcript entry with the dispatched clientTurnId) — the
    // agent's turn is still RUNNING (no finished assistant entry yet).
    const transcriptsAfterEcho = new Map<string, TranscriptEntry[]>([[
      'agent-1',
      [{ id: 'e1', kind: 'user', text: 'fix the bug', ts: 1, clientTurnId: 'turn-1' }],
    ]]);
    sweepPromptWatchers(session, refs, { ...sweepDeps, transcripts: transcriptsAfterEcho });

    // MAJOR-2: lock released right here, at the echo — minutes before the turn actually finishes.
    expect(refs.promptInFlightRef.current).toBe(false);
    expect(injections).toEqual([]); // no completion narration yet — the turn hasn't finished

    // decideToolCall now allows a second prompt_agent.
    expect(decideToolCall(promptAgentCall('call-2', 'again'), decisionState(refs)).kind).toBe('execute');

    // Completion narration still fires later, independently, once a finished assistant turn shows up.
    const transcriptsAfterCompletion = new Map<string, TranscriptEntry[]>([[
      'agent-1',
      [
        { id: 'e1', kind: 'user', text: 'fix the bug', ts: 1, clientTurnId: 'turn-1' },
        { id: 'e2', kind: 'assistant', text: 'fixed it', ts: 2, status: 'ok' },
      ],
    ]]);
    sweepPromptWatchers(session, refs, { ...sweepDeps, transcripts: transcriptsAfterCompletion });
    expect(injections).toHaveLength(1);
    const text = (injections[0]![0] as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain('finished');
    expect(refs.watchersRef.current.has('agent-1')).toBe(false); // watcher consumed
  });

  test('a short response completing in the SAME broadcast as its echo still narrates (no dropped completion)', () => {
    const refs = makeRefs({
      boundAgentIdRef: { current: 'agent-1' },
      promptInFlightRef: { current: true },
      watchersRef: { current: new Map([['agent-1', { kind: 'prompt', clientTurnId: 'turn-1', echoed: false, cursor: 0, label: 'the agent' }]]) },
    });
    const { session, injections } = makeFakeSession();
    const transcripts = new Map<string, TranscriptEntry[]>([[
      'agent-1',
      [
        { id: 'e1', kind: 'user', text: 'quick one', ts: 1, clientTurnId: 'turn-1' },
        { id: 'e2', kind: 'assistant', text: 'done', ts: 2, status: 'ok' },
      ],
    ]]);
    sweepPromptWatchers(session, refs, { transcripts, agents: [] });
    expect(refs.promptInFlightRef.current).toBe(false);
    expect(injections).toHaveLength(1);
  });
});

// =============================================================================
// MINOR-9: unmount cleanup clears all pending timers
// =============================================================================

describe('MINOR-9: clearAllPendingTimers', () => {
  test('clears every echo timer and the interrupt timer, then empties the map', () => {
    const cleared: unknown[] = [];
    const clearTimerFn = (handle: unknown) => cleared.push(handle);
    const refs: TimerCleanupRefs = {
      interruptTimerRef: { current: 'interrupt-handle' as unknown as ReturnType<typeof setTimeout> },
      echoTimersRef: { current: new Map([['turn-1', 'echo-1' as unknown as ReturnType<typeof setTimeout>], ['turn-2', 'echo-2' as unknown as ReturnType<typeof setTimeout>]]) },
    };

    clearAllPendingTimers(refs, clearTimerFn as (handle: ReturnType<typeof setTimeout>) => void);

    expect(cleared.sort()).toEqual(['echo-1', 'echo-2', 'interrupt-handle'].sort());
    expect(refs.interruptTimerRef.current).toBeNull();
    expect(refs.echoTimersRef.current.size).toBe(0);
  });

  test('a no-op when nothing is pending', () => {
    const cleared: unknown[] = [];
    const refs: TimerCleanupRefs = { interruptTimerRef: { current: null }, echoTimersRef: { current: new Map() } };
    expect(() => clearAllPendingTimers(refs, (h) => cleared.push(h))).not.toThrow();
    expect(cleared).toEqual([]);
  });
});
