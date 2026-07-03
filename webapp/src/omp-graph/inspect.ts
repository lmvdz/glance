/**
 * InspectSel — what the operator clicked on the FleetPulse canvas. The inspector
 * pane routes on this; each variant carries just enough to fetch its detail.
 */

import type { PulseSession } from './pulse-model';

export type InspectSel =
  | { kind: 'commit'; sha: string; label: string; at: number }
  | { kind: 'ticket'; ticket: string; label: string; at: number }
  | { kind: 'run'; session: PulseSession }
  | { kind: 'hour'; at: number }
  | { kind: 'needs' }
  | { kind: 'cost' }
  | { kind: 'loop'; sub: string; label: string; at: number }
  | { kind: 'meeting'; label: string; at: number }
  | { kind: 'week'; index: number; label: string };

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
};
