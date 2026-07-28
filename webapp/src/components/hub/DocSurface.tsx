import React from 'react';
import { PlanBlockContext } from '../PlanBlocks';
import { PlanProse } from './PlanProse';
import { DecisionsPanel } from './DecisionsPanel';
import { apiJson, jsonInit } from '../../lib/api';
import { useTaskContext } from '../../context/TaskContext';
import type { ArtifactCommentDTO } from '../../lib/dto';
import { STATE_TONE, byHeading, commentsHeadline, readinessLine, whatHappenedToIt, wroteState, type DocComment } from '../../lib/docSurface';

/**
 * DocSurface — reading a plan, and what happened to what you wrote on it.
 *
 * `06-other-side.html` names the zone: **WHAT HAPPENED TO WHAT YOU WROTE**, drawn as a lifecycle in
 * one line — *"written 15:45:31 · sent 15:51:02 · received and read back by Wren."* Three states,
 * three amounts of certainty, and the difference between them is the whole value of the screen.
 *
 * The two screens this replaces both had that data and neither drew the distinction. The design-review
 * view showed "Design Review N/M resolved" over a progress bar; the plan-detail view showed a comments
 * rail with a resolve tick. Resolved-vs-open is ONE bit where there are three facts, and the missing
 * one — did anybody ever receive this — is the one that costs an afternoon.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

interface PlanDocReadPayload { path: string; markdown: string; sha?: string }

/** The comment shape this screen needs, from the wire shape the daemon actually sends. */
function toDocComment(comment: ArtifactCommentDTO): DocComment {
  return {
    id: comment.id,
    body: comment.body,
    author: comment.author,
    createdAt: comment.createdAt,
    resolvedAt: comment.resolvedAt,
    // The wire carries no sent/acknowledged timestamps yet. Absent is rendered as "never sent",
    // which is the honest reading — and the reason this surface exists is that the alternative
    // (assuming it reached someone) is the expensive mistake.
    heading: comment.annotation?.heading,
    quote: comment.annotation?.quote,
  };
}

export function DocSurface({ taskId, docPath }: { taskId?: string; docPath?: string }) {
  const { tasks, currentProject, reload } = useTaskContext();
  const task = tasks.find((entry) => entry.id === taskId);
  const repo = currentProject?.id ?? '';
  const path = docPath ?? (task?.planDir ? `${task.planDir}/DESIGN.md` : undefined);

  const [doc, setDoc] = React.useState<PlanDocReadPayload | undefined>();
  const [comments, setComments] = React.useState<DocComment[]>([]);
  const [error, setError] = React.useState('');
  const [draft, setDraft] = React.useState('');

  const loadComments = React.useCallback(async () => {
    if (!taskId) return;
    const wire = await apiJson<ArtifactCommentDTO[]>(`/api/features/${encodeURIComponent(taskId)}/annotations`).catch(() => [] as ArtifactCommentDTO[]);
    setComments(wire.map(toDocComment));
  }, [taskId]);

  React.useEffect(() => {
    if (!path || !repo) return;
    let alive = true;
    apiJson<PlanDocReadPayload>(`/api/plan-doc?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`)
      .then((next) => { if (alive) setDoc(next); })
      // A document that could not be read is not an empty plan.
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'this document could not be read'); });
    void loadComments();
    return () => { alive = false; };
  }, [path, repo, loadComments]);

  if (!taskId) {
    return (
      <div className="px-8 py-9" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>NOTHING IS OPEN</div>
        <div className="mt-2.5 max-w-[620px] text-[13px] leading-[1.6]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
          Choose something from what is on, and its plan opens here with everything anyone has written on it.
        </div>
      </div>
    );
  }

  const grouped = byHeading(comments);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto flex max-w-[1120px] gap-10 px-8 py-9">
        <div className="min-w-0 flex-1">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>
            {(task?.title ?? 'THIS PLAN').toUpperCase()}
          </div>
          {path ? <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{path}</div> : null}

          {/* Advisory, and said to be advisory. */}
          <div className="mt-3.5 text-[13px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 680 }}>
            {readinessLine(comments)}
          </div>

          {error ? (
            <div className="mt-5 px-3.5 py-2.5 text-[12.5px] leading-[1.5]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2', textWrap: 'pretty' }}>
              {error}. That is a failed read, not an empty plan.
            </div>
          ) : null}

          {/* Recorded server-side, writable via PATCH/supersede, and — until this — rendered nowhere a
              person could see when they opened a feature. Sits above the plan doc, not buried in a rail:
              a feature's decisions and acceptance criteria are what a person opening it usually came for. */}
          {task ? (
            <DecisionsPanel
              decisions={task.decisions}
              criteria={task.acceptanceCriteria}
              featureId={taskId}
              repo={repo}
              onSuperseded={() => void reload()}
            />
          ) : null}

          {doc ? (
            // Prose at a reading measure, in the room's own type — not a rendered README in a card.
            // PlanBlocks stays: a plan's mermaid diagrams, wireframes, callouts and question blocks
            // are how the plan actually argues, and dropping to plain markdown would have quietly
            // turned every one of them into a fenced code block.
            <PlanBlockContext.Provider value={{ featureId: taskId, repo, planPath: path }}>
              {/* Same typesetting as the decision panel, so a plan reads the same wherever you meet
                  it — the one you approve in a rail and the one you review at full width are the
                  same document and should not look like two kinds of thing. */}
              <article className="mt-6">
                <PlanProse markdown={doc.markdown} measure={72} />
              </article>
            </PlanBlockContext.Provider>
          ) : !error ? (
            <div className="mt-6" style={{ fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reading the document…</div>
          ) : null}
        </div>

        <div className="w-[340px] flex-none">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT HAPPENED TO WHAT YOU WROTE</div>
          <div className="mt-2.5 text-[12.5px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
            {commentsHeadline(comments)}
          </div>

          {grouped.map((group) => (
            <div key={group.heading} className="mt-5">
              <div className="truncate" style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.12em', color: '#4A4A52' }}>{group.heading.toUpperCase()}</div>
              <div className="mt-1.5 flex flex-col">
                {group.comments.map((comment) => (
                  <div key={comment.id} className="flex gap-2.5 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
                    <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: STATE_TONE[wroteState(comment)] }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{comment.body}</div>
                      {/* The lifecycle, not a resolve tick. */}
                      <div className="mt-[3px] text-[11px] leading-[1.45]" style={{ color: wroteState(comment) === 'written' ? '#C2704A' : '#6A6A72', textWrap: 'pretty' }}>
                        {whatHappenedToIt(comment)}
                      </div>
                      {wroteState(comment) === 'written' && taskId ? (
                        <button
                          type="button"
                          onClick={async () => {
                            await apiJson(`/api/features/${encodeURIComponent(taskId)}/annotations/${encodeURIComponent(comment.id)}/send`, jsonInit('POST', {})).catch(() => {});
                            void loadComments();
                          }}
                          className="mt-1.5"
                          style={{ fontFamily: MONO, fontSize: 10, color: '#F0A35A' }}
                          title="Send this to whoever is working on it. Until you do, nobody has seen it."
                        >
                          send it to whoever is working on this ›
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="mt-6">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write something on this plan…"
              rows={3}
              className="w-full resize-none rounded-[3px] bg-transparent px-2.5 py-2 outline-none"
              style={{ border: '1px solid #26262B', fontSize: 12.5, color: '#C9C9CF' }}
            />
            <button
              type="button"
              disabled={!draft.trim() || !taskId}
              onClick={async () => {
                await apiJson(`/api/features/${encodeURIComponent(taskId!)}/annotations`, jsonInit('POST', { body: draft.trim(), annotation: { planPath: path } })).catch(() => {});
                setDraft('');
                void loadComments();
              }}
              className="mt-2 h-7 w-full rounded-[3px] disabled:opacity-40"
              style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C9C9CF' }}
            >
              write it down
            </button>
            {/* Said at the point of writing, not discovered later. */}
            <div className="mt-1.5 text-[11px] leading-[1.45]" style={{ color: '#4A4A52', textWrap: 'pretty' }}>
              Writing it down does not send it. It stays here as a note until you send it to someone.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
