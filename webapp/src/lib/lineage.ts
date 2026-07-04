/**
 * lineage.ts — the parent/child agent forest.
 *
 * A direct port of the legacy `renderRace` root/child split (src/web/index.html:1323-1325),
 * generalized to full recursive nesting (workflow branch trees can be 2+ levels deep: a
 * workflow run spawns branches, and a branch can itself be a workflow with its own branches).
 * Dangling `parentId` (the parent has been removed from the roster) promotes the node to a
 * root rather than dropping it — matching the legacy page's existing behavior, made explicit
 * here via `orphaned` so the UI can badge it instead of silently vanishing it.
 */

import type { AgentDTO } from './dto';

export interface LineageNode {
  agent: AgentDTO;
  children: LineageNode[];
  /** True when this node's declared parentId doesn't resolve to a live roster agent — it is
   *  rendered as a promoted root with an "orphaned" badge instead of silently vanishing. */
  orphaned: boolean;
}

/** Build the parent/child forest over the live roster. */
export function buildLineageTree(agents: AgentDTO[]): LineageNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string, AgentDTO[]>();
  for (const a of agents) {
    if (a.parentId && byId.has(a.parentId)) {
      const list = childrenOf.get(a.parentId) ?? [];
      list.push(a);
      childrenOf.set(a.parentId, list);
    }
  }
  const build = (agent: AgentDTO): LineageNode => ({
    agent,
    orphaned: !!agent.parentId && !byId.has(agent.parentId),
    children: (childrenOf.get(agent.id) ?? [])
      .sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0) || (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map(build),
  });
  return agents.filter((a) => !a.parentId || !byId.has(a.parentId)).map(build);
}
