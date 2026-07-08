import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { annotationCountByPath, TaskArtifactsRail } from './TaskArtifactsRail';
import type { ArtifactCommentDTO } from '../lib/dto';
import type { PipelineDocument } from './TaskDetail';

function comment(overrides: Partial<ArtifactCommentDTO> & Pick<ArtifactCommentDTO, 'id'>): ArtifactCommentDTO {
  return { repo: '/tmp/repo', subject: 'feat-1', body: 'x', author: 'a', createdAt: 1, ...overrides };
}

describe('annotationCountByPath', () => {
  test('counts only plan-annotation comments, grouped by target doc path', () => {
    const counts = annotationCountByPath([
      comment({ id: 'c1', kind: 'plan-annotation', annotation: { planPath: 'plans/x/design.md' } }),
      comment({ id: 'c2', kind: 'plan-annotation', annotation: { planPath: 'plans/x/design.md' } }),
      comment({ id: 'c3', kind: 'plan-annotation', annotation: { planPath: 'plans/x/research.md' } }),
      comment({ id: 'c4', kind: 'comment' }), // regular task comment — not doc-anchored, excluded
    ]);
    expect(counts.get('plans/x/design.md')).toBe(2);
    expect(counts.get('plans/x/research.md')).toBe(1);
    expect(counts.has('plans/x/other.md')).toBe(false);
  });
});

function doc(overrides: Partial<PipelineDocument> & Pick<PipelineDocument, 'file' | 'path'>): PipelineDocument {
  return { title: overrides.file, content: '', concern: false, ...overrides };
}

describe('TaskArtifactsRail', () => {
  test('shows an empty state with no documents and no done-proof', () => {
    const html = renderToStaticMarkup(<TaskArtifactsRail documents={[]} comments={[]} doneProof={null} selectedPath={null} onSelect={() => {}} />);
    expect(html).toContain('No artifacts yet');
  });

  test('lists each document with its comment-count badge', () => {
    const documents = [doc({ file: 'design-discussion.md', path: 'plans/x/design-discussion.md' })];
    const comments = [comment({ id: 'c1', kind: 'plan-annotation', annotation: { planPath: 'plans/x/design-discussion.md' } })];
    const html = renderToStaticMarkup(<TaskArtifactsRail documents={documents} comments={comments} doneProof={null} selectedPath={null} onSelect={() => {}} />);
    expect(html).toContain('design-discussion.md');
    expect(html).toContain('>1<');
  });

  test('renders the done-proof state when present', () => {
    const html = renderToStaticMarkup(
      <TaskArtifactsRail
        documents={[]}
        comments={[]}
        doneProof={{ branch: 'feat/x', repo: '/tmp', mode: 'pr', commit: 'abcdef1234567', baseRef: 'origin/main', verified: 'green', detail: 'ok', provenAt: Date.now() }}
        selectedPath={null}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('done-proof');
    expect(html).toContain('>GREEN<'); // kit StatusChip uppercases free-text labels
  });

  // TaskDetail now embeds this rail directly in the left pane instead of a fixed-height right
  // column, and hangs the plan-level action row (Implement/Module/…) plus doc-count + prev/next
  // Kbd hints off it — these two slots are the seam that consolidation depends on.
  test('renders a toolbar slot between the header and the document list', () => {
    const html = renderToStaticMarkup(
      <TaskArtifactsRail
        documents={[]}
        comments={[]}
        doneProof={null}
        selectedPath={null}
        onSelect={() => {}}
        toolbar={<div data-testid="plan-actions">Implement</div>}
      />,
    );
    expect(html).toContain('plan-actions');
    expect(html).toContain('Implement');
  });

  test('renders header-slot content passed via `right`', () => {
    const html = renderToStaticMarkup(
      <TaskArtifactsRail
        documents={[doc({ file: '00-overview.md', path: 'plans/x/00-overview.md' })]}
        comments={[]}
        doneProof={null}
        selectedPath={null}
        onSelect={() => {}}
        right={<span>1/3</span>}
      />,
    );
    expect(html).toContain('1/3');
  });

  test('embeds without the standalone rail\'s fixed h-full sizing when className/bodyClassName are overridden', () => {
    const html = renderToStaticMarkup(
      <TaskArtifactsRail documents={[]} comments={[]} doneProof={null} selectedPath={null} onSelect={() => {}} className="" bodyClassName="" />,
    );
    expect(html).not.toContain('h-full');
    expect(html).not.toContain('overflow-y-auto');
  });
});
