/**
 * pulse-model — pure mapping from the wire GraphDoc (+ live roster) to the
 * arrays the FleetPulse canvas draws. Everything the composition needs is
 * derived here so the renderer stays geometry-only and this stays testable.
 *
 * Conventions: the time domain is epoch ms; per-hour arrays are indexed from
 * range.start at HOUR_MS. "Above the spine" = what the code did (milestones,
 * cost, commits); "below" = what the factory delivered (tickets, loop notes,
 * needs-you items, scheduled ghosts).
 */

import type { AgentDTO } from '../lib/dto';
import { isValidatorHeld } from '../lib/agent-badges';
import type { GraphDoc, GraphTrack } from './types';

export const HOUR_MS = 3_600_000;

export interface PulseSession {
  t0: number;
  t1: number;
  /** working | blocked | error | stopped — the pill palette. */
  status: 'working' | 'blocked' | 'error' | 'stopped';
  label: string;
  agentId?: string;
  live?: boolean;
  costUsd?: number;
  /** packed lane index (time-based greedy packing). */
  row: number;
}

export interface PulseMark {
  at: number;
  kind: string; // LAND | FEAT | FIX | DOCS | OTHER
  label: string;
  sha?: string;
  churn?: number;
  big?: boolean;
}

export type BelowKind = 'DONE' | 'BLOCKED' | 'READY' | 'MEETING' | 'LOOP';

export interface PulseEvent {
  at: number;
  kind: BelowKind;
  /** loop name for LOOP events (scout/observer/dispatch/…). */
  sub?: string;
  label: string;
  big?: boolean;
  ticket?: string;
  agentId?: string;
  requestId?: string;
}

export interface PulseModel {
  start: number;
  end: number;
  nowMs: number;
  bins: number;
  commits: number[];
  churn: number[];
  cost: number[];
  cum: number[];
  /** true where the fleet had a run in flight that hour. */
  active: boolean[];
  sessions: PulseSession[];
  milestones: PulseMark[];
  below: PulseEvent[];
  loopTicks: number[];
  needsCount: number;
}

const track = (doc: GraphDoc, id: string): GraphTrack | undefined => doc.tracks.find((t) => t.id === id);

/** A bars/series track as a per-hour array aligned to the doc range. Exported for the depth windows. */
export function hourBins(doc: GraphDoc, id: string): number[] {
  const n = Math.max(1, Math.ceil((doc.range.end - doc.range.start) / HOUR_MS));
  const out = new Array<number>(n).fill(0);
  const t = track(doc, id);
  if (!t) return out;
  const put = (at: number, v: number): void => {
    const i = Math.floor((at - doc.range.start) / HOUR_MS);
    if (i >= 0 && i < n) out[i] += v;
  };
  if (t.type === 'bars') for (const b of t.bins) put(b.t, b.v);
  else if (t.type === 'series') for (const p of t.points) put(p.t, p.v);
  return out;
}

const liveStatus = (s: AgentDTO['status']): PulseSession['status'] =>
  s === 'input' ? 'blocked' : s === 'error' ? 'error' : s === 'working' || s === 'starting' ? 'working' : 'stopped';

/** Greedy time-based lane packing (row identity is stable for a given session list). */
function packRows(sessions: Omit<PulseSession, 'row'>[]): PulseSession[] {
  const sorted = [...sessions].sort((a, b) => a.t0 - b.t0);
  const ends: number[] = [];
  return sorted.map((s) => {
    let row = ends.findIndex((e) => e <= s.t0);
    if (row === -1) {
      ends.push(s.t1 + HOUR_MS * 0.3);
      row = ends.length - 1;
    } else ends[row] = s.t1 + HOUR_MS * 0.3;
    return { ...s, row };
  });
}

export function buildPulseModel(doc: GraphDoc, agents: AgentDTO[]): PulseModel {
  const { start, end } = doc.range;
  const nowMs = Math.min(doc.generatedAt, end);
  const bins = Math.max(1, Math.ceil((end - start) / HOUR_MS));

  const commits = hourBins(doc, 'git.commits');
  const churn = hourBins(doc, 'git.churn');
  const cost = hourBins(doc, 'receipts.cost');
  const cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < bins; i++) {
    if (start + i * HOUR_MS <= nowMs) acc += cost[i];
    cum.push(acc);
  }

  const active = new Array<boolean>(bins).fill(false);
  const stateTrack = track(doc, 'receipts.state');
  if (stateTrack?.type === 'bands') {
    for (const seg of stateTrack.segments) {
      const a = Math.max(0, Math.floor((seg.t0 - start) / HOUR_MS));
      const b = Math.min(bins, Math.ceil((seg.t1 - start) / HOUR_MS));
      for (let i = a; i < b; i++) active[i] = true;
    }
  }

  // finished runs from receipts + LIVE agents as ongoing pills to now
  const raw: Omit<PulseSession, 'row'>[] = [];
  const sessTrack = track(doc, 'receipts.sessions');
  if (sessTrack?.type === 'spans') {
    for (const sp of sessTrack.spans) {
      raw.push({
        t0: sp.t0,
        t1: sp.t1,
        status: sp.status === 'error' ? 'error' : sp.status === 'working' || sp.status === 'input' ? 'working' : 'stopped',
        label: sp.label,
        costUsd: typeof sp.value === 'number' ? sp.value : undefined,
      });
    }
  }
  for (const a of agents) {
    if (a.status !== 'working' && a.status !== 'input' && a.status !== 'starting' && a.status !== 'error') continue;
    const t0 = a.startedAt ?? nowMs - HOUR_MS;
    if (t0 > end) continue;
    raw.push({ t0: Math.max(start, t0), t1: nowMs, status: liveStatus(a.status), label: a.name, agentId: a.id, live: true });
  }
  const sessions = packRows(raw);

  const milestones: PulseMark[] = [];
  const mTrack = track(doc, 'git.milestones');
  if (mTrack?.type === 'events') {
    const churns = mTrack.marks.map((m) => Number(m.meta?.churn ?? m.value ?? 0)).sort((a, b) => a - b);
    const p75 = churns[Math.floor(churns.length * 0.75)] ?? 0;
    for (const m of mTrack.marks) {
      const c = Number(m.meta?.churn ?? m.value ?? 0);
      milestones.push({
        at: m.t,
        kind: (m.kind ?? 'other').toUpperCase(),
        label: m.label,
        sha: typeof m.meta?.sha === 'string' ? m.meta.sha : undefined,
        churn: c,
        big: m.kind === 'land' || c >= p75,
      });
    }
  }

  const below: PulseEvent[] = [];
  const closed = track(doc, 'plane.closed');
  if (closed?.type === 'events') {
    for (const m of closed.marks) {
      const ticket = typeof m.meta?.id === 'string' ? m.meta.id : undefined;
      below.push({ at: m.t, kind: 'DONE', label: m.label, ticket, big: true });
    }
  }
  const loops = track(doc, 'automation.loops');
  const loopTicks: number[] = [];
  if (loops?.type === 'events') {
    for (const m of loops.marks) {
      loopTicks.push(m.t);
      // only ticks that DID something become hanging notes; heartbeats stay ticks
      if (m.meta?.filed || m.meta?.spawned) below.push({ at: m.t, kind: 'LOOP', sub: String(m.kind ?? 'loop'), label: m.label });
    }
  }
  const meetings = track(doc, 'gcal.meetings');
  if (meetings?.type === 'spans') {
    for (const sp of meetings.spans) if (sp.t0 > nowMs) below.push({ at: sp.t0, kind: 'MEETING', label: sp.label });
  }
  // the imperative layer, straight from the live roster
  let needsCount = 0;
  for (const a of agents) {
    if (a.status === 'input') {
      const req = a.pending[0];
      needsCount++;
      below.push({
        at: nowMs - HOUR_MS * 0.5,
        kind: 'BLOCKED',
        label: `${a.name} · ${req?.title ?? 'needs an answer'}`,
        big: true,
        agentId: a.id,
        requestId: req?.id,
      });
    } else if (a.landReady || a.availableActions?.includes('land')) {
      needsCount++;
      // A vetoed or inconclusive verdict must never read as the calm "proof green, awaiting land" —
      // that's the fail-open isValidatorHeld exists to close (see agent-badges.ts). It still needs a
      // human, so it stays in the same BLOCKED/READY "needs" inspection lane (FleetPulseCanvas routes
      // both kinds to the same panel) — just not mislabeled as a clean pass.
      below.push(
        isValidatorHeld(a)
          ? { at: nowMs, kind: 'BLOCKED', label: `${a.name} · validator held (${a.validation?.verdict})`, big: true, agentId: a.id }
          : { at: nowMs, kind: 'READY', label: `${a.name} · proof green, awaiting land`, big: true, agentId: a.id },
      );
    }
  }
  below.sort((a, b) => a.at - b.at);

  return { start, end, nowMs, bins, commits, churn, cost, cum, active, sessions, milestones, below, loopTicks, needsCount };
}
