import { describe, expect, test } from 'bun:test';
import {
  ALL_AGENTS,
  IDLE_HANGUP_MS,
  IDLE_WARNING_MS,
  PHASE_LABEL,
  PHASE_LABEL_CH,
  artifactAgent,
  artifactAgentOptions,
  artifactEmptyCopy,
  artifactStateCopy,
  attentionChipLabel,
  bindingBanner,
  currentPane,
  decisionAnnouncement,
  decisionDoorModel,
  decisionStateLine,
  decisionUrgency,
  endedUnexpectedly,
  focusHudRegion,
  groupArtifacts,
  idlePolicyLine,
  initialPaneStack,
  isRawRoomEvent,
  isUiOnlyDecision,
  optionLabelWithoutMarker,
  phaseExplanation,
  popPane,
  pushPane,
  readResolveAck,
  reconcileArtifactPane,
  recommendedOptionIndex,
  registerPresentation,
  resolveOutcomeCopy,
  retentionNotice,
  setStackFilter,
  shouldSteer,
  steerRefusalCopy,
  steerStatusLine,
  terminalReasonCopy,
  threadStatus,
  withoutRawRoomEvents,
} from './roomCall';
import type { VoiceCallArtifactDTO, VoiceCallBindingDTO, VoiceCallDecisionDTO } from '../api';

// -------------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------------

function binding(over: Partial<VoiceCallBindingDTO> = {}): VoiceCallBindingDTO {
  return {
    channelId: 'room-1',
    callId: 'call-abcdef01',
    sessionRoot: '/repo',
    ownerActorId: 'web:lars',
    retention: 'full',
    startedAt: 1_000,
    updatedAt: 1_000,
    state: 'live',
    ...over,
  };
}

function decision(over: Partial<VoiceCallDecisionDTO> = {}): VoiceCallDecisionDTO {
  return {
    id: 'dec-1',
    prompt: 'Should the retry budget be per endpoint or global?',
    options: [
      { index: 0, label: 'Per endpoint', consequence: 'Each endpoint keeps its own budget; the noisy one cannot starve the rest.' },
      { index: 1, label: 'Global', consequence: 'One budget for everything; simpler, and one bad endpoint can eat it.' },
    ],
    requiresConfirmation: false,
    state: 'open',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function artifact(over: Partial<VoiceCallArtifactDTO> = {}): VoiceCallArtifactDTO {
  return {
    id: 'art-1',
    channelId: 'room-1',
    callId: 'call-abcdef01',
    sourcePath: '/repo/NOTES.md',
    status: 'ready',
    contentHash: 'deadbeef',
    revision: 1,
    snapshotPath: '/state/voice-artifacts/room-1/call-abcdef01/deadbeef/NOTES.md',
    copiedAt: 5_000,
    ...over,
  };
}

// -------------------------------------------------------------------------------------------------
// Epistemic register (DESIGN.md addendum)
// -------------------------------------------------------------------------------------------------

describe('epistemic register', () => {
  test('claim renders italic and announces itself, without stacking opacity', () => {
    const claim = registerPresentation('claim')!;
    expect(claim.style.fontStyle).toBe('italic');
    expect(claim.ariaLabel).toBe("The agent's own account");
    // The addendum's hard rule: no opacity layered onto the already-muted card body.
    expect(JSON.stringify(claim.style)).not.toContain('opacity');
    expect(claim.style.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  test('unverified renders a dashed underline rather than a second dimming', () => {
    const unverified = registerPresentation('unverified')!;
    expect(unverified.style.textDecorationStyle).toBe('dashed');
    expect(unverified.style.fontStyle).toBeUndefined();
    expect(JSON.stringify(unverified.style)).not.toContain('opacity');
  });

  test('every register clears WCAG AA against the room backdrop', () => {
    // Recomputed here rather than trusted from a comment: a token nudged in a later restyle must
    // fail this test, not quietly ship a 3:1 body text.
    const luminance = (hex: string) => {
      const channel = (value: number) => {
        const srgb = value / 255;
        return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      const r = channel(Number.parseInt(hex.slice(1, 3), 16));
      const g = channel(Number.parseInt(hex.slice(3, 5), 16));
      const b = channel(Number.parseInt(hex.slice(5, 7), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const backdrop = luminance('#09090A'); // ChannelTimeline's own scroller background
    for (const register of ['claim', 'checked', 'unverified'] as const) {
      const colour = registerPresentation(register)!.style.color;
      const ratio = (luminance(colour) + 0.05) / (backdrop + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('an absent register changes nothing', () => {
    expect(registerPresentation(undefined)).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------
// Phase chrome, retention, idle policy
// -------------------------------------------------------------------------------------------------

describe('call phase chrome', () => {
  test('the reserved width fits every phase label, so the chrome is fixed-size', () => {
    for (const label of Object.values(PHASE_LABEL)) expect(label.length).toBeLessThanOrEqual(PHASE_LABEL_CH);
  });

  test('a degraded call says the socket dropped, not that everything is fine', () => {
    expect(phaseExplanation(binding({ state: 'degraded' }))).toContain('socket');
  });

  test('each terminal reason gets its own honest sentence', () => {
    expect(terminalReasonCopy('operator-ended')).toContain('You ended');
    expect(terminalReasonCopy('journal-end')).toContain('crashed');
    expect(terminalReasonCopy('port-reused')).toContain('refused');
    expect(terminalReasonCopy('terminal', 'boom')).toContain('boom');
  });

  test('the binding banner names the call and the PINNED session, and invents neither', () => {
    // After a reload this is what proves the call on screen is the call that was started rather
    // than a stranger that inherited the port.
    expect(bindingBanner(binding({ callId: 'call-9', sessionId: 'sess-7' }))).toBe('call call-9 · session sess-7');
    expect(bindingBanner(binding({ callId: 'call-9', sessionId: undefined }))).toContain('not pinned yet');
    expect(bindingBanner(binding({ callId: undefined }))).toBeUndefined();
    expect(bindingBanner(null)).toBeUndefined();
  });

  test('only an unchosen ending counts as unexpected', () => {
    expect(endedUnexpectedly(binding({ state: 'ended', terminalReason: 'operator-ended' }))).toBe(false);
    expect(endedUnexpectedly(binding({ state: 'ended', terminalReason: 'terminal', terminalError: null }))).toBe(false);
    expect(endedUnexpectedly(binding({ state: 'ended', terminalReason: 'terminal', terminalError: 'boom' }))).toBe(true);
    expect(endedUnexpectedly(binding({ state: 'ended', terminalReason: 'journal-end' }))).toBe(true);
    expect(endedUnexpectedly(binding({ state: 'live' }))).toBe(false);
    expect(endedUnexpectedly(null)).toBe(false);
  });

  // Concern 05's idle-hangup policy ending the call is a normal, chosen-by-policy outcome — the same
  // shape as an operator ending it — not a surprise the status region should raise.
  test('the idle-hangup policy ending the call is honest, and not "unexpected"', () => {
    expect(terminalReasonCopy('idle')).toContain('idle');
    expect(terminalReasonCopy('idle')).toContain('10 minutes');
    expect(endedUnexpectedly(binding({ state: 'ended', terminalReason: 'idle' }))).toBe(false);
  });
});

describe('recording and retention, visible at call start', () => {
  test('the default is full retention and says what that means', () => {
    const notice = retentionNotice(binding({ retention: 'full' }));
    expect(notice.label).toBe('Recording in full');
    expect(notice.mismatch).toBe(false);
    expect(notice.detail).toContain('durable record');
  });

  test('a mismatch shows what the SESSION reports, not what the room asked for', () => {
    const notice = retentionNotice(binding({ retention: 'full', retentionMismatch: { expected: 'full', reported: 'tails' } }));
    expect(notice.mismatch).toBe(true);
    // The operative mode is the reported one — showing "in full" here is the invisible privacy
    // expansion DESIGN.md's risk table exists to prevent.
    expect(notice.label).toBe('Recording tails only');
    expect(notice.detail).toContain('"full"');
    expect(notice.detail).toContain('"tails"');
  });
});

describe('idle policy (concern 05: 10 minutes, spoken warning at nine)', () => {
  test('states the policy when the call is fresh', () => {
    expect(idlePolicyLine(undefined, 0)).toContain('10 minutes');
    expect(idlePolicyLine(1_000, 1_000)).toContain('spoken warning');
  });

  test('counts down once the room has actually gone quiet', () => {
    const line = idlePolicyLine(0, 4 * 60_000);
    expect(line).toContain('Quiet for 4 minutes');
    expect(line).toContain('6 minutes');
  });

  test('names the spoken warning at the nine-minute mark', () => {
    expect(idlePolicyLine(0, IDLE_WARNING_MS)).toContain('nine minutes');
    expect(idlePolicyLine(0, IDLE_HANGUP_MS)).toContain('hanging up');
  });
});

// -------------------------------------------------------------------------------------------------
// Decision door
// -------------------------------------------------------------------------------------------------

describe('decision door', () => {
  test('urgency mirrors the daemon ladder, with confirmation counted as urgent', () => {
    expect(decisionUrgency(decision({ state: 'awaiting-confirmation' }))).toBe('urgent');
    expect(decisionUrgency(decision({ state: 'open', requiresConfirmation: true }))).toBe('urgent');
    expect(decisionUrgency(decision({ state: 'open', requiresConfirmation: false }))).toBe('review');
    expect(decisionUrgency(decision({ state: 'answered' }))).toBe('settled');
    expect(decisionUrgency(decision({ state: 'expired' }))).toBe('settled');
  });

  test('the question carries the claim register and the state line does not', () => {
    const model = decisionDoorModel(decision());
    expect(model.register).toBe('claim');
    expect(model.question).toBe('Should the retry budget be per endpoint or global?');
    // Chrome is the daemon's own observation, in the room's voice — never the agent's.
    expect(model.stateLine).toBe('Open.');
  });

  test('a recommendation is surfaced from the agent’s own words and never pre-selected', () => {
    const model = decisionDoorModel(
      decision({
        options: [
          { index: 0, label: 'Per endpoint (recommended)', consequence: 'Each endpoint keeps its own budget.' },
          { index: 1, label: 'Global', consequence: 'One budget for everything.' },
        ],
      }),
    );
    expect(model.options[0]!.recommended).toBe(true);
    expect(model.options[1]!.recommended).toBe(false);
    // The marker is stripped from the label so the badge says it once, not twice.
    expect(model.options[0]!.label).toBe('Per endpoint');
    // Nothing in the model marks an option as chosen or defaulted — the ONLY selection state comes
    // from a resolution the daemon reported.
    expect(model.resolution).toBeUndefined();
  });

  test('no recommendation is invented when the agent did not make one', () => {
    expect(recommendedOptionIndex(decision().options)).toBeUndefined();
    expect(optionLabelWithoutMarker('Per endpoint')).toBe('Per endpoint');
  });

  test('a resolved decision is inspect-only and records who chose', () => {
    const model = decisionDoorModel(decision({ state: 'answered', resolution: { optionIndex: 0, label: 'Per endpoint', source: 'voice' } }));
    expect(model.resolved).toBe(true);
    expect(model.resolution).toEqual({ label: 'Per endpoint', source: 'voice' });
    expect(decisionStateLine(decision({ state: 'answered', resolution: { optionIndex: 0, label: 'Per endpoint', source: 'voice' } }))).toContain('by voice');
  });

  test('destructive and outward decisions are flagged UI-only (concern 05)', () => {
    expect(isUiOnlyDecision(decision({ prompt: 'Merge the branch now?' }))).toBe(true);
    expect(isUiOnlyDecision(decision({ prompt: 'Publish 3.2 to npm?' }))).toBe(true);
    expect(isUiOnlyDecision(decision({ options: [{ index: 0, label: 'Delete the worktree', consequence: 'It is gone.' }] }))).toBe(true);
    expect(isUiOnlyDecision(decision())).toBe(false);
  });

  // Concern 05's mechanism: the wire now carries a real decisionClass the arbiter enforces. It is a
  // FACT and takes precedence unconditionally — even over a heuristic that would have guessed the
  // opposite — and the door model exposes WHICH source produced `uiOnly` so it can render a fact
  // differently from a guess. A classless decision keeps the old heuristic-only behavior exactly.
  describe('decisionClass (concern 05): the wire field is a fact, and wins over the heuristic', () => {
    test('a wire-declared "destructive" decision is UI-only even with entirely unremarkable words', () => {
      const d = decision({ prompt: 'Choose a font?', decisionClass: 'destructive' });
      expect(isUiOnlyDecision(d)).toBe(true);
      expect(decisionDoorModel(d).uiOnlySource).toBe('wire');
    });

    test('a wire-declared "routine" decision is NOT UI-only even when its words look destructive', () => {
      const d = decision({ prompt: 'Merge the branch now?', decisionClass: 'routine' });
      expect(isUiOnlyDecision(d)).toBe(false);
      expect(decisionDoorModel(d).uiOnlySource).toBe('wire');
    });

    test('a classless decision falls back to the text heuristic, exactly as before this field existed', () => {
      const destructive = decision({ prompt: 'Merge the branch now?' });
      expect(isUiOnlyDecision(destructive)).toBe(true);
      expect(decisionDoorModel(destructive).uiOnlySource).toBe('heuristic');

      const routine = decision();
      expect(isUiOnlyDecision(routine)).toBe(false);
      expect(decisionDoorModel(routine).uiOnlySource).toBe('heuristic');
    });
  });

  test('an ack that says ok:false is a REFUSAL with its real reason, not a transport error', () => {
    expect(readResolveAck({ ok: true }, 'Per endpoint')).toEqual({ kind: 'resolved', label: 'Per endpoint' });
    const competing = readResolveAck({ ok: false, reason: 'already-terminal' }, 'Per endpoint');
    expect(competing.kind).toBe('refused');
    expect(competing.kind === 'refused' && competing.message).toContain('already resolved');
    const mismatch = readResolveAck({ ok: false, reason: 'label-mismatch' }, 'Per endpoint');
    expect(mismatch.kind === 'refused' && mismatch.message).toContain('different label');
  });

  test('a confirmation demand is not a refusal', () => {
    const outcome = readResolveAck({ ok: false, reason: 'confirm-required', confirmToken: 'tok-1' }, 'Merge');
    expect(outcome).toEqual({ kind: 'confirm-required', confirmToken: 'tok-1', label: 'Merge' });
  });

  test('an unknown arbiter reason is still reported verbatim rather than swallowed', () => {
    expect(resolveOutcomeCopy('some-new-reason')).toContain('some-new-reason');
    expect(resolveOutcomeCopy(undefined)).toContain('did not say why');
  });
});

// -------------------------------------------------------------------------------------------------
// Steering
// -------------------------------------------------------------------------------------------------

describe('composer steering', () => {
  test('only non-mention text steers, and only while a call exists', () => {
    expect(shouldSteer({ callState: 'live', mentionRoute: 'none', text: 'try the other endpoint' })).toBe(true);
    expect(shouldSteer({ callState: 'degraded', mentionRoute: 'none', text: 'hello' })).toBe(true);
    // Fleet mention semantics are untouched: an addressed mention is a fleet instruction.
    expect(shouldSteer({ callState: 'live', mentionRoute: 'steer', text: '@wren do the thing' })).toBe(false);
    expect(shouldSteer({ callState: 'live', mentionRoute: 'spawn', text: '@new go' })).toBe(false);
    expect(shouldSteer({ callState: 'ended', mentionRoute: 'none', text: 'hello' })).toBe(false);
    expect(shouldSteer({ callState: undefined, mentionRoute: 'none', text: 'hello' })).toBe(false);
    expect(shouldSteer({ callState: 'live', mentionRoute: 'none', text: '   ' })).toBe(false);
  });

  test('"delivered" appears only after acknowledgement', () => {
    expect(steerStatusLine({ text: 'x', status: 'sending' })).toBe('Sending to the call…');
    expect(steerStatusLine({ text: 'x', status: 'sending' })).not.toContain('Delivered');
    expect(steerStatusLine({ text: 'x', status: 'delivered' })).toBe('Delivered to the call.');
  });

  test('a refusal is visible and says the session did not hear it', () => {
    const line = steerStatusLine({ text: 'x', status: 'refused', message: steerRefusalCopy('bridge-unavailable') });
    expect(line).toContain('never heard this');
    expect(line).not.toContain('Delivered');
    expect(steerRefusalCopy('no-active-call')).toContain('no live call');
    expect(steerRefusalCopy('something odd')).toContain('did not hear it');
  });
});

// -------------------------------------------------------------------------------------------------
// Raw activity suppression
// -------------------------------------------------------------------------------------------------

describe('raw activity never reaches a card', () => {
  const entry = (over: Record<string, unknown>) => ({ text: '', event: undefined, ...over }) as never;

  test('yield, heartbeats and their spelling variants are suppressed', () => {
    for (const kind of ['yield', 'toolYield', 'tool-yield', 'heartbeat', 'keepalive', 'ping', 'noop', 'tick']) {
      expect(isRawRoomEvent(entry({ text: 'anything', event: { kind, issuer: 'manager', payload: {} } }))).toBe(true);
    }
  });

  test('an empty activity event is suppressed; an empty MESSAGE is not', () => {
    expect(isRawRoomEvent(entry({ text: '   ', event: { kind: 'some-activity', issuer: 'manager', payload: {} } }))).toBe(true);
    // No event at all is a plain message — a different bug in a different place, and swallowing it
    // here would hide it.
    expect(isRawRoomEvent(entry({ text: '' }))).toBe(false);
  });

  test('an event carrying a face survives even with empty text', () => {
    expect(isRawRoomEvent(entry({ text: '', event: { kind: 'voice-call', issuer: 'manager', payload: { face: { title: 'Call live' } } } }))).toBe(false);
  });

  test('a real card is never dropped by the filter', () => {
    const kept = withoutRawRoomEvents([
      entry({ text: 'Call live', event: { kind: 'voice-call', issuer: 'manager', payload: { face: { title: 'Call live' } } } }),
      entry({ text: '', event: { kind: 'yield', issuer: 'manager', payload: {} } }),
      entry({ text: 'hello', event: undefined }),
    ]);
    expect(kept).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------------------------------
// Thread status region
// -------------------------------------------------------------------------------------------------

describe('thread status region', () => {
  const base = { decisions: [] as VoiceCallDecisionDTO[], activeAgents: 0 };

  test('no binding means no call, not "all clear"', () => {
    expect(threadStatus({ ...base, binding: null }).kind).toBe('no-call');
  });

  test('every state the concern names is reachable', () => {
    expect(threadStatus({ ...base, binding: binding({ state: 'ended', terminalReason: 'journal-end' }) }).kind).toBe('ended-unexpectedly');
    expect(threadStatus({ ...base, binding: binding({ state: 'degraded' }) }).kind).toBe('degraded');
    expect(threadStatus({ ...base, binding: binding(), decisions: [decision({ requiresConfirmation: true })] }).kind).toBe('open-decisions');
    expect(threadStatus({ ...base, binding: binding(), decisions: [decision()] }).kind).toBe('review-queue');
    expect(threadStatus({ ...base, binding: binding(), activeAgents: 2 }).kind).toBe('active-agents');
    expect(threadStatus({ ...base, binding: binding() }).kind).toBe('all-clear');
  });

  test('a broken relay outranks a question you cannot answer through it', () => {
    // A decision sitting behind a dead socket is not "a question waiting" — saying so first is what
    // stops someone clicking an option four times.
    const status = threadStatus({ ...base, binding: binding({ state: 'degraded' }), decisions: [decision({ requiresConfirmation: true })] });
    expect(status.kind).toBe('degraded');
  });

  test('an unexpected ending outranks everything, and carries the reason', () => {
    const status = threadStatus({ ...base, binding: binding({ state: 'ended', terminalReason: 'broker-exit' }), decisions: [decision({ requiresConfirmation: true })], activeAgents: 3 });
    expect(status.kind).toBe('ended-unexpectedly');
    expect(status.detail).toContain('broker');
  });

  test('a visible journal gap is reported rather than papered over', () => {
    const status = threadStatus({ ...base, binding: binding(), activeAgents: 1, gaps: [{ callId: 'call-abcdef01', atSeq: 4, missingCount: 2, detectedAt: 9 }] });
    expect(status.detail).toContain('gap');
  });

  test('the count is a real count', () => {
    expect(threadStatus({ ...base, binding: binding(), decisions: [decision({ id: 'a', requiresConfirmation: true }), decision({ id: 'b', requiresConfirmation: true })] }).count).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------------
// Attention chip and the live region
// -------------------------------------------------------------------------------------------------

describe('attention without interruption', () => {
  test('a new decision produces one announcement, and a re-poll produces none', () => {
    const seen = new Set<string>();
    const first = decisionAnnouncement(seen, [decision()]);
    expect(first).toContain('A decision is waiting');
    seen.add('dec-1');
    expect(decisionAnnouncement(seen, [decision()])).toBeUndefined();
  });

  test('a resolved decision arriving announces nothing', () => {
    expect(decisionAnnouncement(new Set(), [decision({ state: 'answered' })])).toBeUndefined();
  });

  test('the chip counts urgent first, then the review queue, and is silent when clear', () => {
    expect(attentionChipLabel([decision({ requiresConfirmation: true })])).toBe('1 waiting on you');
    expect(attentionChipLabel([decision()])).toBe('1 to review');
    expect(attentionChipLabel([decision({ state: 'answered' })])).toBeUndefined();
    expect(attentionChipLabel([])).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------
// Artifacts index
// -------------------------------------------------------------------------------------------------

describe('artifacts index', () => {
  test('the current run leads, and grouping is by call', () => {
    const groups = groupArtifacts(
      [artifact({ id: 'a', callId: 'old-call', copiedAt: 9_000 }), artifact({ id: 'b', callId: 'call-abcdef01', copiedAt: 1_000 })],
      'call-abcdef01',
    );
    expect(groups[0]!.callId).toBe('call-abcdef01');
    expect(groups[0]!.current).toBe(true);
    expect(groups[1]!.current).toBe(false);
  });

  test('order is stable across identical polls', () => {
    const input = [artifact({ id: 'a', sourcePath: '/repo/b.md', copiedAt: 5_000 }), artifact({ id: 'b', sourcePath: '/repo/a.md', copiedAt: 5_000 })];
    const once = groupArtifacts(input, 'call-abcdef01').flatMap((group) => group.rows.map((row) => row.id));
    const twice = groupArtifacts([...input].reverse(), 'call-abcdef01').flatMap((group) => group.rows.map((row) => row.id));
    expect(once).toEqual(twice);
  });

  test('every artifact state renders as its own thing', () => {
    const rows = groupArtifacts(
      [
        artifact({ id: 'ready' }),
        artifact({ id: 'writing', status: 'incomplete', snapshotPath: undefined, contentHash: undefined }),
        artifact({ id: 'missing', status: 'failed', error: 'enoent: artifact path does not exist: /repo/gone.md', snapshotPath: undefined }),
        artifact({ id: 'failed', status: 'failed', error: 'snapshot copy failed: EACCES', snapshotPath: undefined }),
      ],
      'call-abcdef01',
    )[0]!.rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('ready')!.state).toBe('ready');
    expect(byId.get('writing')!.state).toBe('writing');
    // A vanished source and a broken copier are different things for the reader to do about.
    expect(byId.get('missing')!.state).toBe('missing');
    expect(byId.get('failed')!.state).toBe('failed');
    expect(artifactStateCopy(byId.get('ready')!)).toBeUndefined();
    expect(artifactStateCopy(byId.get('writing')!)).toContain('Still being written');
  });

  test('the agent filter defaults to all and narrows to one', () => {
    const artifacts = [
      artifact({ id: 'a', sourcePath: '/repo/.claude/worktrees/wren/NOTES.md' }),
      artifact({ id: 'b', sourcePath: '/repo/PLAN.md' }),
    ];
    expect(artifactAgentOptions(artifacts)).toEqual([ALL_AGENTS, 'session', 'wren']);
    expect(groupArtifacts(artifacts, 'call-abcdef01', ALL_AGENTS)[0]!.rows).toHaveLength(2);
    const wrenOnly = groupArtifacts(artifacts, 'call-abcdef01', 'wren')[0]!.rows;
    expect(wrenOnly).toHaveLength(1);
    expect(wrenOnly[0]!.id).toBe('a');
  });

  test('an unattributable path is honestly "session" rather than a guess', () => {
    expect(artifactAgent('/repo/PLAN.md')).toBe('session');
    expect(artifactAgent('/repo/.claude/worktrees/voice-b4/NOTES.md')).toBe('voice-b4');
    expect(artifactAgent('/repo/squad/wren-abc/OUT.md')).toBe('wren-abc');
  });

  test('a superseded revision is marked as history, not as the current file', () => {
    const rows = groupArtifacts(
      [artifact({ id: 'v1', revision: 1, contentHash: 'aaa', copiedAt: 1 }), artifact({ id: 'v2', revision: 2, contentHash: 'bbb', copiedAt: 2 })],
      'call-abcdef01',
    )[0]!.rows;
    expect(rows.find((row) => row.id === 'v1')!.superseded).toBe(true);
    expect(rows.find((row) => row.id === 'v2')!.superseded).toBe(false);
  });

  test('empty says WHY it is empty', () => {
    expect(artifactEmptyCopy(null, false)).toContain('No call has run');
    expect(artifactEmptyCopy(binding(), false)).toContain('Nothing written yet');
    expect(artifactEmptyCopy(binding({ state: 'ended' }), false)).toContain('no artifacts');
    expect(artifactEmptyCopy(binding(), true)).toContain('Clear the filter');
  });
});

// -------------------------------------------------------------------------------------------------
// Narrow-screen back stack
// -------------------------------------------------------------------------------------------------

describe('single-pane back stack', () => {
  test('drilling in and back restores the scroll position it left', () => {
    let stack = initialPaneStack();
    stack = pushPane(stack, { pane: 'artifacts', agentFilter: ALL_AGENTS }, 120);
    expect(currentPane(stack).pane).toBe('artifacts');
    stack = pushPane(stack, { pane: 'artifact', agentFilter: ALL_AGENTS, artifactId: 'art-1' }, 340);
    stack = popPane(stack);
    expect(currentPane(stack).pane).toBe('artifacts');
    expect(currentPane(stack).scrollTop).toBe(340);
    stack = popPane(stack);
    expect(currentPane(stack)).toEqual({ pane: 'conversation', scrollTop: 120, agentFilter: ALL_AGENTS });
  });

  test('the filter survives a drill-in and comes back with you', () => {
    let stack = setStackFilter(pushPane(initialPaneStack(), { pane: 'artifacts', agentFilter: ALL_AGENTS }, 0), 'wren');
    stack = pushPane(stack, { pane: 'artifact', agentFilter: 'wren', artifactId: 'art-1' }, 40);
    stack = popPane(stack);
    expect(currentPane(stack).agentFilter).toBe('wren');
  });

  test('the conversation is the floor — Escape at the root does not empty the screen', () => {
    expect(popPane(initialPaneStack())).toHaveLength(1);
    expect(currentPane(popPane(initialPaneStack())).pane).toBe('conversation');
  });

  test('re-opening the pane already on top does not stack a duplicate', () => {
    const stack = pushPane(pushPane(initialPaneStack(), { pane: 'artifacts', agentFilter: ALL_AGENTS }, 0), { pane: 'artifacts', agentFilter: ALL_AGENTS }, 10);
    expect(stack).toHaveLength(2);
  });

  test('a phantom artifact pane — its row gone from the index — pops back to something real', () => {
    const stack = pushPane(initialPaneStack(), { pane: 'artifact', agentFilter: ALL_AGENTS, artifactId: 'gone' }, 0);
    const reconciled = reconcileArtifactPane(stack, new Map());
    expect(currentPane(reconciled).pane).toBe('conversation');
  });

  test('an artifact pane whose row IS in the index is left alone — the same stack comes back', () => {
    const rows = new Map(groupArtifacts([artifact({ id: 'art-1' })], 'call-abcdef01').flatMap((group) => group.rows).map((row) => [row.id, row]));
    const stack = pushPane(initialPaneStack(), { pane: 'artifact', agentFilter: ALL_AGENTS, artifactId: 'art-1' }, 0);
    // Same reference, not just an equal one: a caller wiring this into `setState` relies on that to
    // avoid re-rendering (and re-triggering itself) over a no-op.
    expect(reconcileArtifactPane(stack, rows)).toBe(stack);
  });

  test('a non-artifact top is left alone regardless of what the index contains', () => {
    const stack = pushPane(initialPaneStack(), { pane: 'artifacts', agentFilter: ALL_AGENTS }, 0);
    expect(reconcileArtifactPane(stack, new Map())).toBe(stack);
  });
});

// -------------------------------------------------------------------------------------------------
// The call HUD focus target — "Open the call" in a fixed header that never scrolls out of view
// -------------------------------------------------------------------------------------------------

describe('focusHudRegion', () => {
  test('scrolls (harmlessly) and then moves focus, in that order', () => {
    const calls: string[] = [];
    const node = {
      scrollIntoView: (options?: ScrollIntoViewOptions) => calls.push(`scroll:${JSON.stringify(options)}`),
      focus: () => calls.push('focus'),
    };
    focusHudRegion(node);
    expect(calls).toEqual(['scroll:{"block":"nearest"}', 'focus']);
  });

  test('a region with no scrollIntoView still gets focus', () => {
    const calls: string[] = [];
    focusHudRegion({ focus: () => calls.push('focus') });
    expect(calls).toEqual(['focus']);
  });

  test('a not-yet-mounted ref is a no-op rather than a throw', () => {
    expect(() => focusHudRegion(null)).not.toThrow();
    expect(() => focusHudRegion(undefined)).not.toThrow();
  });
});
