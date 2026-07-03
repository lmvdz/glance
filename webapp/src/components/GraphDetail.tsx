/**
 * GraphDetail — the drill-down pane that splits into the omp-graph canvas when you
 * click a datum. It routes on what you clicked:
 *   - a commit milestone (mark carries meta.sha) → a GitHub-inspired diff, fetched
 *     from /api/graph/commit
 *   - anything else → a structured detail card (time, kind, value, meta), with a
 *     jump into the task's existing plan view when the datum resolves to an issue.
 */

import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowUpRight, FileText, GitCommit, Loader2, X } from 'lucide-react';
import { apiJson } from '../lib/api';
import { kindColor, statusColor, type CommitDetail, type CommitFile, type GraphDatum } from '../omp-graph/types';
import { normalizeCommitDetail } from '../omp-graph/normalize';

/** Pull a task/issue identifier out of a datum, if any — the "open the plan" hook. */
function issueId(d: GraphDatum): string | null {
  const fromMeta = d.meta?.id;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  const squad = d.title.match(/\(([a-zA-Z]{2,}-\d+)\)/); // squad(ompsq-343) → OMPSQ-343
  if (squad) return squad[1].toUpperCase();
  const bare = d.title.match(/\b([A-Z]{2,}-\d{2,})\b/);
  return bare?.[1] ?? null;
}

const fmtDate = (ms: number): string =>
  ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const FILE_STATUS: Record<string, string> = {
  added: 'bg-emerald-500/15 text-emerald-400',
  deleted: 'bg-red-500/15 text-red-400',
  renamed: 'bg-blue-500/15 text-blue-400',
  modified: 'bg-amber-500/15 text-amber-400',
};

const DiffFile: React.FC<{ file: CommitFile }> = ({ file }) => (
  <div className="mb-2 overflow-hidden rounded-md border border-[#1c2230]">
    <div className="flex items-center gap-2 border-b border-[#1c2230] bg-[#0d1017] px-2.5 py-1.5">
      <FileText className="h-3 w-3 flex-shrink-0 text-[#6d7480]" aria-hidden="true" />
      <span className="truncate font-mono text-[11px] text-[#c4c9d2]" title={file.path}>{file.path}</span>
      <span className={`ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${FILE_STATUS[file.status]}`}>{file.status}</span>
      <span className="flex-shrink-0 font-mono text-[10px] text-emerald-400">+{file.additions}</span>
      <span className="flex-shrink-0 font-mono text-[10px] text-red-400">−{file.deletions}</span>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[11px] leading-[1.5]">
        <tbody>
          {file.lines.map((ln, i) => {
            if (ln.t === 'hunk') {
              return (
                <tr key={i} className="bg-[#0a1420]">
                  <td className="select-none whitespace-pre px-2.5 py-0.5 text-[#3d7dff]">{ln.s}</td>
                </tr>
              );
            }
            const bg = ln.t === 'add' ? 'bg-emerald-500/10' : ln.t === 'del' ? 'bg-red-500/10' : '';
            const fg = ln.t === 'add' ? 'text-emerald-300' : ln.t === 'del' ? 'text-red-300' : 'text-[#8a92a0]';
            const mark = ln.t === 'add' ? '+' : ln.t === 'del' ? '−' : ' ';
            return (
              <tr key={i} className={bg}>
                <td className={`whitespace-pre px-2.5 py-0.5 ${fg}`}>
                  <span className="select-none opacity-50">{mark} </span>
                  {ln.s}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);

export const CommitView: React.FC<{ sha: string }> = ({ sha }) => {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr('');
    setDetail(null);
    apiJson<CommitDetail | { error: string }>(`/api/graph/commit?sha=${encodeURIComponent(sha)}`)
      .then((d) => {
        if (!live) return;
        if (d && 'error' in d) return setErr(d.error);
        // A 200 partial body has no `error` key but omits sha/files — normalize so it degrades
        // to a message instead of crashing on detail.sha.slice.
        const nd = normalizeCommitDetail(d);
        if (nd) setDetail(nd);
        else setErr('Could not load the commit diff.');
      })
      .catch(() => { if (live) setErr('Could not load the commit diff.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sha]);

  if (loading) return <div className="flex items-center gap-2 p-4 text-xs text-[#7a8390]"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading diff…</div>;
  if (err) return <div className="flex items-center gap-2 p-4 text-xs text-red-400"><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> {err}</div>;
  if (!detail) return null;
  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] text-[#f2913d]">{detail.sha.slice(0, 7)}</span>
        <span className="text-sm font-semibold text-[#e5e8ee]">{detail.subject}</span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#7a8390]">
        <span>{detail.author}</span>
        <span>·</span>
        <span>{fmtDate(detail.dateMs)}</span>
        <span>·</span>
        <span className="font-mono">
          <span className="text-emerald-400">+{detail.additions}</span> <span className="text-red-400">−{detail.deletions}</span> in {detail.files.length} file{detail.files.length === 1 ? '' : 's'}
        </span>
      </div>
      {detail.files.map((f, i) => <DiffFile key={i} file={f} />)}
      {detail.truncated && <div className="px-1 py-2 text-[11px] text-amber-400/80">Diff truncated at 900 lines — open the commit locally for the full patch.</div>}
    </div>
  );
};

const Row: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <>
    <dt className="uppercase tracking-wider text-[#5a6270]">{k}</dt>
    <dd className="truncate font-medium text-[#c4c9d2]" title={v}>{v}</dd>
  </>
);

const GenericView: React.FC<{ datum: GraphDatum; onOpenTask?: (id: string) => void }> = ({ datum, onOpenTask }) => {
  const id = issueId(datum);
  const accent = datum.kind ? kindColor(datum.kind) : datum.status ? statusColor(datum.status) : '#f2913d';
  return (
    <div className="p-4">
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full" style={{ background: accent }} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#e5e8ee]">{datum.title}</div>
          <div className="mt-0.5 text-[11px] text-[#7a8390]">{fmtDate(datum.t)}{datum.t1 ? ` → ${fmtDate(datum.t1)}` : ''}</div>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
        <Row k="track" v={datum.trackLabel} />
        <Row k="source" v={datum.source} />
        {datum.kind && <Row k="kind" v={datum.kind} />}
        {datum.status && <Row k="status" v={datum.status} />}
        {datum.value != null && <Row k="value" v={`${datum.value}${datum.unit ? ' ' + datum.unit : ''}`} />}
        {datum.meta && Object.entries(datum.meta).filter(([k]) => k !== 'sha').map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}
      </dl>
      {id && onOpenTask && (
        <button onClick={() => onOpenTask(id)} className="mt-4 flex items-center gap-1.5 rounded-md border border-[#232b38] bg-[#11151d] px-2.5 py-1.5 text-[11px] font-medium text-[#c4c9d2] transition-colors hover:bg-[#171c26]">
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /> Open {id} in Tasks
        </button>
      )}
    </div>
  );
};

export const GraphDetail: React.FC<{ datum: GraphDatum; onClose: () => void; onOpenTask?: (id: string) => void }> = ({ datum, onClose, onOpenTask }) => {
  const sha = typeof datum.meta?.sha === 'string' ? datum.meta.sha : null;
  return (
    <div className="flex h-full flex-col border-t-2 border-[#1c2230] bg-[#080a0f]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[#1c2230] px-3 py-2">
        {sha ? (
          <GitCommit className="h-3.5 w-3.5 flex-shrink-0 text-[#f2913d]" aria-hidden="true" />
        ) : (
          <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full" style={{ background: datum.kind ? kindColor(datum.kind) : datum.status ? statusColor(datum.status) : '#f2913d' }} />
        )}
        <span className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-widest text-[#8a92a0]">{sha ? 'Commit' : datum.trackLabel}</span>
        <span className="truncate text-[11px] text-[#5a6270]">{sha ? datum.title : ''}</span>
        <button onClick={onClose} className="ml-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-[#6d7480] transition-colors hover:bg-[#171c26] hover:text-[#c4c9d2]" aria-label="Close detail">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-custom">
        {sha ? <CommitView sha={sha} /> : <GenericView datum={datum} onOpenTask={onOpenTask} />}
      </div>
    </div>
  );
};
