import { describe, expect, it } from 'bun:test';
import type { ArtifactCommentDTO } from './dto';
import {
  parseHeadings,
  commentsForDoc,
  reviewProgress,
  reviewGateOpen,
  reviewNarration,
  headingForComment,
  groupCommentsByHeading,
  lastSeenKey,
  parseReviewHash,
  buildReviewHash,
  parseDocChanges,
  sectionSegments,
  unlocatedChanges,
  changedHeadings,
} from './plan-doc-review';

const DOC = `# sidebar-consolidation

## Summary

Some summary text.

## Current State

- item one
- item two

## Desired End State

- Shared SidebarWidget with tabs
`;

function comment(over: Partial<ArtifactCommentDTO>): ArtifactCommentDTO {
  return {
    id: 'c1',
    repo: '/repo',
    subject: 'feat-1',
    body: 'a note',
    author: 'kyle',
    createdAt: 1,
    kind: 'plan-annotation',
    annotation: { planPath: 'plans/x/01.md' },
    ...over,
  };
}

describe('parseHeadings', () => {
  it('splits on H2 and computes body ranges up to the next H2', () => {
    const headings = parseHeadings(DOC);
    expect(headings.map((h) => h.heading)).toEqual(['Summary', 'Current State', 'Desired End State']);
    // "Current State" body should span from its own heading line+1 to just before "Desired End State"
    const current = headings.find((h) => h.heading === 'Current State')!;
    const desired = headings.find((h) => h.heading === 'Desired End State')!;
    expect(current.bodyEnd).toBe(desired.line - 1);
  });

  it('returns no headings for a doc with none', () => {
    expect(parseHeadings('# Title\n\nplain text\n')).toEqual([]);
  });
});

describe('commentsForDoc / reviewProgress / reviewGateOpen', () => {
  it('scopes to plan-annotation comments on the exact doc path, ignoring other subjects/kinds', () => {
    const comments: ArtifactCommentDTO[] = [
      comment({ id: 'a', createdAt: 2 }),
      comment({ id: 'b', createdAt: 1, kind: 'comment', annotation: undefined }),
      comment({ id: 'c', createdAt: 3, annotation: { planPath: 'plans/x/other.md' } }),
    ];
    const forDoc = commentsForDoc(comments, 'plans/x/01.md');
    expect(forDoc.map((c) => c.id)).toEqual(['a']);
  });

  it('sorts oldest-first and derives N/M resolved', () => {
    const comments: ArtifactCommentDTO[] = [
      comment({ id: 'a', createdAt: 2 }),
      comment({ id: 'b', createdAt: 1, resolvedAt: 5 }),
    ];
    const ordered = commentsForDoc(comments, 'plans/x/01.md');
    expect(ordered.map((c) => c.id)).toEqual(['b', 'a']);
    expect(reviewProgress(comments, 'plans/x/01.md')).toEqual({ resolved: 1, total: 2 });
  });

  it('the gate is closed with zero comments and only opens when every comment resolves', () => {
    expect(reviewGateOpen([], 'plans/x/01.md')).toBe(false);
    const unresolved = [comment({ id: 'a' })];
    expect(reviewGateOpen(unresolved, 'plans/x/01.md')).toBe(false);
    const allResolved = [comment({ id: 'a', resolvedAt: 9 }), comment({ id: 'b', resolvedAt: 9 })];
    expect(reviewGateOpen(allResolved, 'plans/x/01.md')).toBe(true);
  });
});

describe('reviewNarration', () => {
  it('is empty with no comments and echoes the newest comment otherwise', () => {
    expect(reviewNarration([], 'plans/x/01.md')).toBe('');
    const comments = [comment({ id: 'a', createdAt: 1, body: 'first' }), comment({ id: 'b', createdAt: 2, body: 'Agent flips the layout' })];
    expect(reviewNarration(comments, 'plans/x/01.md')).toBe('Agent flips the layout');
  });

  it('truncates a long first line', () => {
    const long = 'x'.repeat(120);
    expect(reviewNarration([comment({ body: long })], 'plans/x/01.md').length).toBeLessThanOrEqual(90);
  });
});

describe('headingForComment / groupCommentsByHeading', () => {
  const headings = parseHeadings(DOC);

  it('prefers an explicit heading anchor over a line-derived one', () => {
    const c = comment({ annotation: { planPath: 'plans/x/01.md', heading: 'Desired End State', lineStart: 5 } });
    expect(headingForComment(c, headings)).toBe('Desired End State');
  });

  it('falls back to resolving lineStart against section body ranges', () => {
    const currentStateLine = headings.find((h) => h.heading === 'Current State')!.bodyStart;
    const c = comment({ annotation: { planPath: 'plans/x/01.md', lineStart: currentStateLine } });
    expect(headingForComment(c, headings)).toBe('Current State');
  });

  it('is undefined with no annotation info to resolve', () => {
    expect(headingForComment(comment({ annotation: { planPath: 'plans/x/01.md' } }), headings)).toBeUndefined();
  });

  it('groups comments under their resolved heading, unresolved ones under ""', () => {
    const comments = [
      comment({ id: 'a', annotation: { planPath: 'plans/x/01.md', heading: 'Summary' } }),
      comment({ id: 'b', annotation: { planPath: 'plans/x/01.md' } }),
    ];
    const grouped = groupCommentsByHeading(comments, 'plans/x/01.md', headings);
    expect(grouped.get('Summary')?.map((c) => c.id)).toEqual(['a']);
    expect(grouped.get('')?.map((c) => c.id)).toEqual(['b']);
  });
});

describe('lastSeenKey', () => {
  it('is stable and distinct per (repo, doc) pair', () => {
    expect(lastSeenKey('/repo', 'plans/x/01.md')).toBe(lastSeenKey('/repo', 'plans/x/01.md'));
    expect(lastSeenKey('/repo', 'plans/x/01.md')).not.toBe(lastSeenKey('/repo', 'plans/x/02.md'));
  });
});

describe('review hash route', () => {
  it('round-trips taskId + docPath through the hash', () => {
    const loc = { taskId: 'feat-42', docPath: 'plans/x/01.md' };
    expect(parseReviewHash(buildReviewHash(loc))).toEqual(loc);
  });

  it('round-trips a bare taskId with no doc', () => {
    const loc = { taskId: 'feat-42' };
    expect(parseReviewHash(buildReviewHash(loc))).toEqual({ taskId: 'feat-42', docPath: undefined });
  });

  it('rejects a hash that is not a review deep link', () => {
    expect(parseReviewHash('#/tasks')).toBeUndefined();
    expect(parseReviewHash('')).toBeUndefined();
  });
});

describe('parseDocChanges', () => {
  const DIFF = [
    'diff --git a/doc.md b/doc.md',
    'index 111..222 100644',
    '--- a/doc.md',
    '+++ b/doc.md',
    '@@ -3,3 +3,3 @@',
    ' context line',
    '-old line',
    '+new line',
    ' trailing context',
  ].join('\n');

  it('anchors del/ins pairs at the same current-doc line', () => {
    const changes = parseDocChanges(DIFF)!;
    expect(changes).toEqual([
      { line: 4, kind: 'del', text: 'old line' },
      { line: 4, kind: 'ins', text: 'new line' },
    ]);
  });

  it('is [] for an empty diff and undefined on a malformed hunk header', () => {
    expect(parseDocChanges('')).toEqual([]);
    expect(parseDocChanges('@@ bogus @@\n stuff')).toBeUndefined();
  });

  it('rejects unexpected line prefixes inside a hunk', () => {
    expect(parseDocChanges('@@ -1,1 +1,1 @@\n?weird')).toBeUndefined();
  });
});

describe('sectionSegments / unlocatedChanges / changedHeadings', () => {
  // Current doc: 1:# T, 2:'', 3:## A, 4:kept, 5:new line, 6:'', 7:## B, 8:same
  const docLines = ['# T', '', '## A', 'kept', 'new line', '', '## B', 'same'];
  const headings = parseHeadings(docLines.join('\n'));
  const changes = [
    { line: 5, kind: 'del' as const, text: 'old line' },
    { line: 5, kind: 'ins' as const, text: 'new line' },
  ];

  it('interleaves markdown runs with in-place change rows', () => {
    const a = headings.find((h) => h.heading === 'A')!;
    const segments = sectionSegments(docLines, a.bodyStart, a.bodyEnd, changes);
    expect(segments).toEqual([
      { kind: 'md', text: 'kept' },
      { kind: 'changes', rows: changes },
      { kind: 'md', text: '' },
    ]);
  });

  it('an unchanged section is one markdown run', () => {
    const b = headings.find((h) => h.heading === 'B')!;
    expect(sectionSegments(docLines, b.bodyStart, b.bodyEnd, changes)).toEqual([{ kind: 'md', text: 'same' }]);
  });

  it('emits a trailing del anchored just past the body', () => {
    const b = headings.find((h) => h.heading === 'B')!;
    const trailing = [{ line: b.bodyEnd + 1, kind: 'del' as const, text: 'removed tail' }];
    const segments = sectionSegments(docLines, b.bodyStart, b.bodyEnd, trailing);
    expect(segments[segments.length - 1]).toEqual({ kind: 'changes', rows: trailing });
  });

  it('flags preamble changes as unlocated and marks only changed headings', () => {
    const preamble = [{ line: 1, kind: 'ins' as const, text: '# T2' }];
    expect(unlocatedChanges([...changes, ...preamble], headings)).toEqual(preamble);
    expect(changedHeadings(changes, headings)).toEqual(new Set(['A']));
  });
});
