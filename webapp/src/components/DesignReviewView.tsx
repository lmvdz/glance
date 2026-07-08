/**
 * DesignReviewView — the collaborative design-review loop (`/review/:taskId`).
 *
 * Reference: plans/orchestration/UI-REFERENCES.md system B — a living design doc reviewed by
 * humans + agent together: fixed-by-convention section skeleton, a right comments rail, a top
 * "Design Review N/M resolved" progress bar with a narration line, and a terminal
 * "All comments resolved — ready to implement!" gate. This is v1, scoped to real existing data:
 *
 * - The doc: one plan-dir markdown file, read via GET /api/plan-doc (path-guarded single-file
 *   read this unit added — src/plan-doc.ts).
 * - Comments: the EXISTING plan-annotation surface (src/comments.ts's PlanAnnotationTarget +
 *   /api/features/:id/annotations, shipped well before this unit) extended with one new optional
 *   anchor field, `heading` — a whole markdown section, coarser than the existing line/blockId
 *   anchors. N/M and the gate derive from these (lib/plan-doc-review.ts).
 * - The revision diff: the doc's git history IS its edit history. A "changed since your last
 *   view" toggle diffs the current working tree against a client-persisted last-seen SHA
 *   (localStorage, one entry per repo+doc) — NOT realtime streaming of live agent edits; see the
 *   toggle's own note below for the upgrade path.
 * - The gate is advisory-only: reaching N/M unresolved offers "Create implementation session"
 *   (POST /api/features/:id/agents, the existing spawn surface) but is NOT wired into
 *   dispatch/land gating — display + action only, per this unit's scope.
 * - "Send to agent" reuses the existing annotation send endpoint
 *   (/api/features/:id/annotations/:id/send) — the same steering lane TaskDetail's plan-annotation
 *   panel already uses.
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ArrowLeft, Bot, Check, GitCompare, Sparkles } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { apiJson } from '../lib/api';
import type { ArtifactCommentDTO } from '../lib/dto';
import {
  parseHeadings,
  commentsForDoc,
  reviewProgress,
  reviewGateOpen,
  reviewNarration,
  headingForComment,
  lastSeenKey,
  parseDocChanges,
  sectionSegments,
  unlocatedChanges,
  changedHeadings,
  type DocHeading,
  type DocLineChange,
} from '../lib/plan-doc-review';
import { splitDiffLines, diffLineStats, type DiffLineKind } from '../lib/intervene';
import { StatusChip } from './kit/StatusChip';
import { MonoLabel } from './kit/MonoLabel';
import { PanelSection } from './kit/PanelSection';

interface PlanDocPipelineDoc {
  file: string;
  path: string;
  title: string;
  content: string;
}

interface PipelineFeatureLite {
  id: string;
  title: string;
  repo: string;
  planDir?: string;
}

interface ReviewPipelinePayload {
  feature?: { createdAt?: number; updatedAt?: number };
  documents: PlanDocPipelineDoc[];
  comments: ArtifactCommentDTO[];
  agentIds: string[];
}

interface PlanDocReadPayload {
  path: string;
  content: string;
  sha: string;
}

// Strike treatment is brand-muted (reduced-opacity struck text), never raw red — red is reserved
// for the semantic danger ramp, and brand.md wants exactly one warm signal (ember) per view.
const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-ember/15 text-ink-text-body',
  del: 'text-ink-text-subtle line-through opacity-60',
  hunk: 'text-ink-text-subtle',
  meta: 'hidden',
  ctx: 'text-ink-text-muted',
};

/** One in-place change row: a struck removed line, or its ember-highlighted replacement —
 *  reference 213221's signature live-edit look, sitting INSIDE the rendered doc. */
const ChangeRow: React.FC<{ row: DocLineChange }> = ({ row }) => (
  <div
    className={`whitespace-pre-wrap rounded px-1.5 py-0.5 font-mono text-xs leading-relaxed ${
      row.kind === 'del' ? 'text-ink-text-subtle line-through opacity-60' : 'bg-ember/15 text-ink-text-body'
    }`}
  >
    {row.text || ' '}
  </div>
);

function authorInitial(author: string): string {
  return (author.trim()[0] ?? '?').toUpperCase();
}

/** Humans and agents are visually distinct species everywhere they appear (UI-REFERENCES.md's
 *  shared visual DNA). Kit contract (X1): humans render in the `human` cool neutral-blue —
 *  matching StatusChip's tone — where the references used warm-pink; agents keep teal/mint AND
 *  a bot glyph, so the species distinction never rests on color alone. */
function AuthorAvatar({ author, isAgent }: { author: string; isAgent: boolean }) {
  return (
    <span
      className={`inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
        isAgent ? 'bg-teal-500/20 text-teal-300' : 'bg-sky-500/20 text-sky-300'
      }`}
      title={author}
    >
      {isAgent ? <Bot className="h-3.5 w-3.5" aria-hidden="true" /> : authorInitial(author)}
    </span>
  );
}

function relativeAgo(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const DesignReviewView: React.FC = () => {
  const { tasks, agents, reviewTaskId, reviewDocPath, closeReview, showToast } = useTaskContext();
  const task = tasks.find((t) => t.id === reviewTaskId || t.sourceId === reviewTaskId);
  const featureId = task?.sourceId ?? task?.id ?? reviewTaskId ?? '';
  const repo = task?.properties.project.id ?? '';

  const [pipeline, setPipeline] = React.useState<ReviewPipelinePayload | null>(null);
  const [doc, setDoc] = React.useState<PlanDocPipelineDoc | null>(null);
  const [docPath, setDocPath] = React.useState<string | undefined>(reviewDocPath);
  const [baselineSha, setBaselineSha] = React.useState<string | undefined>(undefined);
  const [diffAvailable, setDiffAvailable] = React.useState(false);
  const [showDiff, setShowDiff] = React.useState(false);
  const [diffText, setDiffText] = React.useState<string>('');
  const [activeHeading, setActiveHeading] = React.useState<string | undefined>(undefined);
  const [commentBody, setCommentBody] = React.useState('');
  const [posting, setPosting] = React.useState(false);
  const [sendingId, setSendingId] = React.useState<string | null>(null);
  const [creatingSession, setCreatingSession] = React.useState(false);

  // Load the feature pipeline (documents list + comments + linked agents) once repo/featureId are known.
  React.useEffect(() => {
    if (!repo || !featureId) return;
    let alive = true;
    apiJson<ReviewPipelinePayload>(`/api/features/${encodeURIComponent(featureId)}/pipeline?repo=${encodeURIComponent(repo)}`)
      .then((payload) => {
        if (!alive) return;
        setPipeline(payload);
        setDocPath((current) => current ?? payload.documents[0]?.path);
      })
      .catch(() => { /* the feature may not exist yet in this repo (e.g. before its first plan doc) */ });
    return () => { alive = false; };
  }, [repo, featureId]);

  // Read the doc's live content + head SHA, and fold in the "have I seen this revision" check
  // against localStorage — the "changed since your last view" diff toggle's whole data source.
  React.useEffect(() => {
    if (!repo || !docPath) return;
    let alive = true;
    apiJson<PlanDocReadPayload>(`/api/plan-doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(docPath)}`)
      .then((payload) => {
        if (!alive) return;
        setDoc({ file: docPath.split('/').pop() ?? docPath, path: payload.path, title: payload.path.split('/').pop() ?? payload.path, content: payload.content });
        const key = lastSeenKey(repo, docPath);
        let stored: string | null = null;
        try { stored = window.localStorage.getItem(key); } catch { /* storage blocked */ }
        setBaselineSha(stored ?? payload.sha);
        setDiffAvailable(!!stored && stored !== payload.sha && !!payload.sha);
        try { if (payload.sha) window.localStorage.setItem(key, payload.sha); } catch { /* storage blocked */ }
      })
      .catch(() => { /* doc not readable yet */ });
    return () => { alive = false; };
  }, [repo, docPath]);

  const comments = pipeline?.comments ?? [];
  const forDoc = React.useMemo(() => (docPath ? commentsForDoc(comments, docPath) : []), [comments, docPath]);
  const headings = React.useMemo<DocHeading[]>(() => (doc ? parseHeadings(doc.content) : []), [doc]);
  const progress = React.useMemo(() => (docPath ? reviewProgress(comments, docPath) : { resolved: 0, total: 0 }), [comments, docPath]);
  const gateOpen = docPath ? reviewGateOpen(comments, docPath) : false;
  const narration = docPath ? reviewNarration(comments, docPath) : '';

  // Default the focused section to the oldest UNRESOLVED comment's heading (the thing most in need
  // of attention right now); fall back to the first heading once everything's resolved.
  React.useEffect(() => {
    if (activeHeading !== undefined) return;
    const firstOpen = forDoc.find((c) => c.resolvedAt == null);
    const resolved = firstOpen ? headingForComment(firstOpen, headings) : undefined;
    setActiveHeading(resolved ?? headings[0]?.heading);
  }, [forDoc, headings, activeHeading]);

  const activeAgents = React.useMemo(
    () => agents.filter((a) => repo && a.repo === repo && (a.featureId === featureId || (pipeline?.agentIds ?? []).includes(a.id))),
    [agents, repo, featureId, pipeline?.agentIds],
  );

  const toggleDiff = async () => {
    if (!showDiff && docPath && repo && baselineSha) {
      try {
        const result = await apiJson<{ diff: string }>(`/api/plan-doc/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(docPath)}&since=${encodeURIComponent(baselineSha)}`);
        setDiffText(result.diff);
      } catch {
        showToast('Could not load the revision diff', 'error');
        return;
      }
    }
    setShowDiff((v) => !v);
  };

  const postComment = async () => {
    if (!featureId || !repo || !docPath || !commentBody.trim()) return;
    setPosting(true);
    try {
      const saved = await apiJson<ArtifactCommentDTO>(`/api/features/${encodeURIComponent(featureId)}/annotations?repo=${encodeURIComponent(repo)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planPath: docPath, heading: activeHeading, body: commentBody.trim() }),
      });
      setPipeline((prev) => prev && { ...prev, comments: [...prev.comments, saved] });
      setCommentBody('');
      showToast('Comment posted', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not post comment', 'error');
    } finally {
      setPosting(false);
    }
  };

  const resolveComment = async (comment: ArtifactCommentDTO) => {
    if (!featureId) return;
    try {
      await apiJson(`/api/features/${encodeURIComponent(featureId)}/annotations/${encodeURIComponent(comment.id)}/resolve`, { method: 'POST' });
      setPipeline((prev) => prev && { ...prev, comments: prev.comments.map((c) => (c.id === comment.id ? { ...c, resolvedAt: Date.now() } : c)) });
    } catch {
      showToast('Could not resolve the comment', 'error');
    }
  };

  const sendToAgent = async (comment: ArtifactCommentDTO, mode: 'agent' | 'planner', agentId?: string) => {
    if (!featureId || !repo) return;
    if (mode === 'agent' && !agentId) { showToast('Pick an agent first', 'error'); return; }
    setSendingId(comment.id);
    try {
      const result = await apiJson<{ agentId: string }>(`/api/features/${encodeURIComponent(featureId)}/annotations/${encodeURIComponent(comment.id)}/send?repo=${encodeURIComponent(repo)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, agentId }),
      });
      showToast(mode === 'planner' ? `Planner agent started: ${result.agentId}` : `Sent to ${result.agentId}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not send', 'error');
    } finally {
      setSendingId(null);
    }
  };

  // The advisory gate's one action: spawn an implementation session with the reviewed doc as task
  // context. Reuses the existing feature-scoped spawn endpoint — this does NOT touch
  // dispatch/land gating, by design (that wiring is a later, red-teamable concern).
  const createImplementationSession = async () => {
    if (!featureId || !repo || !doc) return;
    setCreatingSession(true);
    try {
      const task = `Implement the reviewed design doc "${doc.path}".\n\nAll ${progress.total} review comments are resolved — build exactly what the doc now describes.\n\n---\n${doc.content}`;
      // POST /api/features/:id/agents reads `repo` from the BODY (the query string is ignored there).
      const result = await apiJson<{ agent: { id: string } }>(`/api/features/${encodeURIComponent(featureId)}/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task, name: 'implementation', repo }),
      });
      showToast(`Implementation session started: ${result.agent.id}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start the session', 'error');
    } finally {
      setCreatingSession(false);
    }
  };

  // Hooks stay above the early return (rules of hooks) — these are cheap even when unused.
  const diffLines = React.useMemo(() => splitDiffLines(diffText), [diffText]);
  const diffStats = diffLineStats(diffText);
  const docLines = React.useMemo(() => (doc ? doc.content.split('\n') : []), [doc]);
  // In-place diff mapping: undefined ⇒ the unified diff didn't parse cleanly, fall back wholesale.
  const docChanges = React.useMemo(() => (showDiff ? parseDocChanges(diffText) : undefined), [showDiff, diffText]);
  const diffSectionSet = React.useMemo(() => (docChanges ? changedHeadings(docChanges, headings) : new Set<string>()), [docChanges, headings]);
  const strayChanges = React.useMemo(() => (docChanges ? unlocatedChanges(docChanges, headings) : []), [docChanges, headings]);

  if (!reviewTaskId) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink text-ink-text-subtle">
        No design review selected.
      </div>
    );
  }

  return (
    // INK BY DEFAULT, same idiom as WorkspaceCockpit (index.css / brand.md): this screen opts
    // into the ink/ember surface regardless of the app-wide theme. The `dark` class here is what
    // activates the kit's `dark:` PanelSection/StatusChip styling (custom-variant is
    // `.dark`-ancestor-scoped) even when the rest of the app is in light mode.
    <div className="dark flex h-full w-full flex-col overflow-hidden bg-ink text-ink-text-body">
      <div className="flex items-center gap-4 border-b border-ink-border px-6 py-4">
        <button
          onClick={closeReview}
          className="flex min-h-10 items-center gap-1.5 rounded-md px-2 text-xs text-ink-text-muted hover:bg-ink-surface-2 focus-visible:ring-2 focus-visible:ring-ember"
          aria-label="Back to task"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
        </button>
        <div className="flex flex-1 flex-col">
          <div className="flex w-full items-center gap-3">
            <MonoLabel>Design Review</MonoLabel>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-surface-2">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${gateOpen ? 'bg-emerald-400' : 'bg-ember'}`}
                style={{ width: progress.total ? `${(progress.resolved / progress.total) * 100}%` : '0%' }}
              />
            </div>
            <span className={`font-mono text-xs ${gateOpen ? 'text-emerald-400' : 'text-ink-text-muted'}`}>
              {progress.resolved}/{progress.total} resolved
            </span>
          </div>
          {(gateOpen ? 'All comments resolved, ready to implement!' : narration) && (
            <div className={`mt-1 text-center text-xs ${gateOpen ? 'text-emerald-400' : 'text-ink-text-subtle'}`}>
              {gateOpen ? 'All comments resolved, ready to implement!' : narration}
            </div>
          )}
        </div>
        <div className="w-16" />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {!doc ? (
            <div className="text-sm text-ink-text-subtle">Loading design doc…</div>
          ) : (
            // Left-anchored and wide — the progress bar, doc, and comments rail read as ONE dense
            // screen (the reference's layout), not a floating centered column with dead gutters.
            <div className="max-w-3xl rounded-lg border border-ink-border bg-panel p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <StatusChip status="Design" tone="ember" variant="dim" />
                  <span className="font-mono text-ink-text-muted">{doc.title}</span>
                </div>
                <div className="flex items-center gap-2">
                  {diffAvailable && (
                    <button
                      onClick={() => void toggleDiff()}
                      className={`flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ember ${
                        showDiff ? 'border-ember/50 bg-ember/10 text-ember-link' : 'border-ink-border-2 text-ink-text-muted hover:bg-ink-surface-2'
                      }`}
                    >
                      <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                      {showDiff ? `Showing changes (+${diffStats.added}/-${diffStats.removed})` : 'Changed since your last view'}
                    </button>
                  )}
                </div>
              </div>

              {showDiff && docChanges === undefined ? (
                // The unified diff didn't parse into locatable line changes — fall back to the raw
                // classified-line block for the whole doc rather than guess. Honest, and rare.
                <pre className="overflow-x-auto rounded-md bg-ink-surface p-3 font-mono text-xs leading-relaxed">
                  {diffLines.filter((l) => l.kind !== 'meta').map((line) => (
                    <div key={line.i} className={`whitespace-pre-wrap px-1 ${DIFF_LINE_CLASS[line.kind]}`}>
                      {line.text || ' '}
                    </div>
                  ))}
                </pre>
              ) : (
                <div className="space-y-1">
                  {showDiff && strayChanges.length > 0 && (
                    // Changes that anchor outside every rendered section (the preamble, a heading
                    // line itself) — shown as a raw block for those hunks only, never dropped.
                    <div className="mb-3 rounded-md border border-ink-border bg-ink-surface p-3">
                      <MonoLabel className="mb-1.5 block">Changes outside the sections below</MonoLabel>
                      {strayChanges.map((row, i) => <ChangeRow key={`stray-${i}`} row={row} />)}
                    </div>
                  )}
                  {headings.map((h) => {
                    const isActive = h.heading === activeHeading;
                    const hasChanges = showDiff && diffSectionSet.has(h.heading);
                    const expanded = showDiff ? hasChanges || isActive : isActive;
                    const emphasized = showDiff ? hasChanges : isActive;
                    const body = doc.content.split('\n').slice(h.bodyStart - 1, h.bodyEnd).join('\n');
                    return (
                      // Anchor id lives on the wrapper (kit's PanelSection has no id prop) so a
                      // future scroll-to-section can still target `review-heading-<heading>`; the
                      // emphasis ring also lives outside PanelSection's own border so it never
                      // fights the kit's default border color at equal specificity.
                      <div
                        key={h.heading}
                        id={`review-heading-${encodeURIComponent(h.heading)}`}
                        className={emphasized ? 'rounded-md ring-1 ring-ember/60' : undefined}
                      >
                        <PanelSection
                          title={
                            <button
                              onClick={() => setActiveHeading(h.heading)}
                              className={`min-h-6 rounded text-left focus-visible:ring-2 focus-visible:ring-ember ${emphasized ? 'font-semibold text-ink-text' : ''}`}
                            >
                              {h.heading}
                            </button>
                          }
                        >
                        {expanded && (hasChanges && docChanges ? (
                          // Reference 213221's signature move: the struck removed line and its
                          // ember-highlighted replacement sit IN PLACE inside the rendered doc.
                          <div className="space-y-1">
                            {sectionSegments(docLines, h.bodyStart, h.bodyEnd, docChanges).map((segment, i) =>
                              segment.kind === 'md' ? (
                                segment.text.trim() ? (
                                  <div key={`md-${i}`} className="prose prose-invert prose-sm max-w-none prose-headings:hidden">
                                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{segment.text}</ReactMarkdown>
                                  </div>
                                ) : null
                              ) : (
                                <div key={`ch-${i}`}>
                                  {segment.rows.map((row, j) => <ChangeRow key={j} row={row} />)}
                                </div>
                              ),
                            )}
                          </div>
                        ) : (
                          <div className="prose prose-invert prose-sm max-w-none prose-headings:hidden">
                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{body}</ReactMarkdown>
                          </div>
                        ))}
                        </PanelSection>
                      </div>
                    );
                  })}
                  {headings.length === 0 && (
                    showDiff && docChanges ? (
                      <div className="space-y-1">
                        {sectionSegments(docLines, 1, docLines.length, docChanges).map((segment, i) =>
                          segment.kind === 'md' ? (
                            segment.text.trim() ? (
                              <div key={`md-${i}`} className="prose prose-invert prose-sm max-w-none">
                                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{segment.text}</ReactMarkdown>
                              </div>
                            ) : null
                          ) : (
                            <div key={`ch-${i}`}>
                              {segment.rows.map((row, j) => <ChangeRow key={j} row={row} />)}
                            </div>
                          ),
                        )}
                      </div>
                    ) : (
                      <div className="prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{doc.content}</ReactMarkdown>
                      </div>
                    )
                  )}
                </div>
              )}

              {gateOpen && (
                <div className="mt-6 rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-4 text-center">
                  <div className="mb-3 text-sm font-medium text-emerald-400">All comments resolved — ready to implement!</div>
                  <button
                    onClick={() => void createImplementationSession()}
                    disabled={creatingSession}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-ember px-4 py-2 text-xs font-semibold text-ink shadow-[0_0_0_1px_rgba(240,163,90,0.3)] transition-colors hover:bg-ember-link disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    {creatingSession ? 'Starting…' : 'Create implementation session'}
                  </button>
                  {/* Advisory-only, by design: this button starts a session; it does not gate
                      dispatch/land. That integration is a later, red-teamable concern. */}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex w-96 flex-shrink-0 flex-col border-l border-ink-border">
          <div className="flex items-center gap-2 border-b border-ink-border px-4 py-3">
            <MonoLabel>Comments</MonoLabel>
            {/* Kit contract (X1): resolved-good is `success` green, never ember (ember = active). */}
            {gateOpen && <StatusChip status="All resolved" tone="success" variant="solid" />}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {forDoc.length === 0 && <div className="text-xs text-ink-text-subtle">No comments yet. Say what should change.</div>}
            {forDoc.map((comment) => {
              const isAgent = activeAgents.some((a) => a.id === comment.author || a.name === comment.author) || comment.author.toLowerCase() === 'agent';
              const resolved = comment.resolvedAt != null;
              const heading = headingForComment(comment, headings);
              return (
                <div
                  key={comment.id}
                  className={`rounded-md border p-3 text-sm transition-colors ${resolved ? 'border-emerald-800/40 bg-emerald-950/10' : 'border-ink-border bg-ink-surface'}`}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <AuthorAvatar author={comment.author} isAgent={isAgent} />
                      <span className="text-xs font-medium text-ink-text">{comment.author}</span>
                      <span className="text-xs text-ink-text-subtle">{relativeAgo(comment.createdAt)}</span>
                    </div>
                    {resolved && <Check className="h-3.5 w-3.5 text-emerald-400" aria-label="Resolved" />}
                  </div>
                  {heading && (
                    <button onClick={() => setActiveHeading(heading)} className="mb-1.5 inline-block rounded bg-ink-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-text-muted hover:text-ember-link">
                      § {heading}
                    </button>
                  )}
                  <p className="whitespace-pre-wrap text-ink-text-body">{comment.body}</p>
                  {!resolved && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button onClick={() => void resolveComment(comment)} className="min-h-8 rounded px-2 text-xs text-ink-text-muted hover:bg-ink-surface-2 focus-visible:ring-2 focus-visible:ring-ember">
                        Resolve
                      </button>
                      <button
                        disabled={sendingId === comment.id}
                        onClick={() => void sendToAgent(comment, 'planner')}
                        className="min-h-8 rounded border border-ink-border-2 px-2 text-xs text-ink-text-muted hover:bg-ink-surface-2 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ember"
                      >
                        Send to planner
                      </button>
                      {activeAgents.map((agent) => (
                        <button
                          key={agent.id}
                          disabled={sendingId === comment.id}
                          onClick={() => void sendToAgent(comment, 'agent', agent.id)}
                          className="min-h-8 rounded border border-ink-border-2 px-2 text-xs text-ink-text-muted hover:bg-ink-surface-2 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ember"
                        >
                          Send to {agent.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); void postComment(); }}
            className="border-t border-ink-border p-3"
          >
            {activeHeading && <div className="mb-1.5 text-[10px] text-ink-text-subtle">On: § {activeHeading}</div>}
            <textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Leave a note for collaborators or an agent…"
              className="min-h-16 w-full resize-none rounded-md border border-ink-border-2 bg-ink-surface p-2 text-sm text-ink-text-body outline-none focus:border-ember/50 focus:ring-2 focus:ring-ember/20"
            />
            <button
              type="submit"
              disabled={posting || !commentBody.trim()}
              className="mt-2 min-h-9 rounded-md bg-ember px-3 py-1.5 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
            >
              {posting ? 'Posting…' : 'Comment'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
