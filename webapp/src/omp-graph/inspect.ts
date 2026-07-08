/**
 * InspectSel — what the operator clicked on the FleetPulse canvas. The inspector
 * pane routes on this; each variant carries just enough to fetch its detail.
 */

import type { PulseSession } from './pulse-model';
import type { Collision } from '../lib/insights';

export type InspectSel =
  | { kind: 'commit'; sha: string; label: string; at: number }
  | { kind: 'ticket'; ticket: string; label: string; at: number }
  | { kind: 'run'; session: PulseSession }
  | { kind: 'hour'; at: number }
  | { kind: 'needs' }
  | { kind: 'cost' }
  | { kind: 'loop'; sub: string; label: string; at: number }
  | { kind: 'meeting'; label: string; at: number }
  | { kind: 'week'; index: number; label: string }
  /** ≥2 LIVE agents holding the same path — the unified Heat/Federation collision signal,
   *  folded into the Graph (GRAPH-FOLD.md §2). Render-only-when-present: the marker and this
   *  selection only ever exist while the collision is live (see collision-track.ts's min-dwell). */
  | { kind: 'collision'; collision: Collision; at: number };

export const SEL_COLOR: Record<InspectSel['kind'], string> = {
  commit: '#F2913D',
  ticket: '#4CAF7A',
  run: '#4E7FDB',
  hour: '#F2913D',
  needs: '#E5484D',
  cost: '#C9B79A',
  loop: '#4E7FDB',
  meeting: '#2FB6D6',
  week: '#C9B79A',
  collision: '#E5484D',
};
