/**
 * IntervenceView — the step-in surface.
 *
 * This is the moment the hands-off promise is cashed: a "Needs you" push fires, you tap in,
 * and this one screen answers — without a scroll or a second click — what the agent is doing,
 * why it stopped, what it has changed, whether it's on track, and the single action that
 * resolves it. Then you act and step back out.
 *
 * Everything here is COMPOSITION of primitives that already existed but were scattered across
 * AttentionPanel (answer/steer/land), AgentMetaBar (verify/land + validation/confidence),
 * GateWidget (pending answers), and agent-control (interrupt/restart/fork/steer). The one net-new
 * capability is line-level diff correction: annotate the exact changed line that's wrong and the
 * agent re-does it — a surgical step-in that never takes the keyboard away from it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Inbox, Send, FileText, MessageSquarePlus, X, Square, RotateCcw, GitBranch, GitMerge, ExternalLink } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import {
  steerCommand,
  answerCommand,
  interruptCommand,
  restartCommand,
  forkCommand,
} from '../lib/agent-control';
import { agentStatusBadgeClass, prStateBadgeLabel } from '../lib/agent-badges';
import {
  whyStopped,
  intervenePrimaryAction,
  diffLineSteerMessage,
  splitDiffLines,
  isCommentableLine,
  diffLineStats,
  type DiffLineKind,
} from '../lib/intervene';
import { reportAttention, prReviewedEvents, shouldEmitDiffViewed, diffViewedKey, DIFF_VIEWPORT_THRESHOLD } from '../lib/attention';
import type { AgentDTO } from '../lib/dto';
import type { AgentFileDiff } from './chat/DiffReviewPanel';
import { GateWidget } from './chat/GateWidget';
import { AgentMetaBar, AgentLandControls } from './chat/AgentMetaBar';
import { relativeAge } from './ui/time';

const LINE_BG: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/10 dark:bg-emerald-500/10',
  del: 'bg-red-500/10 dark:bg-red-500/10',
  hunk: 'bg-blue-500/5 text-blue-600 dark:text-blue-400',
  meta: 'text-gray-400 dark:text-gray-500',
  ctx: '',
};

/** One changed file: its diff rendered line-by-line, with a comment→steer affordance on real edits. */
const InterveneFileDiff: React.FC<{
  diff: AgentFileDiff;
  onComment: (file: string, lineText: string, comment: string) => void;
}> = ({ diff, onComment }) => {
  const [open, setOpen] = useState(false);
  const [commentingLine, setCommentingLine] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');
  const lines = useMemo(() => splitDiffLines(diff.diff), [diff.diff]);
  const { added, removed } = useMemo(() => diffLineStats(diff.diff), [diff.diff]);

  const submit = (lineText: string) => {
    if (!commentText.trim()) return;
    onComment(diff.file, lineText, commentText);
    setCommentingLine(null);
    setCommentText('');
  };

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-gray-50 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-gray-100 dark:bg-gray-900/60 dark:hover:bg-gray-900"
        aria-expanded={open}
      >
        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden />
        <span className="truncate font-mono text-gray-700 dark:text-gray-300">{diff.status ? `${diff.status} ` : ''}{diff.file}</span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1.5 tabular-nums">
          {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
          {removed > 0 && <span className="text-red-600 dark:text-red-400">−{removed}</span>}
        </span>
      </button>
      {open && diff.diff && (
        <div className="overflow-x-auto bg-white font-mono text-[11px] leading-relaxed dark:bg-gray-950">
          {lines.map((ln) => {
            const commentable = isCommentableLine(ln.kind);
            return (
              <div key={ln.i}>
                <div className={`group flex items-start ${LINE_BG[ln.kind]}`}>
                  <pre className="flex-1 overflow-visible whitespace-pre px-3 py-px text-gray-800 dark:text-gray-200">{ln.text || ' '}</pre>
                  {commentable && (
                    <button
                      onClick={() => { setCommentingLine(commentingLine === ln.i ? null : ln.i); setCommentText(''); }}
                      className="mr-1 mt-px flex-shrink-0 rounded p-0.5 text-gray-300 opacity-0 transition-opacity hover:bg-amber-100 hover:text-amber-600 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 dark:text-gray-600 dark:hover:bg-amber-950/40"
                      title="Comment on this line — sends the agent a targeted fix"
                      aria-label="Comment on this line"
                    >
                      <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </div>
                {commentingLine === ln.i && (
                  <div className="border-y border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/20">
                    <textarea
                      autoFocus
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(ln.text); }
                        if (e.key === 'Escape') { setCommentingLine(null); setCommentText(''); }
                      }}
                      rows={2}
                      placeholder="What should change here? Sends the agent a targeted fix for this line."
                      className="w-full resize-y rounded-md border border-amber-200 bg-white px-2.5 py-1.5 font-sans text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800 dark:bg-gray-950 dark:text-gray-100"
                    />
                    <div className="mt-1.5 flex items-center justify-end gap-2">
                      <button onClick={() => { setCommentingLine(null); setCommentText(''); }} className="rounded px-2 py-1 text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
                      <button
                        onClick={() => submit(ln.text)}
                        disabled={!commentText.trim()}
                        className="flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Send className="h-3 w-3" aria-hidden /> Send fix (⌘↵)
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const IntervenceView: React.FC = () => {
  const { agents, interveneAgentId, setView, openConsole, sendConsoleCommand, subscribeConsole, showToast, connected } = useTaskContext();
  const agent = useMemo<AgentDTO | undefined>(() => agents.find((a) => a.id === interveneAgentId), [agents, interveneAgentId]);

  const [diffs, setDiffs] = useState<AgentFileDiff[] | null>(null);
  const [steerText, setSteerText] = useState('');
  const steerRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep this agent's transcript live so the console (and anything reading transcripts) stays warm
  // for the operator who opens the full console from here.
  useEffect(() => { if (interveneAgentId) subscribeConsole(interveneAgentId); }, [interveneAgentId, subscribeConsole]);

  // The diff is the spine of this screen, so it must not lag the transcript. Re-fetch whenever the
  // agent makes progress (messageCount/status) AND poll while it's actively working — closing the
  // "diff lags what the agent is saying" gap from the client side (a true WS diff-push is the
  // backend follow-up).
  const agentId = agent?.id;
  const repo = agent?.repo;
  const messageCount = agent?.messageCount;
  const status = agent?.status;
  const loadDiff = useCallback(() => {
    if (!agentId) { setDiffs(null); return; }
    void apiJson<AgentFileDiff[]>(`/api/agents/${encodeURIComponent(agentId)}/diff`)
      .then((d) => setDiffs(d))
      .catch(() => { /* keep last good diff on a transient failure */ });
  }, [agentId]);
  useEffect(() => { loadDiff(); }, [loadDiff, messageCount, status]);
  useEffect(() => {
    if (status !== 'working' && status !== 'starting') return;
    const t = setInterval(loadDiff, 4000);
    return () => clearInterval(t);
  }, [status, loadDiff]);

  // diff-viewed (comprehension concern 02): one shared IntersectionObserver watches every rendered
  // file section; `attentionFloorRef` is this view's (agentId,file) floor-state map, shared by both
  // the viewport observer and the PR click-through below so the two paths can never double-report
  // the same file inside one 5-minute window. `diffNodesRef` tracks the currently-mounted DOM node
  // per file so a re-render that keeps the same `key` never re-registers it, and unmounting a file
  // (diff refresh drops it) always unobserves its old node instead of leaking an observation target.
  // All threshold/visibility/floor DECISIONS live in lib/attention.ts's `shouldEmitDiffViewed` —
  // this component only wires the browser API and calls it.
  const attentionFloorRef = useRef<Record<string, number>>({});
  const observerRef = useRef<IntersectionObserver | null>(null);
  const diffNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleIntersections = useCallback((entries: IntersectionObserverEntry[]) => {
    if (!agentId || !repo) return;
    const now = Date.now();
    for (const entry of entries) {
      const file = (entry.target as HTMLElement).dataset.attentionFile;
      if (!file) continue;
      if (shouldEmitDiffViewed({
        state: attentionFloorRef.current,
        agentId,
        file,
        intersectionRatio: entry.intersectionRatio,
        visibilityState: document.visibilityState,
        now,
      })) {
        reportAttention({ kind: 'diff-viewed', repo, file, agentId });
        attentionFloorRef.current[diffViewedKey(agentId, file)] = now;
      }
    }
  }, [agentId, repo]);

  // Root left at its default (the browser viewport): a target's rect is clipped by every ancestor's
  // overflow box — including this screen's own `overflow-y-auto` diff panel — before it's ever
  // intersected against the root, observer-root-choice or not, so this is correct without a ref to
  // that panel. Recreated only when the callback identity changes (agent/repo switch, never on the
  // 4s poll), and every already-mounted file node is re-observed so a diff-content refresh under an
  // unchanged `key` is never silently dropped from observation.
  useEffect(() => {
    const observer = new IntersectionObserver(handleIntersections, { threshold: [0, DIFF_VIEWPORT_THRESHOLD, 1] });
    observerRef.current = observer;
    for (const node of diffNodesRef.current.values()) observer.observe(node);
    return () => { observer.disconnect(); observerRef.current = null; };
  }, [handleIntersections]);

  const registerDiffNode = useCallback((file: string, el: HTMLDivElement | null) => {
    const prev = diffNodesRef.current.get(file);
    if (prev && prev !== el && observerRef.current) observerRef.current.unobserve(prev);
    if (el) {
      diffNodesRef.current.set(file, el);
      observerRef.current?.observe(el);
    } else {
      diffNodesRef.current.delete(file);
    }
  }, []);

  // pr-reviewed (comprehension concern 02): click-through to the PR link is itself the signal (an
  // explicit action, unlike viewport entry) and retroactively counts every file in the *currently
  // loaded* diff set as reviewed — floor-gated the same way as the observer above so a file already
  // marked seen by scrolling isn't double-counted.
  const onPrReviewed = useCallback(() => {
    if (!agentId || !repo) return;
    const now = Date.now();
    const { events, markKeys } = prReviewedEvents({
      state: attentionFloorRef.current,
      repo,
      agentId,
      prNumber: agent?.prNumber,
      files: (diffs ?? []).map((d) => d.file),
      now,
    });
    for (const evt of events) reportAttention(evt);
    for (const key of markKeys) attentionFloorRef.current[key] = now;
  }, [agentId, repo, agent?.prNumber, diffs]);

  const sendSteer = useCallback(() => {
    if (!agentId || !steerText.trim()) return;
    sendConsoleCommand(steerCommand(agentId, steerText.trim()));
    showToast('Steer sent', 'success');
    setSteerText('');
  }, [agentId, steerText, sendConsoleCommand, showToast]);

  const commentSteer = useCallback((file: string, lineText: string, comment: string) => {
    if (!agentId) return;
    sendConsoleCommand(steerCommand(agentId, diffLineSteerMessage(file, lineText, comment)));
    showToast(`Sent a fix for ${file}`, 'success');
  }, [agentId, sendConsoleCommand, showToast]);

  const answer = useCallback((requestId: string, value: string) => {
    if (!agentId) return;
    sendConsoleCommand(answerCommand(agentId, requestId, value));
    showToast('Answer sent', 'success');
  }, [agentId, sendConsoleCommand, showToast]);

  if (!agent) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-gray-500 dark:text-gray-400">
        <Inbox className="h-8 w-8" aria-hidden />
        <div className="text-sm">No agent selected to step into.</div>
        <button onClick={() => setView('fleet')} className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
          Go to Fleet
        </button>
      </div>
    );
  }

  const why = whyStopped(agent);
  const primary = intervenePrimaryAction(agent);
  const whyTone: Record<string, string> = {
    critical: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
    warn: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200',
    info: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-200',
    neutral: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300',
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-gray-950">
        <button onClick={() => setView('fleet')} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100" aria-label="Back to Fleet">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Fleet
        </button>
        <span className="text-gray-300 dark:text-gray-700">/</span>
        <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{agent.name || agent.id}</span>
        <span className={`flex-shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${agentStatusBadgeClass(agent.status)}`}>{agent.status}</span>
        {agent.model && <span className="flex-shrink-0 truncate text-[11px] text-gray-400" title={agent.model}>{agent.model}</span>}
        {agent.startedAt && <span className="ml-auto flex-shrink-0 text-[11px] tabular-nums text-gray-400">{relativeAge(agent.startedAt)}</span>}
        {!connected && <span className="flex-shrink-0 text-[11px] text-red-500">daemon offline</span>}
      </div>

      {/* On-track strip: validation / confidence / proof / branch — reused verbatim from the console. */}
      <AgentMetaBar agent={agent} changedFiles={diffs?.length ?? null}>
        {/* Click-through is the pr-reviewed signal (concern 02) — an explicit action, so it fires
            unconditionally on every click, unlike the floor-gated per-file diff-viewed events it
            also emits for the currently loaded diff set. */}
        {agent.prUrl && (
          <a
            href={agent.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={onPrReviewed}
            className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
          >
            <GitMerge className="h-3 w-3" aria-hidden /> PR #{agent.prNumber}{agent.prState ? ` · ${prStateBadgeLabel(agent.prState)}` : ''}
          </a>
        )}
      </AgentMetaBar>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {/* Why it needs you — the single most important line on the screen. */}
        <div className={`rounded-lg border px-3 py-2 text-sm font-medium ${whyTone[why.tone]}`}>{why.label}</div>

        {/* Goal / issue context, when present. */}
        {agent.issue?.name && (
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
            <span className="font-semibold text-gray-500 dark:text-gray-400">Goal</span> · {agent.issue.identifier ? `${agent.issue.identifier} — ` : ''}{agent.issue.name}
          </div>
        )}

        {/* Pending questions — the exact thing blocking it, answerable inline. */}
        {agent.pending?.map((req) => (
          <GateWidget key={req.id} request={req} onAnswer={(value) => answer(req.id, value)} />
        ))}

        {/* The diff — the spine. What it changed, file by file, with line-level correction. */}
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-gray-400">
            <span>Changes</span>
            <span className="text-gray-300 dark:text-gray-600">·</span>
            <span>{diffs == null ? 'loading…' : `${diffs.length} changed ${diffs.length === 1 ? 'file' : 'files'}`}</span>
          </div>
          {diffs != null && diffs.length === 0 && (
            <div className="rounded-md border border-dashed border-gray-200 px-3 py-4 text-center text-xs text-gray-400 dark:border-gray-800">No file changes yet.</div>
          )}
          <div className="space-y-2">
            {diffs?.map((d) => (
              <div key={d.file} ref={(el) => registerDiffNode(d.file, el)} data-attention-file={d.file}>
                <InterveneFileDiff diff={d} onComment={commentSteer} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Action dock — the one action, plus the full step-in toolset, always reachable. */}
      <div className="flex-shrink-0 border-t border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
        {/* Steer composer is the default one action (answer is handled inline above via the gate). */}
        <div className="flex items-end gap-2">
          <textarea
            ref={steerRef}
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendSteer(); } }}
            rows={2}
            placeholder={primary === 'answer' ? 'Answer above, or type a redirect…' : 'Redirect this agent — a fresh steering turn…'}
            className="min-w-0 flex-1 resize-y rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            aria-label="Steer this agent"
          />
          <button
            onClick={sendSteer}
            disabled={!steerText.trim()}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-amber-500 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" aria-hidden /> Steer (⌘↵)
          </button>
        </div>

        {/* Secondary tools: interrupt / restart / fork / verify+land / open console. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(agent.status === 'working' || agent.status === 'starting') && (
            <button onClick={() => { sendConsoleCommand(interruptCommand(agent.id)); showToast('Interrupt sent', 'info'); }} className="flex items-center gap-1 rounded-full border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
              <Square className="h-3 w-3" aria-hidden /> Interrupt
            </button>
          )}
          {(agent.status === 'error' || agent.status === 'stopped') && (
            <button onClick={() => { sendConsoleCommand(restartCommand(agent.id)); showToast('Restart sent', 'success'); }} className="flex items-center gap-1 rounded-full border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
              <RotateCcw className="h-3 w-3" aria-hidden /> Restart
            </button>
          )}
          {agent.forkAvailable && (
            <button onClick={() => { sendConsoleCommand(forkCommand(agent.id)); showToast('Forked from latest checkpoint', 'success'); }} title="Branch a new run from the latest checkpoint (open the console for step-by-step fork)" className="flex items-center gap-1 rounded-full border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
              <GitBranch className="h-3 w-3" aria-hidden /> Fork
            </button>
          )}
          <AgentLandControls agent={agent} showToast={showToast} />
          <button onClick={() => openConsole(agent.id)} className="ml-auto flex items-center gap-1 rounded-full border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            <ExternalLink className="h-3 w-3" aria-hidden /> Full console
          </button>
        </div>
      </div>
    </div>
  );
};
