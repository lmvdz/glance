/**
 * factoryStatus — client-side types + pure render helpers for the Factory status strip.
 *
 * The server (GET /api/factory/status, src/factory-status.ts) derives the authoritative per-loop
 * status enum; this module only maps that enum to the strip's ember-theme visuals and formats the
 * heartbeat age. Kept pure + DOM-free so the display logic is unit-tested without a browser.
 */

export type FactoryLoopStatus = 'off' | 'not-armed' | 'idle' | 'moving';

export interface FactoryLoopReport {
  loop: string;
  label: string;
  blurb: string;
  flagEnabled: boolean;
  armed: boolean;
  notArmedReason?: string;
  fix?: string;
  lastTickAt?: number;
  secondsSinceLastTick?: number;
  stale: boolean;
  lastSkipReason?: string;
  status: FactoryLoopStatus;
}

export interface FactoryStatus {
  generatedAt: number;
  activeAgents: number;
  planeRepoCount: number;
  loops: FactoryLoopReport[];
  overall: FactoryLoopStatus;
}

export interface StatusMeta {
  /** One-word label for the chip/headline. */
  label: string;
  /** Dot fill color class. */
  dot: string;
  /** Text color class for the label. */
  text: string;
  /** Chip border color class. */
  border: string;
  /** Chip background tint class. */
  bg: string;
  /** Whether the dot should visibly breathe (a live heartbeat), so idle-but-alive is legibly awake. */
  breathe: boolean;
  /** Whether the dot should emit a ping ring (active motion). */
  ping: boolean;
}

/**
 * Status → visuals. Ember (#F0A35A → amber-*) is the one warm live signal; a moving loop breathes +
 * pings green, an idle-but-alive loop breathes amber (awake, nothing to do), not-armed is a solid
 * amber warning (needs the operator), off is a dim static gray dot.
 */
export const STATUS_META: Record<FactoryLoopStatus, StatusMeta> = {
  moving: {
    label: 'Moving',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-300 dark:border-emerald-800/70',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    breathe: true,
    ping: true,
  },
  idle: {
    label: 'Idle',
    dot: 'bg-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-200 dark:border-amber-900/60',
    bg: 'bg-amber-50 dark:bg-amber-950/20',
    breathe: true,
    ping: false,
  },
  'not-armed': {
    label: 'Not armed',
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-300 dark:border-amber-800/70',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    breathe: false,
    ping: false,
  },
  off: {
    label: 'Off',
    dot: 'bg-gray-300 dark:bg-gray-600',
    text: 'text-gray-400 dark:text-gray-500',
    border: 'border-gray-200 dark:border-gray-800',
    bg: 'bg-gray-50 dark:bg-gray-900/40',
    breathe: false,
    ping: false,
  },
};

/** Headline sentence for the strip's overall status. */
export function overallHeadline(s: FactoryStatus): string {
  switch (s.overall) {
    case 'moving':
      return s.activeAgents > 0
        ? `Factory moving — ${s.activeAgents} agent${s.activeAgents === 1 ? '' : 's'} in flight`
        : 'Factory moving — loops producing';
    case 'not-armed':
      return 'Alive, but not fueled — loops are on with nothing to run';
    case 'idle':
      return 'Alive and idle — loops armed, nothing to do right now';
    case 'off':
      return 'Factory off — no autonomous loops running';
  }
}

/** The single-line reason to show under a loop chip, honest about the state. */
export function loopReasonLine(r: FactoryLoopReport): string | undefined {
  if (r.status === 'off') return r.flagEnabled ? undefined : 'flag off';
  if (r.status === 'not-armed') return r.notArmedReason;
  if (r.status === 'idle') return r.lastSkipReason ?? 'nothing to do this tick';
  return undefined; // moving needs no excuse
}

/** Compact "Ns / Nm / Nh ago" for the last heartbeat, or a dash when never ticked. */
export function fmtSince(seconds?: number): string {
  if (seconds === undefined) return '—';
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
