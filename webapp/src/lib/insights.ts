/**
 * insights.ts — pure synthesis layer for the dashboard.
 *
 * Panels should LEAD WITH A VERDICT, not dump raw numbers. Every function here
 * turns a raw daemon payload (governance / usage / heat / automation / agents)
 * into a human conclusion: a verdict, a prediction, and — where possible — an
 * action. No React, no fetch, no side effects: trivially unit-testable, and the
 * single source of truth that every panel reuses.
 *
 * Resource thresholds intentionally mirror the daemon watchdog
 * (src/watchdog.ts: maxLoadPerCpu=2×, minFreeRatio=0.1) so the UI verdict and
 * the daemon's own health.warnings never disagree.
 */

import { useEffect, useState } from 'react';
import type { AgentDTO } from './dto';

// ───────────────────────────── shared types ─────────────────────────────

/** Three-state posture used everywhere. `ok` is reserved for per-item rows. */
export type Verdict = 'healthy' | 'warn' | 'critical';

/** Health sample carried inside GET /api/governance.health.sample. */
export interface HealthSample {
  rssMb: number;
  load1: number;
  ncpu: number;
  /** free / total host memory, 0–1. */
  freeRatio: number;
  /** live (non-terminal) roster agents the daemon counted. */
  agents: number;
  hosts: number;
}

/** Shape of GET /api/governance (subset the UI consumes). */
export interface GovernancePayload {
  wipCap: number;
  maxAgents: number;
  health: {
    sample: HealthSample;
    warnings: string[];
    at: number;
  };
  federation?: { coordinator: boolean; dbRegistry: boolean };
}

/** One completed/in-flight run, from GET /api/usage.runs[]. */
export interface UsageRun {
  agentId: string;
  name: string;
  repo: string;
  branch?: string;
  status: string;
  filesTouched?: string[];
  durationMs?: number;
  costUsd?: number;
  tokens?: { total: number } | number;
  endedAt?: number;
  startedAt?: number;
}

/** Shape of GET /api/usage (subset). */
export interface UsagePayload {
  runs: UsageRun[];
  costUsd?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  agents?: number;
}

/** One file/day matrix row from GET /api/heat.tree[]. */
export interface HeatNode {
  id: string;
  name?: string;
  type?: string;
  depth?: number;
  /** per-day touch counts, aligned to `days`. */
  heat: number[];
}

/** Shape of GET /api/heat (subset). */
export interface HeatPayload {
  days: string[];
  tree: HeatNode[];
  hotAreas?: { path: string; heat: number }[];
  insights?: string[];
}

/** One per-loop rollup from GET /api/automation.rollup[]. */
export interface AutomationRollup {
  loop: string;
  events: number;
  llmCalls: number;
  found: number;
  filed: number;
  spawned?: number;
  errors?: number;
  lastAt: number;
}

/** Server-built action item from GET /api/action-items.items[]. */
export interface ServerActionItem {
  id: string;
  severity: 'low' | 'medium' | 'high';
  source: 'ui' | 'tool' | 'agent' | 'land' | 'health';
  subject: string;
  rootCause: string;
  nextAction: string;
  targetRoute?: string;
  agentId?: string;
  requestId?: string;
}

// ───────────────────────────── capacity ─────────────────────────────

export interface CapacitySummary {
  /** live agents (= governance.health.sample.agents). */
  used: number;
  /** WIP cap (governance.wipCap). */
  cap: number;
  /** how many MORE agents can actually start: min(cap room, resource headroom). */
  roomFor: number;
  verdict: Verdict;
  /** human sentence, e.g. "room for 2 more agents" / "at WIP cap — new work queues". */
  headline: string;
  /** which resource gates the next spawn first, if any. */
  nextLimit?: string;
  /** daemon RSS as a % of the 1024MB ceiling (0–100+, clamped display by caller). */
  memPct: number;
  /** load1 per CPU as a % of the 2× ceiling (0–100+). */
  loadPct: number;
}

const MEM_CEILING_MB = 1024; // OMP_SQUAD_MAX_RSS_MB default
const MAX_LOAD_PER_CPU = 2; // OMP_SQUAD_MAX_LOAD_PER_CPU default
const MIN_FREE_RATIO = 0.1; // OMP_SQUAD_MIN_FREE_RATIO default

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Turn governance into a capacity verdict + prediction. `roomFor` is the binding
 * constraint: you can only spawn as many agents as BOTH the WIP cap AND host
 * resources allow. When a resource (not the cap) is the binding constraint we
 * name it in `nextLimit` so the operator knows what to fix.
 */
export function computeCapacity(gov: GovernancePayload | null | undefined): CapacitySummary {
  const cap = Math.max(0, gov?.wipCap ?? 0);
  const sample = gov?.health?.sample;
  const used = Math.max(0, sample?.agents ?? 0);
  const warnings = gov?.health?.warnings ?? [];

  const memPct = sample ? (sample.rssMb / MEM_CEILING_MB) * 100 : 0;
  const loadPct = sample && sample.ncpu > 0 ? (sample.load1 / sample.ncpu / MAX_LOAD_PER_CPU) * 100 : 0;
  const freeRatio = sample?.freeRatio ?? 1;

  const capRoom = Math.max(0, cap - used);

  // Resource headroom: if any limit is already breached, headroom is 0 — the
  // host can't safely take another agent. Otherwise the cap is the only gate.
  const memBreached = memPct >= 100;
  const loadBreached = loadPct >= 100;
  const freeBreached = freeRatio < MIN_FREE_RATIO;
  const resourceBreached = memBreached || loadBreached || freeBreached || warnings.length > 0;
  const resourceHeadroom = resourceBreached ? 0 : capRoom;

  const roomFor = Math.min(capRoom, resourceHeadroom);

  // Which constraint bites first?
  let nextLimit: string | undefined;
  if (loadBreached) nextLimit = `host load (${loadPct.toFixed(0)}% of ${MAX_LOAD_PER_CPU}×/CPU)`;
  else if (freeBreached) nextLimit = `free memory (${Math.round(freeRatio * 100)}% left)`;
  else if (memBreached) nextLimit = `daemon memory (${Math.round(memPct)}% of ${MEM_CEILING_MB}MB)`;
  else if (resourceBreached && warnings[0]) nextLimit = warnings[0];
  else if (capRoom === 0) nextLimit = `WIP cap (${cap})`;
  else {
    // Predict the nearest approaching limit even while still healthy.
    const proximity: Array<[number, string]> = [
      [loadPct, `host load (${loadPct.toFixed(0)}% of ${MAX_LOAD_PER_CPU}×/CPU)`],
      [memPct, `daemon memory (${Math.round(memPct)}% of ${MEM_CEILING_MB}MB)`],
      [(1 - freeRatio / MIN_FREE_RATIO) * 0, ''], // free-ratio proximity handled via warnings; skip noise
    ];
    const nearest = proximity.filter(([, label]) => label).sort((a, b) => b[0] - a[0])[0];
    if (nearest && nearest[0] >= 75) nextLimit = `approaching ${nearest[1]}`;
    else nextLimit = `WIP cap (${cap})`;
  }

  // Verdict: critical when a resource is breached OR the daemon warned; warn when
  // there's no room left to spawn (cap reached) or we're near a limit; else healthy.
  let verdict: Verdict;
  if (resourceBreached) verdict = 'critical';
  else if (roomFor === 0 || loadPct >= 75 || memPct >= 75) verdict = 'warn';
  else verdict = 'healthy';

  // Headline.
  let headline: string;
  if (resourceBreached) {
    headline = `host is saturated — ${nextLimit ?? 'a resource limit'} blocks new agents`;
  } else if (capRoom === 0) {
    headline = `at WIP cap (${used}/${cap}) — new work queues`;
  } else if (roomFor > 0) {
    headline = `room for ${plural(roomFor, 'more agent')} (${used}/${cap} running)`;
  } else {
    headline = `${used}/${cap} agents running`;
  }

  return { used, cap, roomFor, verdict, headline, nextLimit, memPct, loadPct };
}

// ───────────────────────────── collisions ─────────────────────────────

export interface Collision {
  file: string;
  agents: { id: string; name: string }[];
}

const LIVE_STATUSES: ReadonlySet<AgentDTO['status']> = new Set(['working', 'starting', 'input', 'idle']);

/**
 * Files that ≥2 DISTINCT currently-live agents have touched — the early-warning
 * signal for a merge collision. We intersect usage.runs (which carry
 * filesTouched) with the live roster, group by file, and rank by how many agents
 * are colliding. Sorted by agent count desc, then file path for stability.
 */
export function detectCollisions(runs: UsageRun[] | null | undefined, agents: AgentDTO[] | null | undefined): Collision[] {
  const live = new Map<string, AgentDTO>();
  for (const a of agents ?? []) {
    if (LIVE_STATUSES.has(a.status)) live.set(a.id, a);
  }
  if (live.size === 0) return [];

  // file -> set of live agent ids (dedup runs of the same agent on the same file)
  const byFile = new Map<string, Map<string, { id: string; name: string }>>();
  for (const run of runs ?? []) {
    const agent = live.get(run.agentId);
    if (!agent) continue;
    for (const file of run.filesTouched ?? []) {
      if (!file) continue;
      let set = byFile.get(file);
      if (!set) byFile.set(file, (set = new Map()));
      set.set(agent.id, { id: agent.id, name: agent.name });
    }
  }

  const collisions: Collision[] = [];
  for (const [file, set] of byFile) {
    if (set.size >= 2) {
      collisions.push({ file, agents: [...set.values()].sort((a, b) => a.name.localeCompare(b.name)) });
    }
  }
  collisions.sort((a, b) => b.agents.length - a.agents.length || a.file.localeCompare(b.file));
  return collisions;
}

// ───────────────────────────── churn hotspots ─────────────────────────────

export interface ChurnHotspot {
  path: string;
  /** total touches across the window. */
  heat: number;
  /** how many distinct agents touched this file (from usage.runs.filesTouched). */
  agentCount: number;
  /** per-day touch counts aligned to heat.days. */
  daily: number[];
}

/**
 * Rank the hottest files and enrich each with how many DISTINCT agents touched
 * it. Heat (per-day matrix) tells us WHERE work concentrates; agentCount tells us
 * whether that concentration is one focused agent or a contended hotspot.
 */
export function churnHotspots(
  heat: HeatPayload | null | undefined,
  runs: UsageRun[] | null | undefined,
  limit = 8,
): ChurnHotspot[] {
  const agentsByFile = new Map<string, Set<string>>();
  for (const run of runs ?? []) {
    for (const file of run.filesTouched ?? []) {
      if (!file) continue;
      let set = agentsByFile.get(file);
      if (!set) agentsByFile.set(file, (set = new Set()));
      set.add(run.agentId);
    }
  }

  const tree = heat?.tree ?? [];
  const rows: ChurnHotspot[] = tree.map((node) => {
    const daily = node.heat ?? [];
    const total = daily.reduce((a, b) => a + (b || 0), 0);
    return {
      path: node.id,
      heat: total,
      agentCount: agentsByFile.get(node.id)?.size ?? 0,
      daily,
    };
  });

  return rows
    .filter((r) => r.heat > 0)
    .sort((a, b) => b.heat - a.heat || b.agentCount - a.agentCount || a.path.localeCompare(b.path))
    .slice(0, limit);
}

// ───────────────────────────── automation digest ─────────────────────────────

export interface AutomationDigest {
  spentUsd: number;
  llmCalls: number;
  ticketsFiled: number;
  agentsSpawned: number;
  /** candidates the dispatch/opportunity loops scanned (found). */
  candidates: number;
  anomalies: { loop: string; message: string }[];
  scoutBudget: { used: number; cap: number };
}

/**
 * Compress the per-loop rollups into a single "what did automation cost & do"
 * digest, and — crucially — surface ANOMALIES. The signature anomaly is
 * "scanned a lot, did nothing": Dispatch finding N candidates but spawning 0
 * usually means the WIP cap or a filter is silently swallowing work.
 */
export function automationDigest(
  rollup: AutomationRollup[] | null | undefined,
  usage: UsagePayload | null | undefined,
  scoutCap = 30,
): AutomationDigest {
  const rows = rollup ?? [];
  const sum = (pick: (r: AutomationRollup) => number) => rows.reduce((acc, r) => acc + (pick(r) || 0), 0);

  const llmCalls = sum((r) => r.llmCalls);
  const ticketsFiled = sum((r) => r.filed);
  const agentsSpawned = sum((r) => r.spawned ?? 0);
  const candidates = sum((r) => r.found);
  const spentUsd = usage?.costUsd ?? 0;

  const anomalies: { loop: string; message: string }[] = [];
  for (const r of rows) {
    // Found a lot, acted on none → cap or filter is eating work.
    if ((r.found ?? 0) >= 3 && (r.spawned ?? 0) === 0 && (r.filed ?? 0) === 0) {
      anomalies.push({
        loop: r.loop,
        message: `${cap1(r.loop)} scanned ${plural(r.found, 'candidate')}, spawned 0 — WIP cap or filter?`,
      });
    } else if (r.loop === 'dispatch' && (r.found ?? 0) >= 1 && (r.spawned ?? 0) === 0) {
      anomalies.push({
        loop: r.loop,
        message: `Dispatch saw ${plural(r.found, 'candidate')} but spawned none — likely at WIP cap.`,
      });
    }
    if ((r.errors ?? 0) > 0) {
      anomalies.push({ loop: r.loop, message: `${cap1(r.loop)} logged ${plural(r.errors!, 'error')} in this window.` });
    }
  }

  const scoutRow = rows.find((r) => r.loop === 'scout');
  const scoutUsed = scoutRow?.llmCalls ?? 0;
  if (scoutUsed >= scoutCap) {
    anomalies.push({ loop: 'scout', message: `Scout hit its LLM budget (${scoutUsed}/${scoutCap}) — token spend is capped out.` });
  }

  return {
    spentUsd,
    llmCalls,
    ticketsFiled,
    agentsSpawned,
    candidates,
    anomalies,
    scoutBudget: { used: scoutUsed, cap: scoutCap },
  };
}

function cap1(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ───────────────────────────── attention items ─────────────────────────────

export type AttentionSeverity = 'critical' | 'warn' | 'ok';
export type AttentionKind = 'blocked' | 'land-ready' | 'error' | 'resource' | 'collision';
export type AttentionActionKind = 'answer' | 'land' | 'restart' | 'view' | 'raise-cap';

export interface AttentionAction {
  label: string;
  kind: AttentionActionKind;
}

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  kind: AttentionKind;
  title: string;
  detail?: string;
  agentId?: string;
  /** pending request id, for the answer flow. */
  requestId?: string;
  /** when the underlying thing started mattering (lastActivity / generatedAt), for an age label. */
  since?: number;
  action?: AttentionAction;
}

export interface AttentionInput {
  actionItems?: ServerActionItem[];
  agents?: AgentDTO[];
  capacity?: CapacitySummary | null;
  collisions?: Collision[];
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warn: 1, ok: 2 };

/**
 * The heart of the "Needs you" panel: aggregate every actionable signal across
 * the fleet into one sorted list, each row carrying the ONE action that resolves
 * it. We compute client-side from the live roster (authoritative & instant) and
 * fold in the server action-items only for things the client can't see (health),
 * de-duplicating by agent so a blocked agent never appears twice.
 *
 * Sort: critical → warn → ok, then most-recently-relevant first.
 */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const agents = input.agents ?? [];
  const items: AttentionItem[] = [];
  const seenAgentKinds = new Set<string>();

  const mark = (agentId: string | undefined, kind: AttentionKind) => {
    if (agentId) seenAgentKinds.add(`${kind}:${agentId}`);
  };

  for (const a of agents) {
    // Blocked: needs an answer (status input OR a pending request).
    if (a.status === 'input' || a.pending.length > 0) {
      const pending = a.pending[0];
      items.push({
        id: `blocked:${a.id}`,
        severity: 'critical',
        kind: 'blocked',
        title: `${a.name} is waiting on you`,
        detail: pending?.title ?? pending?.message ?? 'Agent is blocked on operator input.',
        agentId: a.id,
        requestId: pending?.id,
        since: pending?.createdAt ?? a.lastActivity,
        action: { label: 'Answer', kind: 'answer' },
      });
      mark(a.id, 'blocked');
      continue; // a blocked agent's other states are moot until answered
    }

    // Errored / catastrophe → restart (or view to diagnose).
    if (a.status === 'error') {
      items.push({
        id: `error:${a.id}`,
        severity: 'critical',
        kind: 'error',
        title: `${a.name} errored`,
        detail: a.error ?? 'Agent reported an error and stopped.',
        agentId: a.id,
        since: a.lastActivity,
        action: { label: 'Restart', kind: 'restart' },
      });
      mark(a.id, 'error');
      continue;
    }

    // Ready to land → land.
    if (a.landReady) {
      items.push({
        id: `land:${a.id}`,
        severity: 'warn',
        kind: 'land-ready',
        title: `${a.name} is ready to land`,
        detail: a.issue?.name ? `Verified — ${a.issue.name}` : 'Verification passed; holding for your confirmation.',
        agentId: a.id,
        since: a.lastActivity,
        action: { label: 'Land', kind: 'land' },
      });
      mark(a.id, 'land-ready');
    }
  }

  // Collisions: ≥2 live agents on one file → view.
  for (const c of input.collisions ?? []) {
    items.push({
      id: `collision:${c.file}`,
      severity: 'warn',
      kind: 'collision',
      title: `${c.agents.length} agents editing ${shortPath(c.file)}`,
      detail: `${c.agents.map((a) => a.name).join(', ')} are all touching this file — expect a merge collision.`,
      agentId: c.agents[0]?.id,
      action: { label: 'View', kind: 'view' },
    });
  }

  // Resource pressure from capacity → raise-cap / nothing-to-do.
  const cap = input.capacity;
  if (cap && cap.verdict === 'critical') {
    items.push({
      id: 'resource:critical',
      severity: 'critical',
      kind: 'resource',
      title: 'Host is saturated',
      detail: cap.headline,
      action: { label: 'Raise cap', kind: 'raise-cap' },
    });
  } else if (cap && cap.verdict === 'warn' && cap.roomFor === 0) {
    items.push({
      id: 'resource:cap',
      severity: 'warn',
      kind: 'resource',
      title: 'At WIP cap',
      detail: cap.headline,
      action: { label: 'Raise cap', kind: 'raise-cap' },
    });
  }

  // Fold in server action-items the client can't derive (health warnings),
  // skipping anything already represented by a live-roster row.
  for (const it of input.actionItems ?? []) {
    if (it.source === 'health') {
      items.push({
        id: it.id,
        severity: 'warn',
        kind: 'resource',
        title: it.subject,
        detail: it.rootCause,
        action: { label: 'View', kind: 'view' },
      });
      continue;
    }
    // pending/error/land already covered from the roster; skip duplicates.
    if (it.agentId) {
      const kind: AttentionKind | null =
        it.source === 'land' ? 'land-ready' : it.source === 'agent' ? 'error' : it.source === 'tool' || it.source === 'ui' ? 'blocked' : null;
      if (kind && seenAgentKinds.has(`${kind}:${it.agentId}`)) continue;
    }
  }

  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.since ?? 0) - (a.since ?? 0) || a.id.localeCompare(b.id));
  return items;
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

// ───────────────────────────── rolling history (sparklines) ─────────────────────────────

/**
 * Pure ring-buffer push — extracted so the hook stays a thin wrapper and the
 * capping logic is unit-testable without a DOM.
 */
export function pushRolling(prev: number[], value: number, max = 30): number[] {
  const next = [...prev, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Append `value` into a capped rolling window each time it changes — a tiny
 * history for inline sparklines. Returns the current window (oldest → newest).
 */
export function useRollingHistory(value: number, max = 30): number[] {
  const [history, setHistory] = useState<number[]>(() => (Number.isFinite(value) ? [value] : []));
  useEffect(() => {
    if (!Number.isFinite(value)) return;
    setHistory((prev) => pushRolling(prev, value, max));
  }, [value, max]);
  return history;
}
