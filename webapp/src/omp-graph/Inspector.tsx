/**
 * Inspector — the 30% split pane the FleetPulse canvas opens into. A true
 * sibling pane (the canvas reflows, nothing is covered), routed on InspectSel:
 * commits open the diff, tickets their plan→agent→land pipeline (with a live
 * "trace on canvas"), runs their receipt, pulse-hours the attribution pairs,
 * the decision queue its REAL answer/land actions, the legend the cost matrix.
 */

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch, apiJson } from '../lib/api';
import { answerCommand, canLand, landToast, type LandResultDTO } from '../lib/agent-control';
import { useTaskContext } from '../context/TaskContext';
import { CommitView } from '../components/GraphDetail';
import type { AttributionDoc, ProvenanceDoc } from './types';
import { normalizeProvenance } from './normalize';
import type { PulseModel } from './pulse-model';
import { HOUR_MS } from './pulse-model';
import { SEL_COLOR, type InspectSel } from './inspect';
import { harnessColor, modelColor } from './FleetPulseCanvas';

const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const Sect: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mt-4 text-[9px] font-semibold uppercase tracking-[0.2em] text-[#565C68]">{children}</div>
);
const Meta: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mt-1 font-mono text-[10.5px] leading-relaxed text-[#7a8390] tabular-nums">{children}</div>
);
const Btn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = (props) => (
  <button
    type="button"
    {...props}
    className="min-h-8 rounded-md border border-[#232936] px-3 py-1.5 text-[11px] font-semibold text-[#ECE7DC] transition-colors hover:border-[#F2913D] hover:bg-[#F2913D1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F2913D]"
  />
);
const Step: React.FC<{ color: string; k: string; v: React.ReactNode; s?: React.ReactNode }> = ({ color, k, v, s }) => (
  <div className="flex gap-3 border-b border-[#171B23] py-2 last:border-none">
    <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} />
    <span className="min-w-0 flex-1">
      <div className="font-mono text-[9px] font-semibold tracking-[0.14em] text-[#565C68]">{k}</div>
      <div className="mt-0.5 text-xs text-[#ECE7DC]">{v}</div>
      {s && <div className="mt-0.5 font-mono text-[10px] text-[#565C68] tabular-nums">{s}</div>}
    </span>
  </div>
);

const TicketBody: React.FC<{ ticket: string; onTrace: (d: ProvenanceDoc) => void; onOpenTask: (id: string) => void }> = ({ ticket, onTrace, onOpenTask }) => {
  const [doc, setDoc] = useState<ProvenanceDoc | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setDoc(null);
    apiJson<ProvenanceDoc | { error: string }>(`/api/graph/provenance?id=${encodeURIComponent(ticket)}`)
      .then((d) => {
        if (!live) return;
        if (d && 'error' in d) return setErr(d.error);
        // A 200 partial body has no `error` key but also no `runs` — normalize so it degrades
        // to a message instead of crashing on doc.runs.reduce.
        const nd = normalizeProvenance(d);
        if (nd) setDoc(nd);
        else setErr('no provenance data for this ticket');
      })
      .catch(() => live && setErr('could not load provenance'));
    return () => {
      live = false;
    };
  }, [ticket]);
  if (err) return <Meta>{err}</Meta>;
  if (!doc) return <Meta>loading the thread…</Meta>;
  const totalCost = doc.runs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  return (
    <>
      <div className="text-[13px] font-semibold text-[#ECE7DC]">{doc.feature?.title ?? ticket}</div>
      <Meta>
        {ticket}
        {totalCost > 0 && <> · ${totalCost.toFixed(2)} across {doc.runs.length} run{doc.runs.length === 1 ? '' : 's'}</>}
      </Meta>
      <Sect>How it shipped</Sect>
      {doc.concern ? (
        <Step color="#9BA0AB" k="PLAN" v={`${doc.concern.planDir}/${doc.concern.file}`} s={`STATUS ${doc.concern.status} · ${doc.concern.title}`} />
      ) : (
        <Step color="#565C68" k="PLAN" v="no plan concern carries this PLANE: pointer" />
      )}
      {doc.runs.length ? (
        doc.runs.slice(-3).map((r, i) => (
          <Step
            key={i}
            color="#4E7FDB"
            k="AGENT"
            v={`${r.name}${r.branch ? ` · ${r.branch}` : ''}`}
            s={`${fmtWhen(r.startedAt)} · ${r.durationMs ? `${(r.durationMs / HOUR_MS).toFixed(1)}h · ` : ''}${r.costUsd ? `$${r.costUsd.toFixed(2)} · ` : ''}${r.harness ?? 'omp'} → ${r.model ?? '?'} · ${r.toolCalls} tools · ${r.status}`}
          />
        ))
      ) : (
        <Step color="#565C68" k="AGENT" v="no receipts matched this ticket" />
      )}
      {doc.land ? (
        <Step color="#4CAF7A" k="LAND" v={doc.land.subject} s={`${doc.land.sha.slice(0, 7)} · ${fmtWhen(doc.land.dateMs)} · ${doc.land.author}`} />
      ) : (
        <Step color="#565C68" k="LAND" v="no land commit found yet" />
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn onClick={() => onTrace(doc)}>✦ Trace on canvas</Btn>
        {doc.feature && <Btn onClick={() => onOpenTask(doc.feature!.id)}>Open in Tasks</Btn>}
      </div>
    </>
  );
};

const NeedsBody: React.FC = () => {
  const { agents, sendConsoleCommand, showToast } = useTaskContext();
  const [reply, setReply] = useState<Record<string, string>>({});
  const [landing, setLanding] = useState<string | null>(null);
  const blocked = agents.filter((a) => a.status === 'input');
  const ready = agents.filter((a) => a.status !== 'input' && (a.landReady || a.availableActions?.includes('land')));

  const land = async (id: string): Promise<void> => {
    setLanding(id);
    try {
      const res = await apiFetch(`/api/agents/${id}/land`, { method: 'POST' });
      const dto = (await res.json()) as LandResultDTO;
      const t = landToast(dto);
      showToast(t.text, t.tone);
    } catch {
      showToast('Land failed — daemon unreachable', 'error');
    } finally {
      setLanding(null);
    }
  };

  return (
    <>
      <div className="text-[13px] font-semibold text-[#ECE7DC]">Decision queue — the fleet is waiting on you</div>
      <Meta>
        {blocked.length + ready.length} item{blocked.length + ready.length === 1 ? '' : 's'} · everything else is running clean
      </Meta>
      {blocked.map((a) => {
        const req = a.pending[0];
        return (
          <div key={a.id} className="mt-3 border-b border-[#171B23] pb-3">
            <Step color="#E5484D" k={`BLOCKED · ${a.name}`} v={req?.title ?? 'needs an answer'} s={req?.message} />
            {req?.options?.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {req.options.map((o) => (
                  <Btn key={o} onClick={() => sendConsoleCommand(answerCommand(a.id, req.id, o))}>
                    {o}
                  </Btn>
                ))}
              </div>
            ) : (
              req && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={reply[a.id] ?? ''}
                    onChange={(e) => setReply((r) => ({ ...r, [a.id]: e.target.value }))}
                    placeholder={req.placeholder ?? 'your answer'}
                    aria-label={`Answer for ${a.name}`}
                    className="min-w-0 flex-1 rounded-md border border-[#232936] bg-[#0B0C10] px-2 py-1.5 text-xs text-[#ECE7DC] placeholder:text-[#565C68] focus:border-[#F2913D] focus:outline-none"
                  />
                  <Btn
                    disabled={!(reply[a.id] ?? '').trim()}
                    onClick={() => {
                      sendConsoleCommand(answerCommand(a.id, req.id, reply[a.id].trim()));
                      setReply((r) => ({ ...r, [a.id]: '' }));
                    }}
                  >
                    Answer
                  </Btn>
                </div>
              )
            )}
          </div>
        );
      })}
      {ready.map((a) => (
        <div key={a.id} className="mt-3 border-b border-[#171B23] pb-3">
          <Step color="#F2913D" k={`LAND READY · ${a.name}`} v={a.branch ?? a.worktree} s="proof green · awaiting your land" />
          <div className="mt-2 flex gap-2">
            <Btn disabled={!canLand(a) || landing === a.id} onClick={() => void land(a.id)}>
              {landing === a.id ? 'Landing…' : 'Land it'}
            </Btn>
          </div>
        </div>
      ))}
      {!blocked.length && !ready.length && <Meta>nothing needs you — the marks leave the canvas the moment the fleet unblocks.</Meta>}
    </>
  );
};

const CostBody: React.FC<{ attribution: AttributionDoc | null }> = ({ attribution }) => {
  if (!attribution) return <Meta>attribution unavailable</Meta>;
  const a = attribution;
  const totals = (rec: Record<string, number[]>, k: string): number => rec[k]?.reduce((x, y) => x + y, 0) ?? 0;
  return (
    <>
      <div className="text-[13px] font-semibold text-[#ECE7DC]">Spend attribution — harness → model</div>
      <Meta>every run is a harness driving a model; the dollars bill to the model's per-token pricing</Meta>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[10.5px] tabular-nums" aria-label="Cost by harness and model">
          <thead>
            <tr>
              <th className="border-b border-[#232936] px-1.5 py-1 text-left text-[9px] uppercase tracking-wider text-[#565C68]">via ↓ · billed →</th>
              {a.models.map((m) => (
                <th key={m} className="border-b border-[#232936] px-1.5 py-1 text-right text-[9px] uppercase tracking-wider text-[#565C68]">
                  <span className="mr-1 inline-block h-[7px] w-[7px] rounded-sm" style={{ background: modelColor(m) }} />
                  {m}
                </th>
              ))}
              <th className="border-b border-[#232936] px-1.5 py-1 text-right text-[9px] uppercase tracking-wider text-[#565C68]">total</th>
            </tr>
          </thead>
          <tbody>
            {a.harnesses.map((hn) => (
              <tr key={hn}>
                <td className="border-b border-[#171B23] px-1.5 py-1 text-[#9BA0AB]">
                  <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-sm" style={{ background: harnessColor(hn) }} />
                  {hn}
                </td>
                {a.models.map((m) => {
                  const v = a.matrix[hn]?.[m] ?? 0;
                  return (
                    <td key={m} className="border-b border-[#171B23] px-1.5 py-1 text-right" style={{ color: v < 0.5 ? '#363B46' : '#9BA0AB' }}>
                      {v < 0.5 ? '—' : `$${Math.round(v)}`}
                    </td>
                  );
                })}
                <td className="border-b border-[#171B23] px-1.5 py-1 text-right font-semibold text-[#ECE7DC]">${Math.round(totals(a.byHarness, hn))}</td>
              </tr>
            ))}
            <tr>
              <td className="px-1.5 py-1 font-semibold text-[#ECE7DC]">anthropic bill</td>
              {a.models.map((m) => (
                <td key={m} className="px-1.5 py-1 text-right font-semibold text-[#ECE7DC]">
                  ${Math.round(totals(a.byModel, m))}
                </td>
              ))}
              <td className="px-1.5 py-1 text-right font-semibold text-[#ECE7DC]">${Math.round(a.totalCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Sect>Is the plan worth it?</Sect>
      {a.plan ? (
        <Step
          color="#C9B79A"
          k="SUBSCRIPTION"
          v={`${a.plan.name} · $${a.plan.monthly}/mo → $${Math.round(a.plan.prorated)} pro-rated to this window`}
          s={
            <>
              this window at API pricing: ${Math.round(a.totalCost)} ·{' '}
              <b style={{ color: a.plan.worth >= 1.5 ? '#4CAF7A' : a.plan.worth >= 0.9 ? '#E8B24A' : '#E5484D' }}>{a.plan.worth.toFixed(1)}× the plan cost</b>
            </>
          }
        />
      ) : (
        <Meta>set OMP_SQUAD_PLAN_MONTHLY (and _NAME) on the daemon for the worth verdict.</Meta>
      )}
    </>
  );
};

const HourBody: React.FC<{ at: number; model: PulseModel; attribution: AttributionDoc | null }> = ({ at, model, attribution }) => {
  const bin = Math.min(model.bins - 1, Math.max(0, Math.floor((at - model.start) / HOUR_MS)));
  const live = model.sessions.filter((s) => s.t0 <= at + HOUR_MS && s.t1 >= at).length;
  const pairs: { hn: string; mn: string; v: number }[] = [];
  if (attribution) {
    const ai = Math.floor((at - attribution.range.start) / attribution.binMs);
    const tot = attribution.models.reduce((a2, k) => a2 + (attribution.byModel[k]?.[ai] ?? 0), 0);
    for (const hn of attribution.harnesses) {
      for (const mn of attribution.models) {
        const v = tot > 0 ? (attribution.byHarness[hn]?.[ai] ?? 0) * ((attribution.byModel[mn]?.[ai] ?? 0) / tot) : 0;
        if (v > 0.02) pairs.push({ hn, mn, v });
      }
    }
    pairs.sort((a, b) => b.v - a.v);
  }
  const idle = model.commits[bin] === 0 && model.cost[bin] > 0.4;
  return (
    <>
      <div className="text-[13px] font-semibold text-[#ECE7DC]">The fleet at {fmtWhen(at)}</div>
      <Meta>
        ${model.cost[bin].toFixed(2)}/hr · {model.commits[bin]} commits · {Math.round(model.churn[bin])} lines churned · {live} runs live · fleet{' '}
        {model.active[bin] ? 'active' : 'idle'}
      </Meta>
      {idle && <div className="mt-1 font-mono text-[10.5px] text-[#E5484D]">⚠ idle burn — spend with zero output this hour</div>}
      <Sect>Who was burning</Sect>
      {pairs.length ? (
        pairs.map((p, i) => (
          <div key={i} className="flex justify-between border-b border-[#171B23] py-1 font-mono text-[11px] text-[#9BA0AB] tabular-nums">
            <span>
              <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-sm" style={{ background: harnessColor(p.hn) }} />
              {p.hn} → <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-sm" style={{ background: modelColor(p.mn) }} />
              {p.mn}
            </span>
            <span className="text-[#ECE7DC]">${p.v.toFixed(2)}</span>
          </div>
        ))
      ) : (
        <Meta>fleet asleep (or attribution still loading)</Meta>
      )}
      <Sect>Position in the window</Sect>
      <Meta>cumulative ${Math.round(model.cum[bin])} — {Math.round((model.cum[bin] / (model.cum[model.bins - 1] || 1)) * 100)}% of the spend so far</Meta>
    </>
  );
};

const RunBody: React.FC<{ sel: Extract<InspectSel, { kind: 'run' }> }> = ({ sel }) => {
  const { agents, openConsole } = useTaskContext();
  const s = sel.session;
  const agent = s.agentId ? agents.find((a) => a.id === s.agentId) : undefined;
  return (
    <>
      <div className="text-[13px] font-semibold text-[#ECE7DC]">
        Agent run · {s.status}
        {s.live ? ' · live' : ''}
      </div>
      <Meta>
        {s.label} · started {fmtWhen(s.t0)} · {((s.t1 - s.t0) / HOUR_MS).toFixed(1)}h{s.live ? ' and counting' : ''}
        {s.costUsd ? ` · $${s.costUsd.toFixed(2)}` : ''}
      </Meta>
      {agent && (
        <>
          <Sect>Live agent</Sect>
          <Step
            color="#4E7FDB"
            k={agent.status.toUpperCase()}
            v={`${agent.name} · ${agent.model ?? '?'}`}
            s={`${agent.branch ?? agent.worktree}${agent.contextPct != null ? ` · context ${agent.contextPct}%` : ''}`}
          />
          <div className="mt-2 flex gap-2">
            <Btn onClick={() => openConsole(agent.id)}>Open transcript</Btn>
          </div>
        </>
      )}
      {!agent && <Meta>run finished — its receipt is this pill; the transcript lives with the (removed) agent.</Meta>}
    </>
  );
};

export const Inspector: React.FC<{
  sel: InspectSel;
  model: PulseModel;
  attribution: AttributionDoc | null;
  onClose: () => void;
  onTrace: (d: ProvenanceDoc) => void;
}> = ({ sel, model, attribution, onClose, onTrace }) => {
  const { tasks, selectTask, setView } = useTaskContext();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openTask = (id: string): void => {
    const rx = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const task = tasks.find((t) => t.id === id || t.sourceId === id) ?? tasks.find((t) => rx.test(t.title));
    if (task) {
      selectTask(task.id);
      setView('tasks');
    }
  };

  const chip = sel.kind.toUpperCase();
  const when =
    'at' in sel ? fmtWhen(sel.at) : sel.kind === 'needs' ? 'right now' : sel.kind === 'cost' ? 'this window' : sel.kind === 'run' ? fmtWhen(sel.session.t0) : '';

  return (
    <aside
      role="complementary"
      aria-label="Inspector"
      className="flex h-full w-[30%] min-w-[380px] flex-shrink-0 flex-col border-l border-[#232936]"
      style={{ background: '#0B0C10' }}
    >
      <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-[#171B23] px-3.5 py-3">
        <span
          className="rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: SEL_COLOR[sel.kind], borderColor: `${SEL_COLOR[sel.kind]}59` }}
        >
          {chip}
        </span>
        <span className="ml-auto font-mono text-[10px] text-[#565C68] tabular-nums">{when}</span>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded text-[#565C68] transition-colors hover:bg-[#171B23] hover:text-[#ECE7DC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F2913D]"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 scrollbar-custom">
        {sel.kind === 'commit' && (
          <>
            <div className="text-[13px] font-semibold text-[#ECE7DC]">{sel.label}</div>
            <CommitView sha={sel.sha} />
          </>
        )}
        {sel.kind === 'ticket' && <TicketBody ticket={sel.ticket} onTrace={onTrace} onOpenTask={openTask} />}
        {sel.kind === 'needs' && <NeedsBody />}
        {sel.kind === 'cost' && <CostBody attribution={attribution} />}
        {sel.kind === 'hour' && <HourBody at={sel.at} model={model} attribution={attribution} />}
        {sel.kind === 'run' && <RunBody sel={sel} />}
        {sel.kind === 'loop' && (
          <>
            <div className="text-[13px] font-semibold text-[#ECE7DC]">{sel.sub.toUpperCase()} · {sel.label}</div>
            <Meta>from automation.jsonl — the Automation panel's data, scoped to this tick.</Meta>
          </>
        )}
        {sel.kind === 'meeting' && (
          <>
            <div className="text-[13px] font-semibold text-[#ECE7DC]">{sel.label}</div>
            <Meta>scheduled · {fmtWhen(sel.at)} · the fleet quiets around meetings, so the ghost says when not to expect throughput.</Meta>
          </>
        )}
        {sel.kind === 'week' && (
          <>
            <div className="text-[13px] font-semibold text-[#ECE7DC]">{sel.label} — week window</div>
            <Meta>picked from the massif. The flat view behind this pane shows the LIVE week; loading an arbitrary history window into flat view is the natural next step (the /api/graph?start=&end= endpoint already serves it).</Meta>
          </>
        )}
      </div>
    </aside>
  );
};

export default Inspector;
