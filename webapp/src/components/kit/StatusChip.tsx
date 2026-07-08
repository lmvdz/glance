import React from 'react';

/**
 * StatusChip — the universal state language borrowed from the reference UIs
 * (plans/orchestration/UI-REFERENCES.md "Shared visual DNA"): a tiny uppercase
 * rounded-rect, filled for active work, dim once it's settled, outline for a
 * not-yet-live draft.
 *
 * TONE ↔ REFERENCE ROLE MAP (the ember-brand translation of the references'
 * palette — brand.md stays the source of truth, no new hex outside it):
 *
 *   ember     = the references' TEAL role: agent / active / live work
 *               (RUNNING solid = the one focal signal; DONE/MERGED dim).
 *   human     = the references' PINK role: humans — presence chips, comment
 *               authors, human-authored session rows. Cool blue, never warm,
 *               so humans and agents read as distinct species everywhere.
 *   success   = reference B's resolved-check: review resolved / criteria
 *               satisfied / gate passed. Green — deliberately distinct from
 *               ember-active ("the agent is working" ≠ "the work is good").
 *   attention = glance's existing amber convention: blocked on a human.
 *   danger    = error / vetoed / closed-unmerged.
 *   neutral   = idle, drafts, unknown labels.
 *
 * `status` is intentionally a free string, not a strict union: this chip is
 * the shared contract the parallel Lane-B units (roster rows, cockpit rails,
 * task-pipeline session rows, the design-review gate) all render through, so
 * it must render *something* sensible for any label those screens pass in.
 * `tone` overrides the mapped tone for labels the KNOWN table can't infer
 * (e.g. a human author's name chip: `<StatusChip status="Sarah" tone="human" />`).
 */

export type StatusChipVariant = 'solid' | 'outline' | 'dim';

export type StatusChipTone = 'ember' | 'human' | 'success' | 'neutral' | 'danger' | 'attention';

interface StatusMeta {
  label: string;
  tone: StatusChipTone;
  variant: StatusChipVariant;
}

/** glance's own AgentStatus values, plus the reference's own vocabulary (DONE/DRAFT/…) so a
 *  caller can pass either a live agent status or a static label (PR state, session-row state). */
const KNOWN: Record<string, StatusMeta> = {
  // glance AgentStatus
  working: { label: 'RUNNING', tone: 'ember', variant: 'solid' },
  starting: { label: 'STARTING', tone: 'ember', variant: 'solid' },
  idle: { label: 'IDLE', tone: 'neutral', variant: 'outline' },
  // "input" = blocked waiting on a human — the app-wide amber-for-attention convention
  // (agent-badges.ts's agentStatusBadgeClass) already means this; keep it consistent
  // rather than inventing a new chip color.
  input: { label: 'NEEDS YOU', tone: 'attention', variant: 'solid' },
  error: { label: 'ERROR', tone: 'danger', variant: 'solid' },
  stopped: { label: 'DONE', tone: 'ember', variant: 'dim' },
  // Reference vocabulary (task pipeline rows, PR state, design-review gate)
  running: { label: 'RUNNING', tone: 'ember', variant: 'solid' },
  done: { label: 'DONE', tone: 'ember', variant: 'dim' },
  draft: { label: 'DRAFT', tone: 'neutral', variant: 'outline' },
  merged: { label: 'MERGED', tone: 'ember', variant: 'dim' },
  closed: { label: 'CLOSED', tone: 'danger', variant: 'outline' },
  // Reference B's review loop: a resolved comment / passed gate — success, not ember.
  resolved: { label: 'RESOLVED', tone: 'success', variant: 'solid' },
  human: { label: 'HUMAN', tone: 'human', variant: 'solid' },
};

function toneClasses(tone: StatusChipTone, variant: StatusChipVariant): string {
  if (tone === 'ember') {
    if (variant === 'solid') return 'bg-[color:var(--wf-accent)] text-black border-transparent';
    if (variant === 'outline') return 'border-[color:var(--wf-accent)] text-[color:var(--wf-accent)] bg-transparent';
    return 'bg-[color:var(--wf-accent-soft)] text-[color:var(--wf-accent)] border-transparent';
  }
  if (tone === 'human') {
    // The references' pink role, translated to the app's cool blue ramp (humans = cool,
    // agents = warm ember — visually distinct species, per the brand decision).
    if (variant === 'solid') return 'bg-blue-100 text-blue-700 border-transparent dark:bg-blue-950/50 dark:text-blue-300';
    if (variant === 'outline') return 'border-blue-300 text-blue-600 bg-transparent dark:border-blue-800 dark:text-blue-400';
    return 'bg-blue-50 text-blue-500 border-transparent dark:bg-blue-950/30 dark:text-blue-400';
  }
  if (tone === 'success') {
    // Reference B's resolved-check green — matches the app's existing emerald semantic ramp.
    if (variant === 'solid') return 'bg-emerald-100 text-emerald-700 border-transparent dark:bg-emerald-950/50 dark:text-emerald-300';
    if (variant === 'outline') return 'border-emerald-300 text-emerald-600 bg-transparent dark:border-emerald-800 dark:text-emerald-400';
    return 'bg-emerald-50 text-emerald-500 border-transparent dark:bg-emerald-950/30 dark:text-emerald-400';
  }
  if (tone === 'danger') {
    if (variant === 'solid') return 'bg-red-100 text-red-700 border-transparent dark:bg-red-950/50 dark:text-red-400';
    if (variant === 'outline') return 'border-red-300 text-red-600 bg-transparent dark:border-red-800 dark:text-red-400';
    return 'bg-red-50 text-red-500 border-transparent dark:bg-red-950/30 dark:text-red-500';
  }
  if (tone === 'attention') {
    if (variant === 'solid') return 'bg-amber-100 text-amber-700 border-transparent dark:bg-amber-950/50 dark:text-amber-400';
    if (variant === 'outline') return 'border-amber-300 text-amber-600 bg-transparent dark:border-amber-800 dark:text-amber-400';
    return 'bg-amber-50 text-amber-500 border-transparent dark:bg-amber-950/30 dark:text-amber-500';
  }
  // neutral
  if (variant === 'solid') return 'bg-gray-200 text-gray-700 border-transparent dark:bg-gray-800 dark:text-gray-300';
  if (variant === 'outline') return 'border-gray-300 text-gray-500 bg-transparent dark:border-gray-700 dark:text-gray-400';
  return 'bg-gray-100 text-gray-400 border-transparent dark:bg-gray-900 dark:text-gray-600';
}

function resolve(
  status: string,
  variantOverride?: StatusChipVariant,
  toneOverride?: StatusChipTone,
): { label: string; tone: StatusChipTone; variant: StatusChipVariant } {
  const known = KNOWN[status.toLowerCase()];
  if (known) return { ...known, variant: variantOverride ?? known.variant, tone: toneOverride ?? known.tone };
  // Arbitrary label (e.g. a raw PR-state string, a human author's name) — render it verbatim,
  // uppercased. Neutral outline unless the caller names a tone, so an unknown label never
  // silently masquerades as a known status.
  return { label: status.toUpperCase(), tone: toneOverride ?? 'neutral', variant: variantOverride ?? 'outline' };
}

export interface StatusChipProps {
  status: string;
  variant?: StatusChipVariant;
  /** Override the mapped tone — see the tone ↔ reference-role map in the component doc. */
  tone?: StatusChipTone;
  className?: string;
}

export const StatusChip: React.FC<StatusChipProps> = ({ status, variant, tone, className }) => {
  const meta = resolve(status, variant, tone);
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide ${toneClasses(meta.tone, meta.variant)} ${className ?? ''}`}
      title={status}
    >
      {meta.label}
    </span>
  );
};
