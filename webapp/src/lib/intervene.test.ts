import { describe, expect, it } from 'bun:test';
import type { AgentDTO } from './dto';
import {
  whyStopped,
  intervenePrimaryAction,
  diffLineSteerMessage,
  classifyDiffLine,
  splitDiffLines,
  isCommentableLine,
  diffLineStats,
} from './intervene';

// Minimal agent stub — only the fields the pure derivations read.
function agent(over: Partial<AgentDTO>): AgentDTO {
  return { status: 'working', pending: [], ...(over as object) } as AgentDTO;
}

describe('whyStopped', () => {
  it('leads with a pending question above everything else', () => {
    const a = agent({
      status: 'input',
      error: 'boom',
      blockedReason: 'gate',
      pending: [{ id: 'r1', source: 'tool', kind: 'ask', title: 'Which port?', createdAt: 0 }],
    });
    const r = whyStopped(a);
    expect(r.label).toContain('Which port?');
    expect(r.tone).toBe('critical');
  });

  it('surfaces the error first line when errored with no pending', () => {
    const r = whyStopped(agent({ status: 'error', pending: [], error: 'TypeError: x\nstack line' }));
    expect(r.label).toBe('Errored — TypeError: x');
    expect(r.tone).toBe('critical');
  });

  it('reports a validator veto as a warn worth reviewing', () => {
    const r = whyStopped(agent({
      status: 'idle',
      landReady: true,
      validation: { verdict: 'veto', agreement: 1, confidence: 1, perCriterion: [], rationale: 'no tests', ranAt: 0 },
    }));
    expect(r.label).toContain('vetoed');
    // veto must outrank landReady's success tone
    expect(r.tone).toBe('warn');
  });

  it('calls a clean landReady agent ready-to-land (success), not blocked', () => {
    const r = whyStopped(agent({ status: 'idle', landReady: true }));
    expect(r.label).toContain('Ready to land');
    expect(r.tone).toBe('success');
  });

  // Fail-open fix (blind review): a `verdict !== 'veto'` gate reads an "inconclusive" validator hold
  // (eap-borrows follow-up 7 — the land diff couldn't be COMPUTED, an environmental git fault) as a
  // clean pass, so a landReady+inconclusive agent showed the calm "Ready to land" success line even
  // though the last land attempt was actually BLOCKED and retryable.
  it('reports a validator "inconclusive" as a warn hold, never the calm "Ready to land" success line', () => {
    const r = whyStopped(agent({
      status: 'idle',
      landReady: true,
      validation: { verdict: 'inconclusive', agreement: 0, confidence: 0, perCriterion: [], rationale: 'diff fault', ranAt: 0 },
    }));
    expect(r.label).not.toContain('Ready to land');
    expect(r.tone).not.toBe('success');
  });

  it('is calm for a plain working agent', () => {
    expect(whyStopped(agent({ status: 'working', activity: 'editing server.ts' })).label).toBe('Working — editing server.ts');
    expect(whyStopped(agent({ status: 'working' })).tone).toBe('info');
  });
});

describe('intervenePrimaryAction', () => {
  it('answers a pending request', () => {
    expect(intervenePrimaryAction(agent({ pending: [{ id: 'r', source: 'ui', kind: 'ask', title: 't', createdAt: 0 }] }))).toBe('answer');
  });
  it('restarts a dead run', () => {
    expect(intervenePrimaryAction(agent({ status: 'error', pending: [] }))).toBe('restart');
    expect(intervenePrimaryAction(agent({ status: 'stopped', pending: [] }))).toBe('restart');
  });
  it('lands a clean ready run but not a vetoed one', () => {
    expect(intervenePrimaryAction(agent({ status: 'idle', landReady: true }))).toBe('land');
    expect(intervenePrimaryAction(agent({
      status: 'idle', landReady: true,
      validation: { verdict: 'veto', agreement: 1, confidence: 1, perCriterion: [], rationale: '', ranAt: 0 },
    }))).toBe('steer');
  });

  // Fail-open fix: an inconclusive verdict must not offer the "land" primary action either — the last
  // land attempt was actually blocked (retryable), so a `!isVetoed` check alone silently offered "land"
  // on a hold that a force-land can't even bypass.
  it('does not offer "land" on an inconclusive hold', () => {
    expect(intervenePrimaryAction(agent({
      status: 'idle', landReady: true,
      validation: { verdict: 'inconclusive', agreement: 0, confidence: 0, perCriterion: [], rationale: '', ranAt: 0 },
    }))).toBe('steer');
  });
  it('steers a live working agent', () => {
    expect(intervenePrimaryAction(agent({ status: 'working' }))).toBe('steer');
  });
});

describe('diffLineSteerMessage', () => {
  it('embeds the file and the verbatim line, then the comment', () => {
    const msg = diffLineSteerMessage('src/foo.ts', '+  const x = 1', 'use a const-ish name');
    expect(msg).toContain('`src/foo.ts`');
    expect(msg).toContain('+  const x = 1');
    expect(msg).toContain('use a const-ish name');
    // line comes before the comment
    expect(msg.indexOf('const x = 1')).toBeLessThan(msg.indexOf('const-ish'));
  });
  it('trims trailing newlines off the line and whitespace off the comment', () => {
    const msg = diffLineSteerMessage('a.ts', '-old\n\n', '   fix this   ');
    expect(msg).not.toContain('old\n\n\n');
    expect(msg.endsWith('fix this')).toBe(true);
  });
});

describe('classifyDiffLine', () => {
  it('classifies each unified-diff line kind', () => {
    expect(classifyDiffLine('@@ -1,3 +1,4 @@')).toBe('hunk');
    expect(classifyDiffLine('+++ b/a.ts')).toBe('meta');
    expect(classifyDiffLine('--- a/a.ts')).toBe('meta');
    expect(classifyDiffLine('diff --git a/a.ts b/a.ts')).toBe('meta');
    expect(classifyDiffLine('index abc..def 100644')).toBe('meta');
    expect(classifyDiffLine('new file mode 100644')).toBe('meta');
    expect(classifyDiffLine('+added')).toBe('add');
    expect(classifyDiffLine('-removed')).toBe('del');
    expect(classifyDiffLine(' context')).toBe('ctx');
    expect(classifyDiffLine('')).toBe('ctx');
  });

  it('does not mistake +++/--- headers for add/del lines', () => {
    expect(classifyDiffLine('+++ b/x')).not.toBe('add');
    expect(classifyDiffLine('--- a/x')).not.toBe('del');
  });
});

describe('splitDiffLines / diffLineStats', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '@@ -1,2 +1,2 @@',
    ' unchanged',
    '-gone',
    '+added one',
    '+added two',
  ].join('\n');

  it('splits and indexes lines', () => {
    const lines = splitDiffLines(diff);
    expect(lines).toHaveLength(6);
    expect(lines[0].i).toBe(0);
    expect(lines[3].kind).toBe('del');
    expect(lines[4].kind).toBe('add');
  });

  it('returns [] for empty/undefined', () => {
    expect(splitDiffLines(undefined)).toEqual([]);
    expect(splitDiffLines('')).toEqual([]);
  });

  it('counts added/removed for the file chip', () => {
    expect(diffLineStats(diff)).toEqual({ added: 2, removed: 1 });
  });

  it('marks only +/- lines commentable', () => {
    expect(isCommentableLine('add')).toBe(true);
    expect(isCommentableLine('del')).toBe(true);
    expect(isCommentableLine('ctx')).toBe(false);
    expect(isCommentableLine('hunk')).toBe(false);
    expect(isCommentableLine('meta')).toBe(false);
  });
});
