/**
 * fleetRoster.ts — pure grouping/join logic for the unified Fleet view (GRAPH-FOLD.md §6).
 *
 * WorkspaceCockpit was "one screen per agent" with a flat, recency-sorted roster. The fold
 * dissolves AttentionPanel ("needs you") and ActiveWorkPane ("active work") into that same
 * roster, so the roster itself must become state-GROUPED (NEEDS YOU · LAND READY · WORKING ·
 * IDLE/DONE), each agent joined to the plan it's working (for a line-2 plan chip + progress),
 * plus a trailing UNSTAFFED PLANS group for plan work with no agent attached at all.
 *
 * This is pure synthesis over the SAME two source-of-truth functions the deleted panels used —
 * `attentionItems` (insights.ts) for urgency/ranking and `activeWork` (insights.ts) for the
 * plan⇄agent join — so the Fleet view can never disagree with either panel's old verdict; it
 * just recomposes them into one roster. No React, no fetch: unit-tested DOM-free like every
 * other panel's logic in this codebase.
 */

import type { AgentDTO } from './dto';
import type { AttentionItem, ActiveWorkItem } from './insights';

export type FleetGroupKey = 'needs' | 'land' | 'working' | 'idle';

/** One roster row backed by a live agent. */
export interface FleetAgentRow {
  kind: 'agent';
  agent: AgentDTO;
  group: FleetGroupKey;
  /** The attention item that put this agent in NEEDS YOU / LAND READY, when any — carries the
   *  row's line-2 detail text, the answer options (tier-1 inline), and the one-move action. */
  attn?: AttentionItem;
  /** The plan/feature this agent is attached to (activeWork's join) — line-2 plan chip + progress. */
  planItem?: ActiveWorkItem;
}

/** One trailing "un-staffed plan" row — a plan/feature with no agent attached at all. */
export interface FleetUnstaffedRow {
  kind: 'unstaffed';
  group: 'unstaffed';
  item: ActiveWorkItem;
}

export type FleetRosterRow = FleetAgentRow | FleetUnstaffedRow;

export interface FleetRoster {
  /** NEEDS YOU — input-blocked, errored, flapping, vetoed, stalled, reports/attention events;
   *  ranked by attentionItems' own severity→recency order. Never collapses (§6d/g). */
  needs: FleetAgentRow[];
  /** LAND READY — landReady && not vetoed. */
  land: FleetAgentRow[];
  /** WORKING — live, nothing blocking, nothing to land. */
  working: FleetAgentRow[];
  /** IDLE/DONE — idle or terminal, collapsed by default (§6a/d). */
  idle: FleetAgentRow[];
  /** UNSTAFFED PLANS — trailing group, plan work underway with zero agents attached. */
  unstaffed: FleetUnstaffedRow[];
  /** Attention items with no single owning agent (collision spans ≥2 agents; resource/raise-cap
   *  has none) — rendered as their own NEEDS YOU rows, not folded onto one agent's row. */
  virtualNeeds: AttentionItem[];
}

/** Kinds whose attentionItems row is about ONE agent's own state (blocked/errored/etc.) — these
 *  drive an agent's group membership. `collision` and `resource` are cross-cutting/agent-less and
 *  become their own virtual NEEDS YOU rows instead (see `virtualNeeds`); `land-ready` gets its own
 *  group rather than folding into NEEDS YOU. */
const VIRTUAL_KINDS: ReadonlySet<AttentionItem['kind']> = new Set(['collision', 'resource']);

/**
 * Compose the state-grouped Fleet roster from the live agent list plus the two existing
 * syntheses. `attn` and `workItems` are passed in (not recomputed here) so the caller controls
 * polling/memoization — this function is a pure join.
 */
export function buildFleetRoster(agents: AgentDTO[], attn: AttentionItem[], workItems: ActiveWorkItem[]): FleetRoster {
  const virtualNeeds = attn.filter((i) => VIRTUAL_KINDS.has(i.kind));
  const perAgentNeeds = attn.filter((i) => !VIRTUAL_KINDS.has(i.kind) && i.kind !== 'land-ready');
  const landItems = attn.filter((i) => i.kind === 'land-ready');

  // Rank + first-match lookup for each bucket — attn is already severity→recency sorted, so the
  // first occurrence per agent is that agent's most-urgent row, and array index doubles as rank.
  const needsRank = new Map<string, number>();
  const needsAttnByAgent = new Map<string, AttentionItem>();
  perAgentNeeds.forEach((item, idx) => {
    if (!item.agentId) return;
    if (!needsAttnByAgent.has(item.agentId)) { needsAttnByAgent.set(item.agentId, item); needsRank.set(item.agentId, idx); }
  });

  const landRank = new Map<string, number>();
  const landAttnByAgent = new Map<string, AttentionItem>();
  landItems.forEach((item, idx) => {
    if (!item.agentId) return;
    if (!landAttnByAgent.has(item.agentId)) { landAttnByAgent.set(item.agentId, item); landRank.set(item.agentId, idx); }
  });

  // activeWork's plan join, flattened to agentId -> the feature-level item (line-2 plan chip).
  // Requires a real `planDir`, not just a `featureId`: the backend auto-wraps every un-featured
  // ("orphan") agent in its own single-agent pseudo-feature (`id: "agent:<id>"`, title = the
  // agent's own name, no planDir) purely so it has a uniform FeatureDTO shape elsewhere — live-
  // driving this view showed that join producing a redundant "plan chip" naming the agent under
  // itself for EVERY orphan row. A real plan/feature always carries a `planDir`; the auto-wrapper
  // never does, so that's the honest signal to distinguish "this agent is on named work" from
  // "this agent's own pseudo-feature wrapper leaked through the join".
  const planByAgent = new Map<string, ActiveWorkItem>();
  for (const item of workItems) {
    if (!item.featureId || !item.planDir) continue;
    for (const line of item.agents) planByAgent.set(line.id, item);
  }

  const needs: FleetAgentRow[] = [];
  const land: FleetAgentRow[] = [];
  const working: FleetAgentRow[] = [];
  const idle: FleetAgentRow[] = [];

  for (const agent of agents) {
    const planItem = planByAgent.get(agent.id);
    if (needsAttnByAgent.has(agent.id)) {
      needs.push({ kind: 'agent', agent, group: 'needs', attn: needsAttnByAgent.get(agent.id), planItem });
    } else if (landAttnByAgent.has(agent.id)) {
      land.push({ kind: 'agent', agent, group: 'land', attn: landAttnByAgent.get(agent.id), planItem });
    } else if (agent.status === 'working' || agent.status === 'starting') {
      working.push({ kind: 'agent', agent, group: 'working', planItem });
    } else {
      idle.push({ kind: 'agent', agent, group: 'idle', planItem });
    }
  }

  needs.sort((a, b) => (needsRank.get(a.agent.id) ?? Infinity) - (needsRank.get(b.agent.id) ?? Infinity));
  land.sort((a, b) => (landRank.get(a.agent.id) ?? Infinity) - (landRank.get(b.agent.id) ?? Infinity));
  working.sort((a, b) => b.agent.lastActivity - a.agent.lastActivity);
  idle.sort((a, b) => b.agent.lastActivity - a.agent.lastActivity);

  const unstaffed: FleetUnstaffedRow[] = workItems
    .filter((item) => !!item.featureId && item.agents.length === 0)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((item) => ({ kind: 'unstaffed' as const, group: 'unstaffed' as const, item }));

  return { needs, land, working, idle, unstaffed, virtualNeeds };
}

/** The row to auto-select when the roster changes — the top NEEDS-YOU agent (§6d: "default-select
 *  the top NEEDS-YOU row"), else the first row down the group order. Unstaffed plan rows have no
 *  agent to open a transcript for, so they're never auto-selected. */
export function defaultSelection(roster: FleetRoster): string | null {
  return roster.needs[0]?.agent.id ?? roster.land[0]?.agent.id ?? roster.working[0]?.agent.id ?? roster.idle[0]?.agent.id ?? null;
}

/** Total row count across every group (agents + unstaffed plans) — drives the "roster is
 *  completely empty" state vs. "nothing needs you but the fleet has rows" state. */
export function totalRosterCount(roster: FleetRoster): number {
  return roster.needs.length + roster.land.length + roster.working.length + roster.idle.length + roster.unstaffed.length;
}

/** The calm one-line summary shown in place of an empty NEEDS YOU group (§6d): "Nothing needs
 *  you · fleet idle · room for N" (or "at cap" when there's no headroom). */
export function calmLine(workingCount: number, roomFor: number): string {
  const fleet = workingCount > 0 ? `${workingCount} working` : 'fleet idle';
  const room = roomFor > 0 ? `room for ${roomFor}` : 'at cap';
  return `Nothing needs you · ${fleet} · ${room}`;
}
