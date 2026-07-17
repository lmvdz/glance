import { describe, expect, it } from 'bun:test';
import type { AgentDTO, FeatureDecisionDTO } from './dto';
import {
  whyStopped,
  intervenePrimaryAction,
  diffLineSteerMessage,
  classifyDiffLine,
  splitDiffLines,
  isCommentableLine,
  diffLineStats,
  deltaBullets,
  parseEvidenceAnchor,
  firstEvidenceFile,
  MAX_DELTA_BULLETS,
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

// =================================================================================================
// deltaBullets / parseEvidenceAnchor / firstEvidenceFile (comprehension concern 08)
// =================================================================================================

function decision(over: Partial<FeatureDecisionDTO>): FeatureDecisionDTO {
  return { id: 'd1', text: 'text', ...over };
}

describe('deltaBullets', () => {
  it('returns [] when there are no decisions at all', () => {
    expect(deltaBullets(undefined, 'agent-1')).toEqual([]);
    expect(deltaBullets([], 'agent-1')).toEqual([]);
  });

  it('returns [] when agentId is absent (no bound unit to filter by)', () => {
    const decisions = [decision({ source: 'model-delta', sourceRef: { agentId: 'agent-1' }, evidence: ['a.ts'] })];
    expect(deltaBullets(decisions, undefined)).toEqual([]);
  });

  it('filters to source:"model-delta" AND sourceRef.agentId === agentId — other sources and other units are excluded', () => {
    const decisions = [
      decision({ id: 'plan-1', source: 'plan', text: 'a plan decision' }),
      decision({ id: 'human-1', source: 'human', text: 'a human decision' }),
      decision({ id: 'other-unit', source: 'model-delta', sourceRef: { agentId: 'agent-OTHER' }, evidence: ['x.ts'], text: 'not mine' }),
      decision({ id: 'mine-1', source: 'model-delta', sourceRef: { agentId: 'agent-1' }, evidence: ['y.ts'], text: 'mine' }),
    ];
    const bullets = deltaBullets(decisions, 'agent-1');
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toEqual({ id: 'mine-1', text: 'mine', evidence: ['y.ts'] });
  });

  it('caps at MAX_DELTA_BULLETS, newest (createdAt) first', () => {
    expect(MAX_DELTA_BULLETS).toBe(3);
    const decisions = Array.from({ length: 5 }, (_, i) =>
      decision({ id: `d${i}`, source: 'model-delta', sourceRef: { agentId: 'agent-1' }, evidence: [`f${i}.ts`], createdAt: i, text: `delta ${i}` }),
    );
    const bullets = deltaBullets(decisions, 'agent-1');
    expect(bullets).toHaveLength(3);
    expect(bullets.map((b) => b.id)).toEqual(['d4', 'd3', 'd2']); // newest first
  });

  it('defaults evidence to [] when absent, rather than throwing', () => {
    const decisions = [decision({ id: 'no-ev', source: 'model-delta', sourceRef: { agentId: 'agent-1' } })];
    expect(deltaBullets(decisions, 'agent-1')[0].evidence).toEqual([]);
  });
});

describe('parseEvidenceAnchor', () => {
  it('parses a bare file path with no line range', () => {
    expect(parseEvidenceAnchor('src/a.ts')).toEqual({ file: 'src/a.ts' });
  });

  it('parses a single-line anchor (lineEnd === lineStart)', () => {
    expect(parseEvidenceAnchor('src/a.ts:42')).toEqual({ file: 'src/a.ts', lineStart: 42, lineEnd: 42 });
  });

  it('parses a line-range anchor', () => {
    expect(parseEvidenceAnchor('src/a.ts:10-20')).toEqual({ file: 'src/a.ts', lineStart: 10, lineEnd: 20 });
  });
});

describe('firstEvidenceFile', () => {
  it('returns the first evidence anchor\'s file, ignoring any line range', () => {
    expect(firstEvidenceFile(['src/a.ts:10-20', 'src/b.ts'])).toBe('src/a.ts');
  });

  it('returns undefined for an empty evidence array', () => {
    expect(firstEvidenceFile([])).toBeUndefined();
  });
});
