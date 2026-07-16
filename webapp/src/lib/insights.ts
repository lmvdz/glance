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
import { isValidatorHeld } from './agent-badges';
import type { AgentDTO, FeatureDTO, IssueRef } from './dto';

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
  /** Human-readable reason for the loop's most-recent no-work tick, when it was intentionally idle. */
  lastSkipReason?: string;
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

/** One `taskClass × model` cell from GET /api/graph/task-class.cells[taskClass][model] — mirrors
 *  `CellMetrics` in src/omp-graph/task-class-matrix.ts. OBSERVATIONAL, never a causal comparison —
 *  see `TaskClassMatrixPayload.note`. */
export interface TaskClassCell {
  n: number;
  landed: number;
  mergeRate: number;
  medianCostUsd?: number;
  nWithCost: number;
  costCoveragePct: number;
  medianConfidence?: number;
  inRunReworkRate?: number;
  insufficientData: boolean;
}

/** Shape of GET /api/graph/task-class (subset). `causal` is always `false` — the router's own
 *  routing choices, not a randomized comparison; `note` is the mandatory honesty label every panel
 *  built on this payload must render prominently. */
export interface TaskClassMatrixPayload {
  taskClasses: string[];
  models: string[];
  cells: Record<string, Record<string, TaskClassCell>>;
  totalUnits: number;
  totalLanded: number;
  minSamples: number;
  causal: false;
  note: string;
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

/** Render the used/cap pair for the capacity chip (taste-review nit 5). A plain "6/3" reads as a
 *  fraction bug once `used` exceeds `cap` — which happens routinely (e.g. the WIP cap was lowered
 *  while agents were already running) — so once over cap, spell it out instead of dividing. */
export function capacityFractionLabel(used: number, cap: number): string {
  return used > cap ? `${used} · cap ${cap}` : `${used}/${cap}`;
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

// churnHotspots (the HeatPanel magma tree's ranking) was deleted with the Heat map page —
// GRAPH-FOLD.md §1 verdict: the churn tree is a data-dump, and churn-over-time is already the
// pulse ridge. detectCollisions/flappingAgents survive: the Fleet view's NEEDS-YOU rows and the
// Graph's collision marker are built on them.

// ───────────────────────────── flapping agents ─────────────────────────────

export interface FlappingAgent {
  agentId: string;
  name: string;
  errorTransitions1h: number;
}

/** Agents that have errored/caught-fire repeatedly in the last hour — a signal a capped client-side
 *  transitions tail cannot produce (it truncates at 5 entries and would undercount exactly the
 *  busiest/most error-prone agents). Server computes this over the full ring; we just rank it. */
export function flappingAgents(agents: AgentDTO[] | null | undefined, minCount = 2): FlappingAgent[] {
  return (agents ?? [])
    .filter((a) => (a.errorTransitions1h ?? 0) >= minCount)
    .map((a) => ({ agentId: a.id, name: a.name, errorTransitions1h: a.errorTransitions1h ?? 0 }))
    .sort((a, b) => b.errorTransitions1h - a.errorTransitions1h);
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
  /** Loops that are alive but intentionally idle — a recent skip reason, not silence. */
  idle: { loop: string; reason: string; idleMs: number }[];
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
  now = Date.now(),
): AutomationDigest {
  const rows = rollup ?? [];
  const sum = (pick: (r: AutomationRollup) => number) => rows.reduce((acc, r) => acc + (pick(r) || 0), 0);

  const llmCalls = sum((r) => r.llmCalls);
  const ticketsFiled = sum((r) => r.filed);
  const agentsSpawned = sum((r) => r.spawned ?? 0);
  const candidates = sum((r) => r.found);
  const spentUsd = usage?.costUsd ?? 0;

  const anomalies: { loop: string; message: string }[] = [];
  const idle: { loop: string; reason: string; idleMs: number }[] = [];
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

    // Idle-vs-stuck: a loop past ~3× its interval is silent. If its newest tick
    // named a skip reason, it's alive-but-idle (healthy); otherwise it's stuck.
    const idleMs = r.lastAt > 0 ? now - r.lastAt : 0;
    if (r.lastSkipReason && idleMs <= loopIntervalMs(r.loop) * 3) {
      idle.push({ loop: r.loop, reason: r.lastSkipReason, idleMs });
    } else if (r.lastAt > 0 && idleMs > loopIntervalMs(r.loop) * 3) {
      anomalies.push({ loop: r.loop, message: `${cap1(r.loop)} has not reported for ${fmtIdle(idleMs)} — loop may be stuck.` });
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
    idle,
    scoutBudget: { used: scoutUsed, cap: scoutCap },
  };
}

function cap1(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Nominal cadence per loop — the digest flags a loop as "stuck" past ~3× this. */
function loopIntervalMs(loop: string): number {
  if (loop === 'scout') return 60_000;
  if (loop === 'dispatch') return 30_000;
  // "scope" is event-driven (audit findings on demand), not periodic — never flag it as stuck.
  if (loop === 'scope') return 24 * 60 * 60_000;
  return 300_000;
}

function fmtIdle(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ───────────────────────────── attention items ─────────────────────────────

export type AttentionSeverity = 'critical' | 'warn' | 'ok';
export type AttentionKind = 'blocked' | 'vetoed' | 'inconclusive' | 'land-ready' | 'error' | 'resource' | 'collision' | 'flapping' | 'stalled' | 'report' | 'attention';
export type AttentionActionKind = 'answer' | 'land' | 'restart' | 'view' | 'raise-cap' | 'steer' | 'apply-sync' | 'discard-sync';

/** Epic 5 (HITL safeguards, DESIGN.md D3): a working agent is considered drifting once it's gone
 *  this long without any activity — the only robustly-computable, always-present staleness signal
 *  on the DTO. Surfaces a "stalled" row whose action redirects it with a fresh steering turn. */
const STALL_MS = 15 * 60_000;

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
  /** A second, lesser resolution rendered beside `action` — today only boundary-sync "held" rows
   *  (Apply + Discard: two genuinely different outcomes for the same held backlog). */
  secondaryAction?: AttentionAction;
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
 * Sort: critical → warn → ok, then most-recently-relevant first (default
 * `"severity"`); pass `opts.sort = "blocked-longest"` to instead rank the
 * WHOLE list by age (oldest `since` first, undated rows last) so the operator
 * can see who's been waiting the longest, cmux-notification-rings style.
 */
export function attentionItems(input: AttentionInput, opts?: { sort?: 'severity' | 'blocked-longest' }): AttentionItem[] {
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

    // Flapping: errored ≥2x in the last hour — structurally wrong, distinct from a one-off error.
    if (a.status === 'error' && (a.errorTransitions1h ?? 0) >= 2) {
      items.push({
        id: `flapping:${a.id}`,
        severity: 'critical',
        kind: 'flapping',
        title: `${a.name} is flapping (${a.errorTransitions1h}x/hr)`,
        detail: a.error ?? 'Agent has errored repeatedly in the last hour — something is structurally wrong.',
        agentId: a.id,
        since: a.lastActivity,
        action: { label: 'Restart', kind: 'restart' },
      });
      mark(a.id, 'flapping');
      mark(a.id, 'error'); // still fundamentally an error state — dedupes a server-reported error action item too
      continue;
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

    // Validator veto → review. A green proof the INDEPENDENT judge rejected: the single most
    // important land-time "needs you" event, and it must NOT read as a calm "ready to land" row.
    if (a.landReady && a.validation?.verdict === 'veto') {
      items.push({
        id: `veto:${a.id}`,
        severity: 'critical',
        kind: 'vetoed',
        title: `${a.name} was vetoed by the validator`,
        detail: a.validation.rationale || 'The independent validator rejected this change despite a green proof — review before landing.',
        agentId: a.id,
        since: a.lastActivity,
        action: { label: 'Review', kind: 'view' },
      });
      mark(a.id, 'vetoed');
      mark(a.id, 'land-ready'); // suppress the calm land-ready row below for the same agent
    }

    // Validator inconclusive → hold, not a pass. eap-borrows follow-up 7: the land diff couldn't be
    // COMPUTED (a git fault), not a semantic rejection — but it is still NOT safe to read as "ready to
    // land": a bare `verdict !== 'veto'` check below would silently treat this the same as a clean pass
    // (the fail-open a blind review caught). It auto-retries on the bounded escalation lane; a force-land
    // does NOT bypass it (there's no diff to grade), so this is informational, not actionable.
    if (a.landReady && a.validation?.verdict === 'inconclusive') {
      items.push({
        id: `inconclusive:${a.id}`,
        severity: 'warn',
        kind: 'inconclusive',
        title: `${a.name}'s land diff is inconclusive`,
        detail: a.validation.rationale || 'The land diff could not be computed (environmental git fault) — retrying automatically.',
        agentId: a.id,
        since: a.lastActivity,
        action: { label: 'View', kind: 'view' },
      });
      mark(a.id, 'inconclusive');
      mark(a.id, 'land-ready'); // suppress the calm land-ready row below for the same agent
    }

    // Ready to land → land. A veto/inconclusive hold is handled above and must not ALSO show a calm
    // land row — a bare `!== 'veto'` check here would silently read an inconclusive hold as a pass.
    if (a.landReady && !isValidatorHeld(a)) {
      const canLand = a.availableActions === undefined || a.availableActions.includes('land');
      items.push({
        id: `land:${a.id}`,
        severity: 'warn',
        kind: 'land-ready',
        title: `${a.name} is ready to land`,
        detail: canLand ? (a.issue?.name ? `Verified — ${a.issue.name}` : 'Verification passed; holding for your confirmation.') : (a.blockedReason ?? `Mode ${a.effectiveMode} cannot land right now.`),
        agentId: a.id,
        since: a.lastActivity,
        action: canLand ? { label: 'Land', kind: 'land' } : { label: 'View', kind: 'view' },
      });
      mark(a.id, 'land-ready');
    }

    // Gone quiet mid-flight (DESIGN.md D3: activity-staleness) → steer it back on track.
    if (a.status === 'working' && Date.now() - a.lastActivity > STALL_MS) {
      items.push({
        id: `stalled:${a.id}`,
        severity: 'warn',
        kind: 'stalled',
        title: `${a.name} has gone quiet`,
        detail: 'No activity for a while — it may be stuck or drifting. Steer it back on track.',
        agentId: a.id,
        since: a.lastActivity,
        action: { label: 'Steer', kind: 'steer' },
      });
      mark(a.id, 'stalled');
    }

    // Non-blocking proposals (DESIGN.md D2: squad_report / low-confidence auto-escalation) → view.
    // Deliberately independent of `status` — a report never blocks, so it can appear on a `working`
    // agent exactly as intended.
    for (const r of a.reports ?? []) {
      items.push({
        id: `report:${a.id}:${r.id}`,
        severity: 'warn',
        kind: 'report',
        title: `${a.name} raised a proposal`,
        detail: r.proposal ? `${r.summary} — ${r.proposal}` : r.summary,
        agentId: a.id,
        since: r.createdAt,
        action: { label: 'View', kind: 'view' },
      });
    }

    // Harness-agnostic attention lane (v2 glance-notify: operator notify / squad_attention tool /
    // harness notify RPC) → view. Same non-blocking contract as reports: independent of `status`.
    // Boundary-sync rows (daily-onramp 03) split on what the row actually HOLDS:
    //   - "held" (durable patches are waiting): one-click Apply (re-checked server-side before
    //     touching anything) plus Discard (drop the backlog; the worktree keeps every edit) —
    //     "View" would bury the two actions that resolve the row.
    //   - "uncapturable" (the turn's delta couldn't even be captured — NOTHING is held): View
    //     only. Apply here would return applied:0 and read as "already current" — false
    //     reassurance, since that turn's edits exist only in the session worktree.
    for (const e of a.attentionEvents ?? []) {
      const sync = e.source === 'boundary-sync';
      const held = sync && e.sync !== 'uncapturable';
      items.push({
        id: `attention:${a.id}:${e.id}`,
        severity: 'warn',
        kind: 'attention',
        title: sync ? e.summary : `${a.name} needs a look`,
        detail: sync ? e.detail : e.detail ? `${e.summary} — ${e.detail}` : e.summary,
        agentId: a.id,
        since: e.createdAt,
        action: held ? { label: 'Apply', kind: 'apply-sync' } : { label: 'View', kind: 'view' },
        secondaryAction: held ? { label: 'Discard', kind: 'discard-sync' } : undefined,
      });
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

  // Resource pressure from capacity → raise-cap / nothing-to-do. Deliberately NOT emitted for the
  // routine "at WIP cap, no headroom" case (taste-review nit 4): a busy-but-healthy fleet sitting
  // at its configured cap is normal operation, not a blocker — it's already the header's capacity
  // chip (FactoryStatusStrip / WorkspaceCockpit's rail header), so a standing NEEDS YOU row for it
  // just pushed real blockers down the rail. A genuinely saturated HOST (verdict === 'critical', an
  // actual resource limit breached) is the rare case that still deserves its own "needs you" row.
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

  if (opts?.sort === 'blocked-longest') {
    items.sort((a, b) => {
      if (a.since == null && b.since == null) return a.id.localeCompare(b.id);
      if (a.since == null) return 1; // undated rows last
      if (b.since == null) return -1;
      return a.since - b.since || a.id.localeCompare(b.id);
    });
  } else {
    items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.since ?? 0) - (a.since ?? 0) || a.id.localeCompare(b.id));
  }
  return items;
}

// ───────────────────────────── harness scorecard (own diagnostic surface) ─────────────────────────────
//
// Deliberately NOT folded into `attentionItems`/`AttentionKind`: the deferred design
// (plans/research-learn-harness-engineering/03-harness-scorecard-shadow.md) explicitly named
// alert-fatigue as a risk of routing a threshold-gated static score through the shared "attention"
// lane — it would bury real "needs-you" events under structural-completeness noise. This is a
// separate, own-purpose read-model: a static, pre-dispatch DIAGNOSTIC (context-poor units become
// visible at admission), not an actionable "something needs a human now" signal. A panel may render
// it alongside attentionItems, but must never merge the two lists.

/** One agent's harness scorecard, surfaced only when it has at least one red flag (a clean 5/5 is
 *  not worth a row — this is a diagnostic surface, not a status board). */
export interface HarnessScorecardFinding {
  id: string;
  agentId: string;
  agentName: string;
  score: number;
  redFlags: string[];
  at: number;
}

/**
 * Every dispatched unit whose harness scorecard carries at least one red flag, worst-first (lowest
 * score, then most recent). Agents with no scorecard (spawned before this shipped, or restored/adopted
 * without a fresh spawn) and agents scoring a clean 5/5 are omitted — nothing to say about either.
 */
export function harnessScorecardFindings(agents: AgentDTO[]): HarnessScorecardFinding[] {
  return agents
    .filter((a): a is AgentDTO & { harnessScorecard: NonNullable<AgentDTO['harnessScorecard']> } => (a.harnessScorecard?.redFlags.length ?? 0) > 0)
    .map((a) => ({
      id: `harness-scorecard:${a.id}`,
      agentId: a.id,
      agentName: a.name,
      score: a.harnessScorecard.score,
      redFlags: a.harnessScorecard.redFlags,
      at: a.harnessScorecard.at,
    }))
    .sort((a, b) => a.score - b.score || b.at - a.at || a.agentId.localeCompare(b.agentId));
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

// ───────────────────────────── active work ─────────────────────────────
//
// THE JOIN nothing else in the UI does: agent ⇄ feature/plan ⇄ live activity.
// The raw data is all present (AgentDTO carries featureId/activity/todo/issue;
// FeatureDTO carries agentIds/title/planDir/workflowStage/workflowProgress) but
// no view stitches them, so "what is being worked on right now, and by whom?"
// has no single answer. This join is the answer — consumed BOTH by the
// ActiveWork pane and (via activeWorkDigest) by the assistant's context, so the
// dashboard and the chat can never disagree about what's live.

/** Rolled-up posture for one unit of active work — drives row color and sort. */
export type ActiveWorkStatus = 'errored' | 'blocked' | 'land-ready' | 'working' | 'idle';

/** One agent attached to a unit of active work, flattened for display. */
export interface ActiveWorkAgentLine {
  id: string;
  name: string;
  status: AgentDTO['status'];
  /** the single most relevant one-liner: the error, the blocking question, or the live activity. */
  note?: string;
  /** latest todo progress for this agent. */
  todo?: { done: number; total: number; active?: string };
  landReady?: boolean;
  /** waiting on operator input (status input OR a pending request). */
  blocked?: boolean;
  /** first pending request id — the answer target when blocked. */
  requestId?: string;
  /** preset choices for the pending request, rendered as one-click answers. */
  options?: string[];
  /** placeholder for the free-text answer composer. */
  placeholder?: string;
  startedAt?: number;
  lastActivity: number;
}

/** One unit of active work — a plan/feature (with its agents) or an unassigned live agent. */
export interface ActiveWorkItem {
  /** the feature/plan this belongs to; undefined for an unassigned live agent. */
  featureId?: string;
  /** human title — the plan/feature title, or the agent name for unassigned work. */
  title: string;
  /** plans/<name>/ directory, when this is a plan. */
  planDir?: string;
  repo: string;
  /** linked Plane issue (first attached agent's), if any. */
  issue?: IssueRef;
  /** workflow stage label (workflowStage ?? humanized feature.stage). */
  stage?: string;
  /** feature-level workflow progress. */
  progress?: { done: number; total: number };
  /** attached agents, most-urgent first. */
  agents: ActiveWorkAgentLine[];
  /** rolled-up status across the attached agents / feature stage. */
  status: ActiveWorkStatus;
  /** the one sentence describing what's happening, lead-agent first. */
  headline: string;
  /** most recent activity across this item, for sort + age label. */
  lastActivity: number;
}

/** Feature stages that count as "work underway" even with no agent currently attached. */
const ACTIVE_FEATURE_STAGES: ReadonlySet<FeatureDTO['stage']> = new Set(['in-progress', 'review', 'diverged']);

/** Order agents within an item so the one that needs attention leads the headline. */
const AGENT_RANK: Record<AgentDTO['status'], number> = { error: 0, input: 1, working: 2, starting: 3, idle: 4, stopped: 5 };

/** Order items so blocking/erroring work sorts to the top of the pane. */
const STATUS_RANK: Record<ActiveWorkStatus, number> = { errored: 0, blocked: 1, 'land-ready': 2, working: 3, idle: 4 };

/** Compact human label for a status, reused by the digest and the pane. */
export const ACTIVE_WORK_STATUS_LABEL: Record<ActiveWorkStatus, string> = {
  errored: 'ERRORED',
  blocked: 'BLOCKED',
  'land-ready': 'ready to land',
  working: 'working',
  idle: 'idle',
};

function humanizeStage(stage: string): string {
  return stage.replace(/-/g, ' ');
}

function agentLine(a: AgentDTO): ActiveWorkAgentLine {
  const pending = a.pending[0];
  const blocked = a.status === 'input' || a.pending.length > 0;
  let note: string | undefined;
  if (a.status === 'error') note = a.error ?? 'errored';
  else if (blocked) note = pending?.title ?? pending?.message ?? 'waiting on operator input';
  else note = a.activity ?? a.todo?.active;
  return { id: a.id, name: a.name, status: a.status, note, todo: a.todo, landReady: a.landReady, blocked, requestId: pending?.id, options: pending?.options, placeholder: pending?.placeholder, startedAt: a.startedAt, lastActivity: a.lastActivity };
}

function rollUpStatus(lines: ActiveWorkAgentLine[]): ActiveWorkStatus {
  if (lines.some((l) => l.status === 'error')) return 'errored';
  if (lines.some((l) => l.blocked)) return 'blocked';
  if (lines.some((l) => l.landReady)) return 'land-ready';
  if (lines.some((l) => l.status === 'working' || l.status === 'starting')) return 'working';
  return 'idle';
}

function activeHeadline(status: ActiveWorkStatus, lead: ActiveWorkAgentLine | undefined, count: number, issue: IssueRef | undefined, stage: string | undefined): string {
  if (!lead) return stage ? `${stage} — no agent attached, staffable` : 'no agent attached — staffable';
  const who = count > 1 ? `${lead.name} +${count - 1}` : lead.name;
  const prog = lead.todo && lead.todo.total > 0 ? ` · ${lead.todo.done}/${lead.todo.total}` : '';
  switch (status) {
    case 'errored':
      return `${who} errored — ${lead.note ?? 'see transcript'}`;
    case 'blocked':
      return `${who} is waiting on you — ${lead.note ?? 'operator input'}`;
    case 'land-ready':
      return `${who} ready to land${issue?.name ? ` — ${issue.name}` : ''}`;
    case 'working':
      return `${who} · ${lead.note ?? 'working'}${prog}`;
    default:
      return `${who} idle between turns${prog}`;
  }
}

function featureItem(f: FeatureDTO, attached: AgentDTO[]): ActiveWorkItem {
  const lines = attached.map(agentLine).sort((a, b) => AGENT_RANK[a.status] - AGENT_RANK[b.status] || b.lastActivity - a.lastActivity);
  const status = rollUpStatus(lines);
  const issue = attached.find((a) => a.issue)?.issue;
  const stage = (f.workflowStage && f.workflowStage.trim()) || humanizeStage(f.stage);
  const lastActivity = Math.max(f.updatedAt ?? 0, ...lines.map((l) => l.lastActivity), 0);
  return {
    featureId: f.id,
    title: f.title,
    planDir: f.planDir,
    repo: f.repo,
    issue,
    stage,
    progress: f.workflowProgress,
    agents: lines,
    status,
    headline: activeHeadline(status, lines[0], lines.length, issue, stage),
    lastActivity,
  };
}

function orphanItem(a: AgentDTO): ActiveWorkItem {
  const line = agentLine(a);
  const status = rollUpStatus([line]);
  return {
    featureId: undefined,
    title: a.name,
    repo: a.repo,
    issue: a.issue,
    stage: undefined,
    agents: [line],
    status,
    headline: activeHeadline(status, line, 1, a.issue, undefined),
    lastActivity: a.lastActivity,
  };
}

/**
 * Join the live roster against the feature list into a single "what's being
 * worked on right now" view. An item is active when it has ≥1 non-terminal (or
 * errored) agent OR its feature stage is in-progress/review/diverged — the
 * latter surfaces plans that are underway but currently un-staffed (dropped
 * work), which is exactly the thing that otherwise goes invisible. Live agents
 * not tied to any feature appear as their own rows so nothing running is hidden.
 *
 * Sort: errored → blocked → land-ready → working → idle, then most-recent first.
 */
export function activeWork(agents: AgentDTO[] | null | undefined, features: FeatureDTO[] | null | undefined): ActiveWorkItem[] {
  const featureList = features ?? [];
  // Errored agents are terminal but the operator MUST see the crash, so include them.
  const agentList = (agents ?? []).filter((a) => LIVE_STATUSES.has(a.status) || a.status === 'error');
  const featById = new Map(featureList.map((f) => [f.id, f]));

  const byFeature = new Map<string, AgentDTO[]>();
  const assigned = new Set<string>();
  for (const a of agentList) {
    let fid = a.featureId && featById.has(a.featureId) ? a.featureId : undefined;
    if (!fid) {
      const owner = featureList.find((f) => f.agentIds.includes(a.id));
      if (owner) fid = owner.id;
    }
    if (fid) {
      const arr = byFeature.get(fid) ?? [];
      arr.push(a);
      byFeature.set(fid, arr);
      assigned.add(a.id);
    }
  }

  const items: ActiveWorkItem[] = [];
  for (const f of featureList) {
    if (f.stage === 'done' || f.stage === 'landed') continue;
    const attached = byFeature.get(f.id) ?? [];
    if (attached.length === 0 && !ACTIVE_FEATURE_STAGES.has(f.stage)) continue;
    items.push(featureItem(f, attached));
  }
  for (const a of agentList) {
    if (!assigned.has(a.id)) items.push(orphanItem(a));
  }

  items.sort((x, y) => STATUS_RANK[x.status] - STATUS_RANK[y.status] || y.lastActivity - x.lastActivity || x.title.localeCompare(y.title));
  return items;
}

/** The kinds of move a single active-work row offers — exactly one per row. */
export type ActiveWorkActionKind = 'answer' | 'land' | 'restart' | 'staff' | 'view';

/** The one action that moves an active-work item forward. */
export interface ActiveWorkAction {
  kind: ActiveWorkActionKind;
  /** button label. */
  label: string;
  /** the agent this action targets; absent for feature-level land and staff. */
  agentId?: string;
  /** the pending request to answer (answer only). */
  requestId?: string;
}

/**
 * Map an active-work item to the ONE action that moves it forward, so the pane
 * and the digest never re-derive "what do I do about this row?":
 *   errored → restart · blocked → answer · land-ready → land ·
 *   un-staffed plan → staff · anything else → open the console.
 *
 * Land targets the FEATURE when the item is a plan (lands every attached agent
 * through the proof gate at once) and the lone agent when it's an orphan. A
 * blocked item with no answerable pending request falls back to opening the
 * console rather than offering an answer box that targets nothing.
 */
export function activeWorkAction(item: ActiveWorkItem): ActiveWorkAction {
  const agents = item.agents;
  switch (item.status) {
    case 'errored': {
      const a = agents.find((l) => l.status === 'error') ?? agents[0];
      return { kind: 'restart', label: 'Restart', agentId: a?.id };
    }
    case 'blocked': {
      const a = agents.find((l) => l.requestId) ?? agents.find((l) => l.blocked) ?? agents[0];
      return a?.requestId
        ? { kind: 'answer', label: 'Answer', agentId: a.id, requestId: a.requestId }
        : { kind: 'view', label: 'Open console', agentId: a?.id };
    }
    case 'land-ready': {
      const a = agents.find((l) => l.landReady) ?? agents[0];
      return item.featureId ? { kind: 'land', label: 'Land' } : { kind: 'land', label: 'Land', agentId: a?.id };
    }
    case 'idle':
      if (item.featureId && agents.length === 0) return { kind: 'staff', label: 'Staff a unit' };
      return { kind: 'view', label: 'Open console', agentId: agents[0]?.id };
    default: // working
      return { kind: 'view', label: 'Open console', agentId: agents[0]?.id };
  }
}

/**
 * Compress the active-work join into a compact plain-text snapshot suitable for
 * injecting into the assistant's prompt, so the chat can answer "what's being
 * worked on?" from the same source of truth the pane renders. Capped so the
 * preamble never balloons the prompt.
 */
export function activeWorkDigest(items: ActiveWorkItem[], limit = 8): string {
  if (!items.length) return "Fleet snapshot: nothing is being worked on right now — no live agents and no in-progress plans.";
  const lines = items.slice(0, limit).map((it) => {
    const id = it.issue?.identifier ? ` [${it.issue.identifier}]` : '';
    const action = activeWorkAction(it);
    // The next move, when there is one beyond just looking at it.
    const hint = action.kind === 'view' ? '' : ` → ${action.label.toLowerCase()}`;
    return `- "${it.title}" — ${ACTIVE_WORK_STATUS_LABEL[it.status]}: ${it.headline}${id}${hint}`;
  });
  const more = items.length > limit ? `\n  …and ${items.length - limit} more (see the Active Work tab)` : '';
  return `Fleet snapshot — what's being worked on right now (${items.length} active):\n${lines.join('\n')}${more}`;
}
