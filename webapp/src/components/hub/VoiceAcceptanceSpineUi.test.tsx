import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceCallHudView } from './VoiceCallHud';
import { VoiceStatusRegion } from './VoiceStatusRegion';
import { VoiceDecisionDoor } from './VoiceDecisionDoor';
import { VoiceArtifactsList } from './VoiceArtifacts';
import { ALL_AGENTS, decisionAnnouncement, decisionDoorModel, groupArtifacts, threadStatus } from '../../lib/voice/roomCall';
import type { VoiceCallArtifactDTO, VoiceCallBindingDTO, VoiceCallDecisionDTO } from '../../lib/api';

/**
 * The webapp half of concern 04's Verify point 9 ("Repeat at a narrow viewport and with reduced
 * motion and screen-reader announcement checks"). `../../../tests/voice-acceptance-spine.test.ts`
 * (the daemon-side spine, a SEPARATE `bun test` process — see that file's own module doc for why a
 * single test run cannot span both) proves the full lifecycle: a call bound to "spine-room" mints a
 * decision — "Deploy the hotfix to prod?", options "Deploy now" / "Hold for review",
 * `requiresConfirmation: true` — and it is resolved by VOICE with the label "Deploy now" after the
 * daemon's own broker corroborates the call's exit (`terminalReason: "broker-exit"`). This file
 * renders the SAME shaped content (the literal prompt/option/label strings below are deliberately
 * identical) through the REAL room components, so a shape drift between what the daemon spine
 * produces and what the webapp actually renders is something a diff between the two files would
 * still catch, even without a shared test run.
 *
 * Follows this package's own established convention for these components (see
 * `VoiceWorkspace.test.tsx`'s module doc): `renderToStaticMarkup`, markup assertions, no jsdom, no
 * browser. "Reduced motion" is proven by the `data-room-workspace` marker that opts a subtree into
 * the site's global `prefers-reduced-motion` stylesheet rule (exactly as `VoiceWorkspace.test.tsx`'s
 * own "the subtree opts into reduced motion" test does for the HUD) — applied here across every
 * component this spine actually renders, not just one. "Narrow viewport" is proven the same way the
 * rest of this suite does: the responsive Tailwind classes (`w-full` collapsing to one pane, the
 * `md:` breakpoint only widening it) are present in the SAME markup a phone and a desktop both
 * receive — there is no separate phone-only render path, which is the point.
 */

const noop = () => {};

// ── The exact shapes `voice-acceptance-spine.test.ts` produces for its first thread's call ────────

const SPINE_BINDING_LIVE: VoiceCallBindingDTO = {
  channelId: 'spine-room',
  callId: 'fake-call-1',
  sessionId: 'live-fake-call-1',
  sessionRoot: '/tmp/voice-spine-session',
  ownerActorId: 'db:alice',
  retention: 'full',
  startedAt: 1_000,
  updatedAt: 1_000,
  state: 'live',
  controlsAvailable: true,
};

const SPINE_BINDING_ENDED: VoiceCallBindingDTO = {
  ...SPINE_BINDING_LIVE,
  state: 'ended',
  terminalReason: 'broker-exit',
  terminalError: null,
  endedAt: 2_000,
  controlsAvailable: false,
};

const SPINE_DECISION_OPEN: VoiceCallDecisionDTO = {
  id: 'fake-decision-1',
  prompt: 'Deploy the hotfix to prod?',
  options: [
    { index: 0, label: 'Deploy now', consequence: 'The hotfix ships to production immediately.' },
    { index: 1, label: 'Hold for review', consequence: 'Nothing changes; the fix waits for a human review.' },
  ],
  requiresConfirmation: true,
  state: 'open',
  createdAt: 1_100,
  updatedAt: 1_100,
};

const SPINE_DECISION_AWAITING: VoiceCallDecisionDTO = { ...SPINE_DECISION_OPEN, state: 'awaiting-confirmation', updatedAt: 1_200 };

const SPINE_DECISION_ANSWERED: VoiceCallDecisionDTO = {
  ...SPINE_DECISION_OPEN,
  state: 'answered',
  updatedAt: 1_300,
  resolution: { optionIndex: 0, label: 'Deploy now', source: 'voice' },
};

const SPINE_ARTIFACT: VoiceCallArtifactDTO = {
  id: 'artifact-1',
  channelId: 'spine-room',
  callId: 'fake-call-1',
  sourcePath: '/tmp/voice-spine-session/findings.md',
  status: 'ready',
  contentHash: 'sha256-spine-findings',
  revision: 1,
  snapshotPath: '/state/voice-calls/spine-room/findings.md',
  copiedAt: 1_150,
};

function assertsReducedMotion(html: string): void {
  expect(html).toContain('data-room-workspace');
}

describe('concern 04 / point 9 — the spine\'s decision door, at a narrow viewport, with reduced motion and screen-reader checks', () => {
  test('an OPEN decision: real keyboard-reachable options, no recommendation pre-selected, one full-width pane on a phone', () => {
    const html = renderToStaticMarkup(
      <VoiceDecisionDoor model={decisionDoorModel(SPINE_DECISION_OPEN)} onChoose={noop} onConfirm={noop} onCancelConfirm={noop} onClose={noop} />,
    );
    assertsReducedMotion(html);
    // Narrow viewport: the SAME markup that renders full-width on a phone widens only past `md:`.
    expect(html).toContain('w-full');
    expect(html).toContain('md:w-[560px]');
    // Real, keyboard-reachable controls — never a div with a click handler standing in for a button.
    expect(html).toContain('<button type="button"');
    expect(html).not.toContain('<div onclick');
    expect(html).toContain('Deploy now');
    expect(html).toContain('Hold for review');
    expect(html).toContain('The hotfix ships to production immediately.');
    // `decisionDoorModel` never invents a recommendation the agent didn't make — see roomCall.test.ts
    // for that guarantee in isolation; here it is proven not to leak a pre-selected control into the
    // actual rendered door for THIS spine's exact decision content.
    expect(html).not.toContain('aria-pressed="true"');
    // The question is announced as the agent's own claim — screen-reader register, not just styling.
    expect(html).toContain('role="note"');
    expect(html).toContain('aria-label="The agent&#x27;s own account"');
  });

  test('AWAITING CONFIRMATION: the door says a second act is still required, same accessibility contract', () => {
    const html = renderToStaticMarkup(
      <VoiceDecisionDoor model={decisionDoorModel(SPINE_DECISION_AWAITING)} onChoose={noop} onConfirm={noop} onCancelConfirm={noop} onClose={noop} />,
    );
    assertsReducedMotion(html);
    expect(html).toContain('w-full');
    expect(html).toContain('md:w-[560px]');
    expect(html).toContain('Deploy now'); // the proposed option stays visible while awaiting confirmation
  });

  test('ANSWERED (by voice): the resolution shows the exact label the human/voice saw, never the consequence text as if it were the answer', () => {
    const html = renderToStaticMarkup(
      <VoiceDecisionDoor model={decisionDoorModel(SPINE_DECISION_ANSWERED)} onChoose={noop} onConfirm={noop} onCancelConfirm={noop} onClose={noop} />,
    );
    assertsReducedMotion(html);
    expect(html).toContain('Deploy now');
    // The delivered attribution is the LABEL, never the agent-authored consequence string dressed up
    // as the answer.
    const doorModel = decisionDoorModel(SPINE_DECISION_ANSWERED);
    expect(doorModel.resolution).toEqual({ label: 'Deploy now', source: 'voice' });
  });
});

describe('concern 04 / point 9 — the status region: screen-reader announcement for this spine\'s decision', () => {
  test('an arriving decision is announced through the polite live region, present even when there is nothing to say', () => {
    const empty = renderToStaticMarkup(<VoiceStatusRegion status={threadStatus({ binding: SPINE_BINDING_LIVE, decisions: [], activeAgents: 0 })} artifactCount={0} />);
    assertsReducedMotion(empty);
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain('role="status"');
    expect(empty).toContain('aria-atomic="true"');

    const announcement = decisionAnnouncement(new Set(), [SPINE_DECISION_OPEN]);
    expect(announcement).toBeTruthy();
    expect(announcement).toContain('Deploy the hotfix to prod?');
    const html = renderToStaticMarkup(
      <VoiceStatusRegion
        status={threadStatus({ binding: SPINE_BINDING_LIVE, decisions: [SPINE_DECISION_OPEN], activeAgents: 0 })}
        announcement={announcement}
        onOpenDecisions={noop}
        artifactCount={1}
      />,
    );
    expect(html).toContain('Deploy the hotfix to prod?');
    // No focus theft — a decision arriving must not steal keyboard focus mid-sentence.
    expect(html).not.toContain('autofocus');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
  });

  test('after the call ends unexpectedly (broker-exit), the status region says so honestly — never that a dead call can reconnect', () => {
    const html = renderToStaticMarkup(<VoiceStatusRegion status={threadStatus({ binding: SPINE_BINDING_ENDED, decisions: [SPINE_DECISION_ANSWERED], activeAgents: 0 })} artifactCount={1} />);
    assertsReducedMotion(html);
    expect(html).toContain('ended unexpectedly');
  });
});

describe('concern 04 / point 9 — the call HUD: honest ended state, reduced motion, real controls', () => {
  test('a live call shows real mute/end controls with labels', () => {
    const html = renderToStaticMarkup(
      <VoiceCallHudView binding={SPINE_BINDING_LIVE} loading={false} starting={false} ending={false} muted={false} muteBusy={false} controlsAvailable now={10_000} onStart={noop} onEnd={noop} onToggleMute={noop} />,
    );
    assertsReducedMotion(html);
    expect(html).toContain('aria-label="Mute the microphone"');
    expect(html).toContain('aria-label="End the call"');
  });

  test('after broker-exit, the HUD reflects the ended state truthfully — no live controls offered on a dead call', () => {
    const html = renderToStaticMarkup(
      <VoiceCallHudView binding={SPINE_BINDING_ENDED} loading={false} starting={false} ending={false} muted={false} muteBusy={false} controlsAvailable={false} now={10_000} onStart={noop} onEnd={noop} onToggleMute={noop} />,
    );
    assertsReducedMotion(html);
    expect(html).not.toContain('aria-label="Mute the microphone"');
    expect(html).not.toContain('aria-label="End the call"');
  });
});

describe('concern 04 / point 9 — the artifacts index: this spine\'s immutable snapshot, narrow viewport, reduced motion', () => {
  test('the findings.md snapshot from this run renders in the current-run group with its pinned content hash', () => {
    const groups = groupArtifacts([SPINE_ARTIFACT], SPINE_ARTIFACT.callId);
    const html = renderToStaticMarkup(
      <VoiceArtifactsList
        groups={groups}
        agentOptions={[ALL_AGENTS]}
        agentFilter={ALL_AGENTS}
        onFilterChange={noop}
        onOpen={noop}
        onClose={noop}
        loading={false}
        binding={SPINE_BINDING_LIVE}
        now={10_000}
        scrollTop={0}
        onScroll={noop}
      />,
    );
    assertsReducedMotion(html);
    expect(html).toContain('THIS RUN');
    expect(html).toContain('findings.md');
    // Only a READY artifact is openable — this spine's snapshot is, so it must be a real control.
    expect(html).toContain('<button');
  });
});
