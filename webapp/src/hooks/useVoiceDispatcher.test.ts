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
import {
  clearAllPendingTimers,
  dispatchPromptAgent,
  dispatchSpawnAgent,
  sweepPromptWatchers,
  type DispatcherRefs,
  type DispatchPromptAgentDeps,
  type DispatchSpawnAgentDeps,
  type DispatchSpawnAgentRefs,
  type SpokenSummaryEvent,
  type SweepWatchersDeps,
  type TimerCleanupRefs,
} from './useVoiceDispatcher';
import { ALREADY_DISPATCHED_DETAIL, decideToolCall, type DispatcherDecisionState } from '../lib/voice/tools';
import type { VoiceSession, PendingFunctionCall } from '../lib/voice/voiceSession';
import type { InjectionOnDone } from '../lib/voice/voiceSession';
import type { AgentDTO, TranscriptEntry } from '../lib/dto';

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
  // Concern 04: sweepPromptWatchers now passes an onDone alongside a completion narration's
  // queueInjection call (the debrief lane's live-narration cursor-advance path) — captured
  // per-batch so tests can invoke it directly to simulate the response actually completing (or
  // being barged into/cancelled).
  const onDones: (InjectionOnDone | undefined)[] = [];
  const session: Pick<VoiceSession, 'sendFunctionOutput' | 'queueInjection'> = {
    sendFunctionOutput: (callId: string, output: unknown) => {
      outputs.push({ callId, output });
    },
    queueInjection: (items: unknown[], onDone?: InjectionOnDone) => {
      injections.push(items);
      onDones.push(onDone);
    },
  };
  return { session, outputs, injections, onDones };
}

function baseDeps(overrides: Partial<DispatchPromptAgentDeps> = {}): DispatchPromptAgentDeps {
  return {
    sessionId: 'session-1',
    selectedModel: '',
    agents: [],
    features: [],
    audit: [],
    currentProject: null,
    pageContext: null,
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

  test('grounding: the live pageContext (what the operator is looking at) is threaded into buildPromptCommand so an ambiguous spoken referent resolves', async () => {
    const refs = makeRefs({ boundAgentIdRef: { current: 'agent-1' }, hasEverBoundRef: { current: true } });
    const { session } = makeFakeSession();
    let capturedPageContext: unknown = 'UNSET';
    const pageContext = { viewId: 'tasks', title: 'Plan: auth-refactor', entities: [], route: '/plans/auth-refactor' } as unknown as DispatchPromptAgentDeps['pageContext'];
    const deps = baseDeps({
      pageContext,
      buildPromptCommandFn: ((ctx: { pageContext: unknown }) => {
        capturedPageContext = ctx.pageContext;
        return { type: 'prompt', id: 'x', message: 'x', displayText: 'x' };
      }) as unknown as DispatchPromptAgentDeps['buildPromptCommandFn'],
    });

    // "make the title of the plan short" — the referent lives in the page the operator is viewing.
    await dispatchPromptAgent(session, 'call-1', 'make the title of the plan short', refs, deps);

    // The forwarded prompt carries the page the operator is looking at, not null — so the fleet
    // agent can resolve "the plan". (Regression against the shipped `pageContext: null`.)
    expect(capturedPageContext).toBe(pageContext);
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
      watchersRef: { current: new Map([['agent-1', [{ kind: 'prompt', clientTurnId: 'turn-1', echoed: false, cursor: 0, label: 'the agent' }]]]) },
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
      watchersRef: { current: new Map([['agent-1', [{ kind: 'prompt', clientTurnId: 'turn-1', echoed: false, cursor: 0, label: 'the agent' }]]]) },
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
// MAJOR-2(a): onSpokenSummary carries a role discriminator — the operator's own spoken prompt
// persists as role:'user' (with the dispatch's clientTurnId), the narrated completion as
// role:'model'. Fixes both a wrong-speaker bug (the prompt used to render as a model bubble) and a
// double-render (the completion had nothing to dedupe it against the real transcript entry).
// =============================================================================

describe('MAJOR-2(a): onSpokenSummary role discriminator', () => {
  test('dispatchPromptAgent reports the operator prompt as role:"user", stamped with the SAME clientTurnId sent in the dispatched command', async () => {
    const refs = makeRefs({ boundAgentIdRef: { current: 'agent-1' }, hasEverBoundRef: { current: true } });
    const { session } = makeFakeSession();
    const spokenSummaries: SpokenSummaryEvent[] = [];
    let capturedClientTurnId: string | undefined;
    const deps = baseDeps({
      onSpokenSummary: (event) => spokenSummaries.push(event),
      buildPromptCommandFn: ((_ctx: unknown, _message: string, opts: { clientTurnId: string }) => {
        capturedClientTurnId = opts.clientTurnId;
        return { type: 'prompt', id: 'x', message: 'x', displayText: 'x' };
      }) as unknown as DispatchPromptAgentDeps['buildPromptCommandFn'],
    });

    await dispatchPromptAgent(session, 'call-1', 'ship the fix', refs, deps);

    expect(capturedClientTurnId).toBeTruthy();
    expect(spokenSummaries).toEqual([{ role: 'user', text: 'ship the fix', clientTurnId: capturedClientTurnId }]);
  });

  test('sweepPromptWatchers reports a completion narration as role:"model" (no clientTurnId)', () => {
    const refs = makeRefs({
      boundAgentIdRef: { current: 'agent-1' },
      promptInFlightRef: { current: true },
      watchersRef: { current: new Map([['agent-1', [{ kind: 'prompt', clientTurnId: 'turn-1', echoed: true, cursor: 0, label: 'the agent' }]]]) },
    });
    const { session } = makeFakeSession();
    const spokenSummaries: SpokenSummaryEvent[] = [];
    const transcripts = new Map<string, TranscriptEntry[]>([[
      'agent-1',
      [{ id: 'e2', kind: 'assistant', text: 'fixed it', ts: 2, status: 'ok' }],
    ]]);

    sweepPromptWatchers(session, refs, { transcripts, agents: [], onSpokenSummary: (event) => spokenSummaries.push(event) });

    expect(spokenSummaries).toEqual([{ role: 'model', text: 'fixed it' }]);
  });
});

// =============================================================================
// Concern 04: sweepPromptWatchers' completion narration carries an onDone that fires
// onCompletionNarrated(entryTs) ONLY when the narration's own response completed uncancelled — the
// debrief lane's live-narration cursor-advance path (the other is VoiceCallContext's call-start
// debrief). A completion narrated then immediately barged into must NOT advance the cursor past
// something the operator never actually heard.
// =============================================================================

describe('concern 04: sweepPromptWatchers onCompletionNarrated', () => {
  test('fires with the completion entry\'s own ts when its narration response completes uncancelled', () => {
    const refs = makeRefs({
      boundAgentIdRef: { current: 'agent-1' },
      watchersRef: { current: new Map([['agent-1', [{ kind: 'prompt', clientTurnId: 'turn-1', echoed: true, cursor: 0, label: 'the agent' }]]]) },
    });
    const { session, onDones } = makeFakeSession();
    const narrated: number[] = [];
    const transcripts = new Map<string, TranscriptEntry[]>([['agent-1', [{ id: 'e1', kind: 'assistant', text: 'fixed it', ts: 42, status: 'ok' }]]]);

    sweepPromptWatchers(session, refs, { transcripts, agents: [], onCompletionNarrated: (ts) => narrated.push(ts) });

    expect(onDones).toHaveLength(1);
    expect(narrated).toEqual([]); // not yet — onDone hasn't fired
    onDones[0]!({ cancelled: false }); // the narration's own response completed
    expect(narrated).toEqual([42]);
  });

  test('does NOT fire when the narration was barged into / cancelled — onNarrationLost fires with the same ts instead (the unheard-floor signal)', () => {
    const refs = makeRefs({
      boundAgentIdRef: { current: 'agent-1' },
      watchersRef: { current: new Map([['agent-1', [{ kind: 'prompt', clientTurnId: 'turn-1', echoed: true, cursor: 0, label: 'the agent' }]]]) },
    });
    const { session, onDones } = makeFakeSession();
    const narrated: number[] = [];
    const lost: number[] = [];
    const transcripts = new Map<string, TranscriptEntry[]>([['agent-1', [{ id: 'e1', kind: 'assistant', text: 'fixed it', ts: 42, status: 'ok' }]]]);

    sweepPromptWatchers(session, refs, { transcripts, agents: [], onCompletionNarrated: (ts) => narrated.push(ts), onNarrationLost: (ts) => lost.push(ts) });
    onDones[0]!({ cancelled: true });

    expect(narrated).toEqual([]);
    expect(lost).toEqual([42]);
  });

  test('is optional — a caller that never supplies it does not throw when the narration completes', () => {
    const refs = makeRefs({
      boundAgentIdRef: { current: 'agent-1' },
      watchersRef: { current: new Map([['agent-1', [{ kind: 'prompt', clientTurnId: 'turn-1', echoed: true, cursor: 0, label: 'the agent' }]]]) },
    });
    const { session, onDones } = makeFakeSession();
    const transcripts = new Map<string, TranscriptEntry[]>([['agent-1', [{ id: 'e1', kind: 'assistant', text: 'fixed it', ts: 42, status: 'ok' }]]]);

    sweepPromptWatchers(session, refs, { transcripts, agents: [] });

    expect(() => onDones[0]!({ cancelled: false })).not.toThrow();
  });
});

// =============================================================================
// LOW batch: dispatchSpawnAgent must validate the /api/spawn response before dereferencing
// `agent.id` — a 2xx with a missing/malformed `agent` field previously derefed `agent.id` AFTER
// the `catch` block, so no `sendFunctionOutput` was ever sent and the session wedged in
// `toolPending` forever (the reducer's `toolPending` cell has no timeout of its own — it waits
// specifically for an ack that would now never come).
// =============================================================================

function spawnRefs(overrides: Partial<DispatchSpawnAgentRefs> = {}): DispatchSpawnAgentRefs {
  return {
    spawnInFlightRef: { current: false },
    watchersRef: { current: new Map() },
    ...overrides,
  };
}

describe('LOW batch: dispatchSpawnAgent validates the /api/spawn response', () => {
  test('a well-formed 2xx response dispatches normally and arms a completion watcher', async () => {
    const refs = spawnRefs();
    const { session, outputs } = makeFakeSession();
    const agent: AgentDTO = { id: 'agent-9', name: 'fresh-agent' } as AgentDTO;
    const deps: DispatchSpawnAgentDeps = {
      transcripts: new Map(),
      apiJsonFn: (async () => ({ agent })) as unknown as DispatchSpawnAgentDeps['apiJsonFn'],
    };

    await dispatchSpawnAgent(session, 'call-1', 'build a widget', refs, deps);

    expect(outputs).toEqual([{ callId: 'call-1', output: { status: 'dispatched', detail: "spawned fresh-agent — tracking it, I'll let you know when it finishes" } }]);
    expect(refs.watchersRef.current.get('agent-9')).toEqual([{ kind: 'spawn', echoed: true, cursor: 0, label: 'fresh-agent' }]);
    expect(refs.spawnInFlightRef.current).toBe(false); // released, not wedged
  });

  // Concern 04: durable voice spawns — onAgentSpawned lets the caller (VoiceCallContext) persist a
  // SpawnedUnitRecord onto the bound session's spawnedUnits, so a voice-dispatched spawn is visible
  // to the NEXT call's debrief tracked-agent set exactly like a typed spawn already is. `prompt`
  // rides along (not just {id, name}) since the caller's SpawnedUnitRecord.prompt is a REQUIRED
  // field it must fill honestly, and this function already has the exact prompt in scope.
  describe('concern 04: onAgentSpawned', () => {
    test('fires with {id, name, prompt} after a successful spawn', async () => {
      const refs = spawnRefs();
      const { session } = makeFakeSession();
      const agent: AgentDTO = { id: 'agent-9', name: 'fresh-agent' } as AgentDTO;
      const spawned: Array<{ id: string; name: string; prompt: string }> = [];
      const deps: DispatchSpawnAgentDeps = {
        transcripts: new Map(),
        onAgentSpawned: (a) => spawned.push(a),
        apiJsonFn: (async () => ({ agent })) as unknown as DispatchSpawnAgentDeps['apiJsonFn'],
      };

      await dispatchSpawnAgent(session, 'call-1', 'build a widget', refs, deps);

      expect(spawned).toEqual([{ id: 'agent-9', name: 'fresh-agent', prompt: 'build a widget' }]);
    });

    test('does NOT fire when the spawn fails', async () => {
      const refs = spawnRefs();
      const { session } = makeFakeSession();
      const spawned: unknown[] = [];
      const deps: DispatchSpawnAgentDeps = {
        transcripts: new Map(),
        onAgentSpawned: (a) => spawned.push(a),
        apiJsonFn: (async () => {
          throw new Error('network error');
        }) as unknown as DispatchSpawnAgentDeps['apiJsonFn'],
      };

      await dispatchSpawnAgent(session, 'call-1', 'build a widget', refs, deps);

      expect(spawned).toEqual([]);
    });

    test('is optional — a caller that never supplies it does not throw', async () => {
      const refs = spawnRefs();
      const { session } = makeFakeSession();
      const agent: AgentDTO = { id: 'agent-9', name: 'fresh-agent' } as AgentDTO;
      const deps: DispatchSpawnAgentDeps = { transcripts: new Map(), apiJsonFn: (async () => ({ agent })) as unknown as DispatchSpawnAgentDeps['apiJsonFn'] };

      await expect(dispatchSpawnAgent(session, 'call-1', 'build a widget', refs, deps)).resolves.toBeUndefined();
    });
  });

  test('a 2xx response with a MISSING agent field fails honestly instead of wedging toolPending forever', async () => {
    const refs = spawnRefs();
    const { session, outputs } = makeFakeSession();
    const deps: DispatchSpawnAgentDeps = {
      transcripts: new Map(),
      apiJsonFn: (async () => ({})) as unknown as DispatchSpawnAgentDeps['apiJsonFn'], // no `agent` at all
    };

    await dispatchSpawnAgent(session, 'call-1', 'build a widget', refs, deps);

    // The critical assertion: sendFunctionOutput WAS called (the session is never left waiting
    // forever for an ack that would never come).
    expect(outputs).toEqual([{ callId: 'call-1', output: { status: 'failed', detail: 'could not spawn a new agent' } }]);
    expect(refs.watchersRef.current.size).toBe(0); // no bogus watcher armed for a nonexistent agent
    expect(refs.spawnInFlightRef.current).toBe(false);
  });

  test('a 2xx response with an agent object missing `id` also fails honestly', async () => {
    const refs = spawnRefs();
    const { session, outputs } = makeFakeSession();
    const deps: DispatchSpawnAgentDeps = {
      transcripts: new Map(),
      apiJsonFn: (async () => ({ agent: { name: 'no-id-agent' } })) as unknown as DispatchSpawnAgentDeps['apiJsonFn'],
    };

    await dispatchSpawnAgent(session, 'call-1', 'build a widget', refs, deps);

    expect(outputs).toEqual([{ callId: 'call-1', output: { status: 'failed', detail: 'could not spawn a new agent' } }]);
    expect(refs.watchersRef.current.size).toBe(0);
  });

  test('a network/thrown failure still releases spawnInFlightRef (not wedged for future spawn_agent calls)', async () => {
    const refs = spawnRefs({ spawnInFlightRef: { current: false } });
    const { session, outputs } = makeFakeSession();
    const deps: DispatchSpawnAgentDeps = {
      transcripts: new Map(),
      apiJsonFn: (async () => {
        throw new Error('network error');
      }) as unknown as DispatchSpawnAgentDeps['apiJsonFn'],
    };

    await dispatchSpawnAgent(session, 'call-1', 'build a widget', refs, deps);

    expect(outputs).toEqual([{ callId: 'call-1', output: { status: 'failed', detail: 'could not spawn a new agent' } }]);
    expect(refs.spawnInFlightRef.current).toBe(false);
  });

  test('a second spawn to a DIFFERENT agent id pushes its own watcher without disturbing a pending one', async () => {
    const refs = spawnRefs({ watchersRef: { current: new Map([['agent-1', [{ kind: 'spawn', echoed: true, cursor: 0, label: 'agent-one' }]]]) } });
    const { session } = makeFakeSession();
    const agent: AgentDTO = { id: 'agent-2', name: 'agent-two' } as AgentDTO;
    const deps: DispatchSpawnAgentDeps = {
      transcripts: new Map(),
      apiJsonFn: (async () => ({ agent })) as unknown as DispatchSpawnAgentDeps['apiJsonFn'],
    };

    await dispatchSpawnAgent(session, 'call-2', 'another task', refs, deps);

    expect(refs.watchersRef.current.get('agent-1')).toEqual([{ kind: 'spawn', echoed: true, cursor: 0, label: 'agent-one' }]); // untouched
    expect(refs.watchersRef.current.get('agent-2')).toEqual([{ kind: 'spawn', echoed: true, cursor: 0, label: 'agent-two' }]);
  });
});

// =============================================================================
// LOW batch: a second prompt_agent dispatch to the SAME agent (reachable once the first's
// promptInFlight lock releases at its own echo — MAJOR-2 — well before its completion narrates)
// must get its own independent completion watcher, not silently overwrite the first's. Pre-fix,
// `watchersRef` was a single-value Map keyed by agentId, so the second dispatch's `.set(agentId,
// ...)` call would clobber the first watcher — the operator's first turn would never narrate.
// =============================================================================

describe('LOW batch: two prompt_agent dispatches in flight to the same agent both narrate', () => {
  test('a second dispatch (reachable after the first echoes) does not drop the first turn\'s completion watcher', async () => {
    const refs = makeRefs({ boundAgentIdRef: { current: 'agent-1' }, hasEverBoundRef: { current: true } });
    const { session, injections } = makeFakeSession();
    const clientTurnIds: string[] = [];
    const deps = baseDeps({
      transcripts: new Map(),
      buildPromptCommandFn: ((_ctx: unknown, message: string, opts: { clientTurnId: string }) => {
        clientTurnIds.push(opts.clientTurnId);
        return { type: 'prompt', id: 'agent-1', message, displayText: message };
      }) as unknown as DispatchPromptAgentDeps['buildPromptCommandFn'],
    });

    // First dispatch: "fix the bug" — pushes a watcher for turn-1 onto agent-1's list.
    await dispatchPromptAgent(session, 'call-1', 'fix the bug', refs, deps);
    expect(refs.watchersRef.current.get('agent-1')).toHaveLength(1);
    const turn1 = clientTurnIds[0]!;

    // The first dispatch's echo lands — MAJOR-2 releases promptInFlightRef right here, well before
    // any completion — making a second dispatch to the SAME agent reachable.
    const afterEcho1 = new Map<string, TranscriptEntry[]>([['agent-1', [{ id: 'e1', kind: 'user', text: 'fix the bug', ts: 1, clientTurnId: turn1 }]]]);
    sweepPromptWatchers(session, refs, { transcripts: afterEcho1, agents: [] });
    expect(refs.promptInFlightRef.current).toBe(false);
    expect(injections).toEqual([]); // turn-1 hasn't completed yet

    // Second dispatch: "also run the tests" — reachable now the lock released.
    await dispatchPromptAgent(session, 'call-2', 'also run the tests', refs, { ...deps, transcripts: afterEcho1 });
    expect(refs.watchersRef.current.get('agent-1')).toHaveLength(2); // BOTH watchers present — turn-1's was not clobbered
    const turn2 = clientTurnIds[1]!;

    // turn-2 echoes too, then BOTH turns complete (turn-1 first, turn-2 after).
    const bothEchoedThenTurn1Done = new Map<string, TranscriptEntry[]>([[
      'agent-1',
      [
        { id: 'e1', kind: 'user', text: 'fix the bug', ts: 1, clientTurnId: turn1 },
        { id: 'e2', kind: 'user', text: 'also run the tests', ts: 2, clientTurnId: turn2 },
        { id: 'e3', kind: 'assistant', text: 'fixed the bug', ts: 3, status: 'ok' },
      ],
    ]]);
    sweepPromptWatchers(session, refs, { transcripts: bothEchoedThenTurn1Done, agents: [] });

    // turn-1's completion narrated; turn-2's watcher is still pending its own completion, not lost.
    expect(injections).toHaveLength(1);
    expect((injections[0]![0] as { content: [{ text: string }] }).content[0].text).toContain('fixed the bug');
    expect(refs.watchersRef.current.get('agent-1')).toHaveLength(1); // turn-2's watcher survives

    const turn2Done = new Map<string, TranscriptEntry[]>([[
      'agent-1',
      [
        ...bothEchoedThenTurn1Done.get('agent-1')!,
        { id: 'e4', kind: 'assistant', text: 'tests pass', ts: 4, status: 'ok' },
      ],
    ]]);
    sweepPromptWatchers(session, refs, { transcripts: turn2Done, agents: [] });

    expect(injections).toHaveLength(2);
    expect((injections[1]![0] as { content: [{ text: string }] }).content[0].text).toContain('tests pass');
    expect(refs.watchersRef.current.has('agent-1')).toBe(false); // both watchers consumed
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
