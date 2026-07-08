import React from 'react';

/**
 * StatusChip — the universal state language borrowed from the reference UIs
 * (plans/orchestration/UI-REFERENCES.md "Shared visual DNA"): a tiny uppercase
 * rounded-rect, filled for active work, dim once it's settled, outline for a
 * not-yet-live draft. The references use teal for "agent/active/good"; the
 * user's brand call keeps glance's ember in that role instead (brand.md's one
 * warm accent), so RUNNING/STARTING render ember, not teal. Every hex/CSS
 * value below is one of brand.md's tokens (via the existing `--wf-*` vars in
 * index.css) or the app's already-established Tailwind semantic ramp
 * (red/gray) — no new colors are introduced.
 *
 * `status` is intentionally a free string, not a strict union: this chip is
 * the shared contract three parallel units (roster rows, cockpit rails, the
 * task-pipeline session rows, the design-review gate) all render through, so
 * it must render *something* sensible for any label those screens pass in,
 * not just glance's own AgentStatus values.
 */

export type StatusChipVariant = 'solid' | 'outline' | 'dim';

type Tone = 'ember' | 'neutral' | 'danger' | 'attention';

interface StatusMeta {
  label: string;
  tone: Tone;
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
  // rather than inventing a fourth chip color.
  input: { label: 'NEEDS YOU', tone: 'attention', variant: 'solid' },
  error: { label: 'ERROR', tone: 'danger', variant: 'solid' },
  stopped: { label: 'DONE', tone: 'ember', variant: 'dim' },
  // Reference vocabulary (task pipeline rows, PR state, design-review gate)
  running: { label: 'RUNNING', tone: 'ember', variant: 'solid' },
  done: { label: 'DONE', tone: 'ember', variant: 'dim' },
  draft: { label: 'DRAFT', tone: 'neutral', variant: 'outline' },
  merged: { label: 'MERGED', tone: 'ember', variant: 'dim' },
  closed: { label: 'CLOSED', tone: 'danger', variant: 'outline' },
};

function toneClasses(tone: Tone, variant: StatusChipVariant): string {
  if (tone === 'ember') {
    if (variant === 'solid') return 'bg-[color:var(--wf-accent)] text-black border-transparent';
    if (variant === 'outline') return 'border-[color:var(--wf-accent)] text-[color:var(--wf-accent)] bg-transparent';
    return 'bg-[color:var(--wf-accent-soft)] text-[color:var(--wf-accent)] border-transparent';
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

function resolve(status: string, variantOverride?: StatusChipVariant): { label: string; tone: Tone; variant: StatusChipVariant } {
  const known = KNOWN[status.toLowerCase()];
  if (known) return { ...known, variant: variantOverride ?? known.variant };
  // Arbitrary label (e.g. a raw PR-state string like "Ready to merge") — render it verbatim,
  // uppercased, as a neutral chip so it never silently looks like a known status it isn't.
  return { label: status.toUpperCase(), tone: 'neutral', variant: variantOverride ?? 'outline' };
}

export interface StatusChipProps {
  status: string;
  variant?: StatusChipVariant;
  className?: string;
}

export const StatusChip: React.FC<StatusChipProps> = ({ status, variant, className }) => {
  const meta = resolve(status, variant);
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide ${toneClasses(meta.tone, meta.variant)} ${className ?? ''}`}
      title={status}
    >
      {meta.label}
    </span>
  );
};
