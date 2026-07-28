import { describe, expect, it } from 'bun:test';
import { calibrationLine, delaySentence, interruptHeadline, leavesSentence, reviewPrompt, unwiredNote, type InterruptState } from './interruptSurface';

const state = (over: Partial<InterruptState> = {}): InterruptState => ({ wired: true, leaves: ['the weekly brief'], recoveryDelayMs: 9 * 60_000, ...over });

describe('interruptHeadline', () => {
  it('leads with the gap when the gate is not connected to anything', () => {
    // "0 sent" from an unwired gate and "0 sent" from a gate that considered and declined are the
    // same number meaning opposite things.
    const line = interruptHeadline(state({ wired: false }));
    expect(line).toContain('is not connected to anything');
    expect(line).toContain('nothing follows you');
  });

  it('defers to the gate’s own sentence once it is wired', () => {
    expect(interruptHeadline(state({ health: { sent: 2, cancelledByDelay: 1, reviewed: 2, worthIt: 2, sentence: 'Two left, both worth it.' } }))).toBe('Two left, both worth it.');
  });

  it('does not report an absence of records as an absence of interruptions', () => {
    expect(interruptHeadline(state())).toContain('Nothing has been recorded');
  });
});

describe('unwiredNote', () => {
  it('calls an unwired gate a gap rather than a policy', () => {
    expect(unwiredNote(state({ wired: false }))).toContain('a gap, not a policy');
  });
  it('is silent once wired', () => {
    expect(unwiredNote(state())).toBeUndefined();
  });
});

describe('leavesSentence', () => {
  it('names what does leave so the page is not read as "nothing reaches me"', () => {
    expect(leavesSentence(['the weekly brief'])).toContain('none of it is about work waiting on you');
  });
  it('says plainly when nothing leaves at all', () => {
    expect(leavesSentence([])).toContain('Every device subscription you have is unused');
  });
});

describe('delaySentence', () => {
  it('justifies the wait rather than stating it', () => {
    const line = delaySentence(9 * 60_000);
    expect(line).toContain('9 minutes');
    expect(line).toContain('optimises for the system’s confidence rather than your evening');
  });
});

describe('calibrationLine', () => {
  it('names unreviewed sends as missing evidence, not as nothing wrong', () => {
    const line = calibrationLine({ sent: 5, cancelledByDelay: 0, reviewed: 2, worthIt: 2, sentence: '' })!;
    expect(line).toContain('3 of 5');
    expect(line).toContain('no evidence of a problem is not evidence of no problem');
  });
  it('is silent when nothing was ever sent', () => {
    expect(calibrationLine({ sent: 0, cancelledByDelay: 3, reviewed: 0, worthIt: 0, sentence: '' })).toBeUndefined();
  });
});

describe('reviewPrompt', () => {
  it('asks a question rather than presenting a survey', () => {
    const line = reviewPrompt({ id: 'a', question: 'wren needs you: Approve plan', sentAt: 1_000_000 }, 1_000_000 + 3 * 60_000);
    expect(line).toContain('Approve plan');
    expect(line).toContain('sent 3 minutes ago');
    expect(line).toContain('Was interrupting you right?');
  });

  it('never says "0 minutes ago"', () => {
    expect(reviewPrompt({ id: 'a', question: 'q', sentAt: 1_000_000 }, 1_000_000)).toContain('1 minute ago');
  });
});

describe('the wired state', () => {
  it('says what leaves once the gate is on, so "on" is not an abstraction', () => {
    const line = leavesSentence(['the weekly brief', 'a question that passes all three conditions']);
    expect(line).toContain('all three conditions');
  });
});
