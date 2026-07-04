import React from 'react';
import { apiFetch, jsonInit } from '../../lib/api';
import { canLand, landToast, verifyToast, type LandResultDTO, type ProofResultDTO, type ToastTone } from '../../lib/agent-control';
import type { AgentDTO } from '../../lib/dto';
import { fmtDuration } from './ToolCallGroup';

// Moved verbatim from AssistantChat.tsx (concern 09 — monolith split):
// `AgentMetaBar`, `AgentLandControls`, `ComposerStats`, and the private
// formatting helpers they share.

const fmtTokens = (n?: number) => n == null ? undefined : n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1_000_000).toFixed(1)}M`;
const ctxTone = (pct?: number) => pct == null ? 'text-gray-500 dark:text-gray-400' : pct > 0.9 ? 'text-red-600 dark:text-red-400' : pct > 0.7 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300';

const gitSummary = (agent?: AgentDTO, changedFiles?: number | null) => {
  if (!agent) return '';
  const changes = changedFiles == null ? 'checking…' : changedFiles === 0 ? 'clean' : `${changedFiles} changed`;
  return agent.branch ? `${agent.branch} · ${changes}` : changes;
};

export const AgentMetaBar = ({ agent, changedFiles, children }: { agent?: AgentDTO; changedFiles?: number | null; children?: React.ReactNode }) => {
  if (!agent) return null;
  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400" aria-label="Agent mode and git status">
      <span className="rounded-full border border-gray-200 px-1.5 py-0.5 uppercase text-gray-600 dark:border-gray-800 dark:text-gray-300" title={agent.blockedReason ? `Blocked: ${agent.blockedReason}` : `Requested ${agent.autonomyMode ?? 'assist'}; effective ${agent.effectiveMode ?? 'assist'}`}>{agent.effectiveMode ?? 'assist'}</span>
      <span className="rounded-full border border-gray-200 px-1.5 py-0.5 text-gray-600 dark:border-gray-800 dark:text-gray-300" title={agent.proof?.fingerprint ?? 'No proof fingerprint'}>proof: {agent.verificationState ?? 'unknown'}</span>
      <span className="truncate font-mono" title={`${agent.repo}${agent.branch ? ` · ${agent.branch}` : ''}`}>{gitSummary(agent, changedFiles)}</span>
      {children ? <div className="ml-auto flex flex-shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
};

/**
 * Verify + Land for the focused agent. Restores the land path the webapp shell replacement
 * dropped — and unlike the legacy feature-card buttons it works for ANY branch agent,
 * ad-hoc `omp-squad add` ones included. The daemon's proofGate stays authoritative: a land
 * without a fresh proof answers 409 with the reason; we surface it and arm a one-shot
 * Force land for the operator who insists.
 */
export const AgentLandControls = ({ agent, showToast }: { agent?: AgentDTO; showToast: (message: string, type?: ToastTone) => void }) => {
  const [busy, setBusy] = React.useState<null | 'verify' | 'land'>(null);
  const [forceArmed, setForceArmed] = React.useState(false);
  const [lastBlock, setLastBlock] = React.useState('');
  const agentKey = agent?.id;
  React.useEffect(() => { setForceArmed(false); setLastBlock(''); }, [agentKey]);
  if (!agent || !canLand(agent)) return null;
  const id = agent.id;

  const runVerify = async () => {
    setBusy('verify');
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}/verify`, jsonInit('POST', {}));
      if (!res.ok) { showToast(`Verify failed: ${await res.text().catch(() => res.status)}`, 'error'); return; }
      const toast = verifyToast(await res.json() as ProofResultDTO);
      showToast(toast.text, toast.tone);
    } catch (error) {
      showToast(`Verify failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const runLand = async (force: boolean) => {
    setBusy('land');
    try {
      // A force land must carry an operator reason (the manager refuses without one) — the
      // prior block detail IS the reason the operator saw and chose to override.
      const payload = force ? { force: true, reason: `web operator override — prior block: ${lastBlock || 'unknown'}` } : {};
      const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}/land`, jsonInit('POST', payload));
      const body = await res.json().catch(() => null) as LandResultDTO | null;
      if (!body) { showToast(`Land failed: HTTP ${res.status}`, 'error'); return; }
      const toast = landToast(body);
      showToast(toast.text, toast.tone);
      // A blocked land (usually the proof gate) arms a one-shot, visibly-distinct Force.
      setForceArmed(!body.ok && !body.staged);
      setLastBlock(!body.ok && !body.staged ? (body.detail ?? body.message ?? 'blocked') : '');
    } catch (error) {
      showToast(`Land failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const pill = 'flex min-h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <>
      <button
        type="button"
        disabled={busy != null}
        onClick={() => void runVerify()}
        title="Run the repo's acceptance command in this worktree and record a land proof"
        className={`${pill} border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800`}
      >
        {busy === 'verify' ? 'Verifying…' : 'Verify'}
      </button>
      <button
        type="button"
        disabled={busy != null}
        onClick={() => void runLand(forceArmed)}
        title={forceArmed ? 'Land was blocked — force skips the proof gate' : `Merge ${agent.branch} into main (proof-gated)`}
        className={`${pill} ${forceArmed
          ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/40'
          : 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/40'}`}
      >
        {busy === 'land' ? 'Landing…' : forceArmed ? 'Force land ⚠' : agent.landReady ? 'Land ✓' : 'Land'}
      </button>
    </>
  );
};

export const ComposerStats = ({ agent }: { agent?: AgentDTO }) => {
  if (!agent) return null;
  const ctx = agent.contextPct == null ? undefined : `${(agent.contextPct * 100).toFixed(1)}%${agent.contextWindow ? `/${fmtTokens(agent.contextWindow)}` : ''}`;
  const tokens = fmtTokens(agent.receipt?.tokens);
  const duration = fmtDuration(agent.receipt?.durationMs ?? (agent.startedAt ? Date.now() - agent.startedAt : undefined));
  const parts = [
    ctx && <span key="ctx" className={ctxTone(agent.contextPct)} title={agent.contextWindow ? `${agent.contextTokens ?? '?'} / ${agent.contextWindow} context tokens` : 'context used'}>{ctx}</span>,
    tokens && <span key="tokens" title="tokens">{tokens} tok</span>,
    agent.receipt?.toolCalls != null && <span key="tools" title="tool calls">{agent.receipt.toolCalls} tools</span>,
    duration && <span key="time" title="run time">{duration}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-gray-500 dark:text-gray-400" aria-label="Run metrics">{parts.map((part, index) => <React.Fragment key={index}>{index > 0 && <span className="text-gray-300 dark:text-gray-700">·</span>}{part}</React.Fragment>)}</div>;
};
