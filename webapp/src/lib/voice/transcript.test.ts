import { describe, expect, test } from 'bun:test';
import {
  mergeLiveTurn,
  sortTranscriptTurns,
  transcriptEmptyCopy,
  transcriptGapCopy,
  transcriptTurnBody,
  transcriptTurnKey,
  transcriptTurnRegister,
  transcriptTurnSpeakerLabel,
  transcriptTurnStartsNewGroup,
} from './transcript';
import type { VoiceCallTranscriptEntryDTO } from '../api';

function turn(over: Partial<VoiceCallTranscriptEntryDTO> = {}): VoiceCallTranscriptEntryDTO {
  return { callId: 'call-1', turn: 0, role: 'user', final: true, at: 1_000, text: 'hello', ...over };
}

describe('transcriptTurnKey', () => {
  test('keys by (role, turn) — the SAME key the daemon read already collapses by', () => {
    expect(transcriptTurnKey(turn({ role: 'user', turn: 3 }))).toBe(transcriptTurnKey(turn({ role: 'user', turn: 3, text: 'different text, same key' })));
    expect(transcriptTurnKey(turn({ role: 'user', turn: 3 }))).not.toBe(transcriptTurnKey(turn({ role: 'assistant', turn: 3 })));
    expect(transcriptTurnKey(turn({ role: 'user', turn: 3 }))).not.toBe(transcriptTurnKey(turn({ role: 'user', turn: 4 })));
  });
});

describe('sortTranscriptTurns', () => {
  test('orders by `at`, not array position or turn number', () => {
    const rows = [turn({ turn: 5, at: 3_000 }), turn({ turn: 1, at: 1_000 }), turn({ turn: 3, at: 2_000 })];
    expect(sortTranscriptTurns(rows).map((r) => r.turn)).toEqual([1, 3, 5]);
  });

  test('never mutates the input array', () => {
    const rows = [turn({ at: 2 }), turn({ at: 1 })];
    const sorted = sortTranscriptTurns(rows);
    expect(sorted).not.toBe(rows);
    expect(rows.map((r) => r.at)).toEqual([2, 1]);
  });
});

describe('mergeLiveTurn: streaming captions replaced in place, keyed (role, turn)', () => {
  test('a new (role, turn) is inserted in chronological position, not merely appended', () => {
    const existing = [turn({ role: 'user', turn: 0, at: 1_000 }), turn({ role: 'assistant', turn: 1, at: 3_000 })];
    const merged = mergeLiveTurn(existing, turn({ role: 'user', turn: 2, at: 2_000, text: 'in between' }));
    expect(merged.map((t) => `${t.role}:${t.turn}`)).toEqual(['user:0', 'user:2', 'assistant:1']);
  });

  test('a SECOND push for the SAME (role, turn) replaces the row IN PLACE — never a duplicate', () => {
    const existing = [turn({ role: 'assistant', turn: 0, at: 1_000, final: false, text: 'the ans' })];
    const merged = mergeLiveTurn(existing, turn({ role: 'assistant', turn: 0, at: 1_050, final: true, text: 'the answer is yes' }));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ final: true, text: 'the answer is yes' });
  });

  test('replacing in place does not move the row relative to its neighbours', () => {
    const existing = [turn({ role: 'user', turn: 0, at: 1_000 }), turn({ role: 'assistant', turn: 1, at: 2_000, final: false, text: 'partial' }), turn({ role: 'user', turn: 2, at: 3_000 })];
    const merged = mergeLiveTurn(existing, turn({ role: 'assistant', turn: 1, at: 2_000, final: true, text: 'complete' }));
    expect(merged.map((t) => `${t.role}:${t.turn}`)).toEqual(['user:0', 'assistant:1', 'user:2']);
    expect(merged[1]!.text).toBe('complete');
  });

  test('does not mutate the input array', () => {
    const existing = [turn({ role: 'user', turn: 0 })];
    const merged = mergeLiveTurn(existing, turn({ role: 'assistant', turn: 1 }));
    expect(merged).not.toBe(existing);
    expect(existing).toHaveLength(1);
  });
});

describe('transcriptTurnRegister: claim for the agent, nothing for the caller', () => {
  test('assistant turns carry the claim register — the agent\'s own account, recorded not verified', () => {
    expect(transcriptTurnRegister('assistant')).toBe('claim');
  });

  test('user turns carry no register at all — attributed human content, not a claim about it', () => {
    expect(transcriptTurnRegister('user')).toBeUndefined();
  });
});

describe('transcriptTurnSpeakerLabel', () => {
  test('agent vs you', () => {
    expect(transcriptTurnSpeakerLabel('assistant')).toBe('Agent');
    expect(transcriptTurnSpeakerLabel('user')).toBe('You');
  });
});

describe('transcriptTurnBody: honest about redaction', () => {
  test('a redacted turn never shows the absent text as if it were empty speech', () => {
    expect(transcriptTurnBody({ redacted: true, text: undefined })).toContain('Not recorded');
  });

  test('an ordinary turn shows its text', () => {
    expect(transcriptTurnBody({ text: 'hello there' })).toBe('hello there');
  });

  test('a missing text with no redaction flag is an empty string, not a fabricated placeholder', () => {
    expect(transcriptTurnBody({})).toBe('');
  });
});

describe('transcriptGapCopy', () => {
  test('singular vs plural', () => {
    expect(transcriptGapCopy({ missingCount: 1 })).toContain('1 turn was missed');
    expect(transcriptGapCopy({ missingCount: 3 })).toContain('3 turns were missed');
  });
});

describe('transcriptTurnStartsNewGroup', () => {
  test('the first turn always starts a group', () => {
    expect(transcriptTurnStartsNewGroup([turn()], 0)).toBe(true);
  });

  test('consecutive same-role turns with no gap fold into one group', () => {
    const rows = [turn({ role: 'assistant', turn: 0 }), turn({ role: 'assistant', turn: 1 })];
    expect(transcriptTurnStartsNewGroup(rows, 1)).toBe(false);
  });

  test('a role change always starts a new group', () => {
    const rows = [turn({ role: 'user', turn: 0 }), turn({ role: 'assistant', turn: 1 })];
    expect(transcriptTurnStartsNewGroup(rows, 1)).toBe(true);
  });

  test('a turn with a gap marker always starts a new group, even same-role — the gap itself is worth separating', () => {
    const rows = [turn({ role: 'user', turn: 0 }), turn({ role: 'user', turn: 5, gapBefore: { missingCount: 4 } })];
    expect(transcriptTurnStartsNewGroup(rows, 1)).toBe(true);
  });
});

describe('transcriptEmptyCopy: distinct reasons read differently', () => {
  test('loading takes precedence over everything else', () => {
    expect(transcriptEmptyCopy({ hasBinding: true, retentionOff: false, loading: true })).toContain('Reading');
  });

  test('no call ever bound this thread', () => {
    expect(transcriptEmptyCopy({ hasBinding: false, retentionOff: false, loading: false })).toContain('No call has run');
  });

  test('retention off — even with a binding, no turns are ever kept', () => {
    expect(transcriptEmptyCopy({ hasBinding: true, retentionOff: true, loading: false })).toContain('not recording');
  });

  test('a real call, recording, just quiet so far', () => {
    expect(transcriptEmptyCopy({ hasBinding: true, retentionOff: false, loading: false })).toContain('Nothing has been said yet');
  });
});
