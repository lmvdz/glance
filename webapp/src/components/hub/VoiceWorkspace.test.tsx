import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceCallHudView } from './VoiceCallHud';
import { VoiceStatusRegion } from './VoiceStatusRegion';
import { VoiceDecisionDoor } from './VoiceDecisionDoor';
import { VoiceArtifactsList, VoiceArtifactViewer } from './VoiceArtifacts';
import { ChannelTimelineRow } from './ChannelTimeline';
import { buildChannelThreadViews, doorLabel } from '../../lib/channelTimeline';
import {
  ALL_AGENTS,
  decisionDoorModel,
  groupArtifacts,
  threadStatus,
  type ArtifactRow,
} from '../../lib/voice/roomCall';
import type { VoiceCallArtifactDTO, VoiceCallBindingDTO, VoiceCallDecisionDTO } from '../../lib/api';
import type { ChannelEntry } from '../../lib/dto';

/**
 * The room-native call workspace, rendered.
 *
 * Markup assertions rather than a driven browser, matching this package's own convention
 * (`renderToStaticMarkup`, no testing-library): the JUDGEMENTS all live in `lib/voice/roomCall.ts`
 * and are tested exhaustively there, so what is left to check here is what actually reaches the
 * DOM — real buttons, announced registers, nothing pre-selected, a live region that exists, and
 * panels that collapse to one pane on a phone.
 */

const noop = () => {};

function binding(over: Partial<VoiceCallBindingDTO> = {}): VoiceCallBindingDTO {
  return {
    channelId: 'room-1',
    callId: 'call-abcdef0123',
    sessionRoot: '/repo',
    ownerActorId: 'web:lars',
    retention: 'full',
    startedAt: 1_000,
    updatedAt: 1_000,
    state: 'live',
    controlsAvailable: true,
    ...over,
  };
}

function decision(over: Partial<VoiceCallDecisionDTO> = {}): VoiceCallDecisionDTO {
  return {
    id: 'dec-1',
    prompt: 'Should the retry budget be per endpoint or global?',
    options: [
      { index: 0, label: 'Per endpoint (recommended)', consequence: 'Each endpoint keeps its own budget.' },
      { index: 1, label: 'Global', consequence: 'One budget for everything.' },
    ],
    requiresConfirmation: false,
    state: 'open',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

const hudProps = {
  binding: null as VoiceCallBindingDTO | null,
  starting: false,
  ending: false,
  muted: false,
  muteBusy: false,
  controlsAvailable: false,
  now: 10_000,
  onStart: noop,
  onEnd: noop,
  onToggleMute: noop,
};

const doorProps = {
  model: decisionDoorModel(decision()),
  onChoose: noop,
  onConfirm: noop,
  onCancelConfirm: noop,
  onClose: noop,
};

function artifact(over: Partial<VoiceCallArtifactDTO> = {}): VoiceCallArtifactDTO {
  return {
    id: 'art-1',
    channelId: 'room-1',
    callId: 'call-abcdef0123',
    sourcePath: '/repo/NOTES.md',
    status: 'ready',
    contentHash: 'deadbeefcafe',
    revision: 1,
    snapshotPath: '/state/x/NOTES.md',
    copiedAt: 5_000,
    ...over,
  };
}

const listProps = {
  agentOptions: [ALL_AGENTS, 'wren'],
  agentFilter: ALL_AGENTS,
  onFilterChange: noop,
  onOpen: noop,
  onClose: noop,
  loading: false,
  binding: binding(),
  now: 10_000,
  scrollTop: 0,
  onScroll: noop,
};

// -------------------------------------------------------------------------------------------------
// The call HUD — the room's one call entry
// -------------------------------------------------------------------------------------------------

describe('VoiceCallHudView', () => {
  test('with no call it offers to start one, and says where the older dispatcher went', () => {
    const html = renderToStaticMarkup(<VoiceCallHudView {...hudProps} />);
    expect(html).toContain('Start a call');
    expect(html).toContain('No call is bound to this thread.');
    // Concern 05: the S2S lane is kept, outside room calls only.
    expect(html).toContain('outside a room');
    expect(html).not.toContain('aria-label="End the call"');
  });

  test('a live call shows mute and end, both real buttons with labels', () => {
    const html = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding()} controlsAvailable />);
    expect(html).toContain('aria-label="Mute the microphone"');
    expect(html).toContain('aria-label="End the call"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('Start a call');
    // Open mic, not push-to-talk: there is no hold-to-talk control in this lane at all.
    expect(html).not.toContain('Push to talk');
  });

  test('mute is refused honestly when there is no live socket', () => {
    const html = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding({ state: 'degraded' })} controlsAvailable={false} />);
    expect(html).toContain('disabled');
    expect(html).toContain('no live socket');
  });

  test('recording state is visible at call start, with the concern-05 default spelled out', () => {
    const html = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding({ retention: 'full' })} controlsAvailable />);
    expect(html).toContain('Recording in full');
    expect(html).toContain('durable record');
  });

  test('a retention mismatch is an ALERT that shows what the session reports', () => {
    const html = renderToStaticMarkup(
      <VoiceCallHudView {...hudProps} binding={binding({ retention: 'full', retentionMismatch: { expected: 'full', reported: 'tails' } })} controlsAvailable />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Recording tails only');
    expect(html).toContain('&quot;full&quot;');
  });

  test('the phase box reserves a fixed width, so the chrome does not reflow', () => {
    const connecting = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding({ state: 'connecting' })} />);
    const ended = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding({ state: 'ended', terminalReason: 'operator-ended' })} />);
    expect(connecting).toContain('min-width:10ch');
    expect(ended).toContain('min-width:10ch');
  });

  test('the idle policy is stated while a call is up (concern 05: 10 minutes)', () => {
    const html = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding()} controlsAvailable lastActivityAt={10_000} />);
    expect(html).toContain('10 minutes');
    expect(html).toContain('spoken warning');
  });

  test('the binding banner proves which session this thread is pinned to', () => {
    const html = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding({ sessionId: 'sess-7' })} controlsAvailable />);
    expect(html).toContain('call call-abcdef0123 · session sess-7');
    const unpinned = renderToStaticMarkup(<VoiceCallHudView {...hudProps} binding={binding({ state: 'connecting', sessionId: undefined })} />);
    expect(unpinned).toContain('not pinned yet');
  });

  test('a start failure is shown in place rather than flashed away', () => {
    const html = renderToStaticMarkup(<VoiceCallHudView {...hudProps} error="The call did not start: broker refused" />);
    expect(html).toContain('broker refused');
    expect(html).toContain('role="alert"');
  });

  test('the subtree opts into reduced motion', () => {
    expect(renderToStaticMarkup(<VoiceCallHudView {...hudProps} />)).toContain('data-room-workspace');
  });
});

// -------------------------------------------------------------------------------------------------
// The status region and its live announcement
// -------------------------------------------------------------------------------------------------

describe('VoiceStatusRegion', () => {
  test('the polite live region exists even when there is nothing to say', () => {
    const html = renderToStaticMarkup(<VoiceStatusRegion status={threadStatus({ binding: binding(), decisions: [], activeAgents: 0 })} artifactCount={0} />);
    // Mounted for the life of the room: a live region created at the same instant its text appears
    // is routinely missed by screen readers.
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-atomic="true"');
  });

  test('an arriving decision announces itself and steals nothing', () => {
    const html = renderToStaticMarkup(
      <VoiceStatusRegion
        status={threadStatus({ binding: binding(), decisions: [decision({ requiresConfirmation: true })], activeAgents: 0 })}
        chipLabel="1 waiting on you"
        announcement="A decision is waiting: Should the retry budget be per endpoint or global?"
        onOpenDecisions={noop}
        artifactCount={2}
      />,
    );
    expect(html).toContain('A decision is waiting');
    expect(html).toContain('1 waiting on you');
    // No focus theft: nothing autofocuses, nothing is a dialog, nothing traps.
    expect(html).not.toContain('autofocus');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
  });

  test('the chip is silent when nothing is waiting', () => {
    const html = renderToStaticMarkup(<VoiceStatusRegion status={threadStatus({ binding: binding(), decisions: [], activeAgents: 0 })} onOpenDecisions={noop} artifactCount={0} />);
    expect(html).toContain('All clear.');
    // No chip at all — the only mention of "waiting" is the all-clear line saying there is none.
    expect(html).not.toContain('rounded-full');
  });
});

// -------------------------------------------------------------------------------------------------
// The decision door
// -------------------------------------------------------------------------------------------------

describe('VoiceDecisionDoor', () => {
  test('the question is announced as the agent’s claim, in italic', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} />);
    expect(html).toContain('role="note"');
    expect(html).toContain('aria-label="The agent&#x27;s own account"');
    expect(html).toContain('font-style:italic');
    // The claim styling must not be paid for with a second opacity over the muted body.
    expect(html).not.toContain('opacity:0.6');
  });

  test('every control in the door shows a focus ring — none is suppressed', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} />);
    // `outline-none` with nothing in its place is an invisible focus target. Every element that
    // suppresses the default outline must put a ring back.
    for (const fragment of html.split('class="').slice(1)) {
      const classes = fragment.slice(0, fragment.indexOf('"'));
      if (classes.includes('focus-visible:outline-none')) expect(classes).toContain('focus-visible:ring-2');
    }
  });

  test('options are real, keyboard-reachable buttons with their consequences', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} />);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('Each endpoint keeps its own budget.');
    expect(html).toContain('One budget for everything.');
    // Real buttons, so Tab/Enter/Space work for free — never a div with a click handler.
    expect(html).not.toContain('<div onclick');
  });

  test('NOTHING is pre-selected, including the recommendation', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} />);
    expect(html).toContain('it recommends this');
    // No radio group (whose members select on arrow-in), no checked state, no autofocus, no default.
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('checked');
    expect(html).not.toContain('aria-checked');
    expect(html).not.toContain('autofocus');
    expect(html).not.toContain('aria-selected="true"');
    expect(html).not.toContain('defaultChecked');
  });

  test('the confirmation state is rendered from the daemon, with its own act', () => {
    const html = renderToStaticMarkup(
      <VoiceDecisionDoor {...doorProps} model={decisionDoorModel(decision({ state: 'awaiting-confirmation', requiresConfirmation: true }))} />,
    );
    expect(html).toContain('CONFIRM IT');
    expect(html).toContain('>Confirm</button>');
    expect(html).toContain('Waiting for you to confirm');
    // Voice and click share one confirmation state — the copy says so, so nobody confirms twice.
    expect(html).toContain('only counts once');
  });

  test('a competing resolution reports its ACTUAL reason', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} refusal="This was already resolved. Someone else answered it, or the call ended before your answer landed." />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('already resolved');
    expect(html).not.toContain('Try again');
  });

  test('a resolved decision is inspect-only — the record, with nothing left to press', () => {
    const html = renderToStaticMarkup(
      <VoiceDecisionDoor {...doorProps} model={decisionDoorModel(decision({ state: 'answered', resolution: { optionIndex: 0, label: 'Per endpoint', source: 'voice' } }))} />,
    );
    expect(html).toContain('DECIDED');
    expect(html).toContain('chosen');
    expect(html).toContain('answered out loud');
    // The options are still readable — but as a record, not as controls.
    expect(html).toContain('Global');
    expect(html).not.toContain('it recommends this');
  });

  test('a UI-only decision says it is answered by hand (concern 05)', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} model={decisionDoorModel(decision({ prompt: 'Merge and publish 3.2?' }))} />);
    expect(html).toContain('never resolved by voice');
  });

  test('an option-less question says so rather than inventing choices', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} model={decisionDoorModel(decision({ options: [] }))} />);
    expect(html).toContain('will not invent choices');
  });

  test('provenance names the call the question came from', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} callId="call-abcdef0123" agentLabel="the call" />);
    expect(html).toContain('call call-abc');
  });

  test('it is one full-width pane on a phone and a side panel on a desktop', () => {
    const html = renderToStaticMarkup(<VoiceDecisionDoor {...doorProps} />);
    expect(html).toContain('w-full');
    expect(html).toContain('md:w-[560px]');
  });
});

// -------------------------------------------------------------------------------------------------
// Artifacts
// -------------------------------------------------------------------------------------------------

describe('VoiceArtifactsList', () => {
  const groups = (artifacts: VoiceCallArtifactDTO[], filter = ALL_AGENTS) => groupArtifacts(artifacts, 'call-abcdef0123', filter);

  test('the current run is labelled as such', () => {
    const html = renderToStaticMarkup(<VoiceArtifactsList {...listProps} groups={groups([artifact()])} />);
    expect(html).toContain('THIS RUN');
    expect(html).toContain('NOTES.md');
  });

  test('the filter defaults to all agents and is a labelled control', () => {
    const html = renderToStaticMarkup(<VoiceArtifactsList {...listProps} groups={groups([artifact()])} />);
    expect(html).toContain('for="voice-artifact-agent"');
    expect(html).toContain('All agents');
    expect(html).toContain('<option value="all"');
  });

  test('only a ready artifact is openable; the others are stated, not offered', () => {
    const html = renderToStaticMarkup(
      <VoiceArtifactsList
        {...listProps}
        groups={groups([
          artifact({ id: 'ok' }),
          artifact({ id: 'gone', sourcePath: '/repo/gone.md', status: 'failed', error: 'enoent: artifact path does not exist', snapshotPath: undefined }),
        ])}
      />,
    );
    expect(html).toContain('gone.md');
    expect(html).toContain('does not exist');
    // One button for the readable one; the missing row is inert rather than a control that does
    // nothing when pressed.
    expect(html.match(/<button type="button" class="flex w-full items-start/g) ?? []).toHaveLength(1);
  });

  test('a filtered-empty index says how to get back to the rest', () => {
    const html = renderToStaticMarkup(<VoiceArtifactsList {...listProps} agentFilter="wren" groups={groups([artifact()], 'wren')} />);
    expect(html).toContain('Clear the filter');
  });

  test('loading shows skeletons rather than a bare spinner', () => {
    const html = renderToStaticMarkup(<VoiceArtifactsList {...listProps} loading groups={[]} />);
    expect(html).toContain('skeleton');
    expect(html).toContain('aria-label="Loading artifacts"');
  });

  test('a read error is an alert with a recovery-shaped sentence', () => {
    const html = renderToStaticMarkup(<VoiceArtifactsList {...listProps} groups={[]} error="The artifact index could not be read." />);
    expect(html).toContain('role="alert"');
  });
});

describe('VoiceArtifactViewer', () => {
  const row: ArtifactRow = {
    id: 'art-1',
    name: 'NOTES.md',
    path: '/repo/NOTES.md',
    callId: 'call-abcdef0123',
    state: 'ready',
    agent: 'session',
    revision: 1,
    contentHash: 'deadbeefcafe',
    copiedAt: 5_000,
    superseded: false,
  };

  test('markdown renders through the room’s existing stack', () => {
    const html = renderToStaticMarkup(<VoiceArtifactViewer row={row} content={'# Heading\n\nsome prose'} loading={false} onBack={noop} />);
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('some prose');
  });

  test('a javascript: link in a snapshot stays inert', () => {
    // The snapshot is agent-produced content, so it goes through the SAME sanitization every other
    // markdown lane uses — this is a host document viewer, not a new rendering path.
    const html = renderToStaticMarkup(<VoiceArtifactViewer row={row} content={'[click me](javascript:alert(1))'} loading={false} onBack={noop} />);
    expect(html).not.toContain('javascript:alert');
  });

  test('a vanished snapshot reads as a fault, never as an empty document', () => {
    const html = renderToStaticMarkup(<VoiceArtifactViewer row={row} loading={false} failure={{ reason: 'missing', detail: 'the snapshot file is gone: /state/x/NOTES.md' }} onBack={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('no longer where it was written');
    expect(html).toContain('/state/x/NOTES.md');
  });

  test('a genuinely empty snapshot says that instead of showing nothing', () => {
    const html = renderToStaticMarkup(<VoiceArtifactViewer row={row} content="" loading={false} onBack={noop} />);
    expect(html).toContain('This snapshot is empty');
  });

  test('back is a real control and the pane is full-width on a phone', () => {
    const html = renderToStaticMarkup(<VoiceArtifactViewer row={row} content="x" loading={false} onBack={noop} />);
    expect(html).toContain('>back');
    expect(html).toContain('md:w-[520px]');
    expect(html).toContain('w-full');
  });
});

// -------------------------------------------------------------------------------------------------
// The timeline's typed voice faces
// -------------------------------------------------------------------------------------------------

function entry(over: Partial<ChannelEntry> = {}): ChannelEntry {
  return {
    id: 'e1',
    seq: 1,
    channelId: 'room-1',
    authorActor: 'manager',
    kind: 'system',
    text: '',
    ts: 1_700_000_000_000,
    status: 'ok',
    format: 'markdown',
    ...over,
  } as ChannelEntry;
}

const voiceDecisionEntry = entry({
  id: 'e-dec',
  text: 'Should the retry budget be per endpoint or global?',
  event: {
    kind: 'voice-decision',
    issuer: 'manager',
    payload: {
      refs: { callId: 'call-abcdef0123', decisionId: 'dec-1' },
      face: { title: 'Should the retry budget be per endpoint or global?', status: 'open', tone: 'warning', register: 'claim' },
    },
  },
});

const voiceCallEntry = entry({
  id: 'e-call',
  text: 'voice call live',
  event: { kind: 'voice-call', issuer: 'manager', payload: { refs: { callId: 'call-abcdef0123' }, face: { title: 'Call live', status: 'live' } } },
});

describe('the timeline’s voice cards', () => {
  test('the decision card’s door says "Answer the question", distinct from the fleet’s', () => {
    expect(doorLabel('voice-decision')).toBe('Answer the question');
    expect(doorLabel('needs-you')).toBe('Answer it');
    const view = buildChannelThreadViews([voiceDecisionEntry])[0]!;
    const html = renderToStaticMarkup(<ChannelTimelineRow view={view} onAnswerDecision={noop} />);
    expect(html).toContain('Answer the question');
  });

  test('the decision card renders its question as the agent’s announced claim', () => {
    const view = buildChannelThreadViews([voiceDecisionEntry])[0]!;
    expect(view.register).toBe('claim');
    const html = renderToStaticMarkup(<ChannelTimelineRow view={view} onAnswerDecision={noop} />);
    expect(html).toContain('role="note"');
    expect(html).toContain('font-style:italic');
    expect(html).toContain('the agent says');
  });

  test('both voice cards print their call, so a card is never a floating sentence', () => {
    const decisionHtml = renderToStaticMarkup(<ChannelTimelineRow view={buildChannelThreadViews([voiceDecisionEntry])[0]!} onAnswerDecision={noop} />);
    expect(decisionHtml).toContain('call call-abc');
    expect(decisionHtml).toContain('question dec-1');
    const callHtml = renderToStaticMarkup(<ChannelTimelineRow view={buildChannelThreadViews([voiceCallEntry])[0]!} onOpenCall={noop} />);
    expect(callHtml).toContain('call call-abc');
    expect(callHtml).toContain('Open the call');
  });

  test('a raw yield or empty activity event never becomes a card', () => {
    const views = buildChannelThreadViews([
      entry({ id: 'y', text: '', event: { kind: 'yield', issuer: 'manager', payload: {} } }),
      entry({ id: 'h', text: '', event: { kind: 'heartbeat', issuer: 'manager', payload: {} } }),
      entry({ id: 'empty', text: '   ', event: { kind: 'unit-progress', issuer: 'manager', payload: {} } }),
      voiceCallEntry,
    ]);
    expect(views.map((view) => view.id)).toEqual(['e-call']);
  });

  test('a voice card is visually distinct from the fleet’s needs-you', () => {
    const needsYou = renderToStaticMarkup(
      <ChannelTimelineRow
        view={buildChannelThreadViews([
          entry({ id: 'n', text: 'Which budget?', event: { kind: 'needs-you', issuer: 'manager', payload: { refs: { unitId: 'wren' }, face: { title: 'Which budget?' } } } }),
        ])[0]!}
        onAnswer={noop}
      />,
    );
    const voice = renderToStaticMarkup(<ChannelTimelineRow view={buildChannelThreadViews([voiceDecisionEntry])[0]!} onAnswerDecision={noop} />);
    expect(needsYou).toContain('Answer it');
    expect(needsYou).not.toContain('role="note"');
    expect(voice).toContain('Answer the question');
    // Different icons: ShieldAlert for the fleet, ShieldQuestion for the call.
    expect(needsYou).not.toBe(voice);
  });
});

// -------------------------------------------------------------------------------------------------
// The whole arc, in one thread
// -------------------------------------------------------------------------------------------------

describe('a call through its whole life stays one chronological conversation', () => {
  test('start → work → artifact → decision → confirmation → resolution → end', () => {
    const at = (seq: number) => 1_700_000_000_000 + seq * 1_000;
    const timeline: ChannelEntry[] = [
      entry({ id: '1', seq: 1, ts: at(1), kind: 'user', authorActor: 'web:lars', text: 'Let’s get the retry work moving.' }),
      entry({ id: '2', seq: 2, ts: at(2), event: { kind: 'voice-call', issuer: 'manager', payload: { refs: { callId: 'c1' }, face: { title: 'Call connecting', status: 'connecting' } } } }),
      entry({ id: '3', seq: 3, ts: at(3), event: { kind: 'voice-call', issuer: 'manager', payload: { refs: { callId: 'c1' }, face: { title: 'Call live', status: 'live' } } } }),
      // Raw bookkeeping in the middle of the arc — present on the wire, absent from the room.
      entry({ id: 'raw', seq: 4, ts: at(4), event: { kind: 'yield', issuer: 'manager', payload: {} } }),
      entry({ id: '5', seq: 5, ts: at(5), text: 'Wrote NOTES.md', event: { kind: 'unit-turn-finished', issuer: 'manager', payload: { refs: { unitId: 'wren' }, face: { title: 'Wrote NOTES.md' } } } }),
      entry({ id: '6', seq: 6, ts: at(6), text: 'Per endpoint or global?', event: { kind: 'voice-decision', issuer: 'manager', payload: { refs: { callId: 'c1', decisionId: 'd1' }, face: { title: 'Per endpoint or global?', status: 'open', register: 'claim' } } } }),
      entry({ id: '7', seq: 7, ts: at(7), text: 'Resolved · Per endpoint', event: { kind: 'voice-decision', issuer: 'manager', payload: { refs: { callId: 'c1', decisionId: 'd1' }, face: { title: 'Resolved · Per endpoint', status: 'answered', tone: 'success', register: 'claim' } } } }),
      entry({ id: '8', seq: 8, ts: at(8), event: { kind: 'voice-call', issuer: 'manager', payload: { refs: { callId: 'c1' }, face: { title: 'Call ended (operator-ended)', status: 'ended' } } } }),
    ];

    const views = buildChannelThreadViews(timeline);
    // One surface, in order, with the raw event gone and nothing duplicated.
    expect(views.map((view) => view.id)).toEqual(['1', '2', '3', '5', '6', '7', '8']);
    expect(views.map((view) => view.entry.ts)).toEqual([...views.map((view) => view.entry.ts)].sort((a, b) => a - b));

    // The status region tells the truth at each stage of the same arc.
    const decisions: VoiceCallDecisionDTO[] = [decision({ id: 'd1', requiresConfirmation: true })];
    expect(threadStatus({ binding: binding({ state: 'connecting' }), decisions: [], activeAgents: 0 }).kind).toBe('all-clear');
    expect(threadStatus({ binding: binding(), decisions, activeAgents: 1 }).kind).toBe('open-decisions');
    expect(threadStatus({ binding: binding(), decisions: [decision({ id: 'd1', state: 'awaiting-confirmation' })], activeAgents: 1 }).kind).toBe('open-decisions');
    expect(threadStatus({ binding: binding(), decisions: [decision({ id: 'd1', state: 'answered' })], activeAgents: 1 }).kind).toBe('active-agents');
    expect(threadStatus({ binding: binding({ state: 'ended', terminalReason: 'operator-ended' }), decisions: [decision({ id: 'd1', state: 'answered' })], activeAgents: 0 }).kind).toBe('all-clear');

    // And the artifact the run produced is in the index, on the current run.
    const index = groupArtifacts([artifact({ callId: 'call-abcdef0123' })], 'call-abcdef0123');
    expect(index[0]!.current).toBe(true);
    expect(index[0]!.rows[0]!.name).toBe('NOTES.md');
  });
});
