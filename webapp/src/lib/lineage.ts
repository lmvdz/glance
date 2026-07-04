/**
 * lineage.ts — the parent/child agent forest.
 *
 * A direct port of the legacy `renderRace` root/child split (src/web/index.html:1323-1325),
 * generalized to full recursive nesting (workflow branch trees can be 2+ levels deep: a
 * workflow run spawns branches, and a branch can itself be a workflow with its own branches).
 * Dangling `parentId` (the parent has been removed from the roster) promotes the node to a
 * root rather than dropping it — matching the legacy page's existing behavior, made explicit
 * here via `orphaned` so the UI can badge it instead of silently vanishing it.
 *
 * A node inside a `parentId` cycle (a self-parent, or a 2+-node loop — never expected from a real
 * lineage, but a corrupt/racy persisted record must not vanish the topology view) resolves to
 * neither a root (its parentId DOES resolve to a live roster agent) nor a reachable child (every
 * node in the cycle is only ever reached FROM another node in the same cycle, so recursion from a
 * genuine root never visits it). `buildLineageTree` tracks visited ids during traversal and
 * promotes any node left unvisited once the real forest is built to an orphaned root, same badge
 * as a dangling parentId.
 */

import type { AgentDTO } from './dto';

export interface LineageNode {
  agent: AgentDTO;
  children: LineageNode[];
  /** True when this node's declared parentId doesn't resolve to a live roster agent, OR the node
   *  sits in a parentId cycle (including self-parent) and was promoted here as leftover — it is
   *  rendered as a promoted root with an "orphaned" badge instead of silently vanishing. */
  orphaned: boolean;
}

/** Build the parent/child forest over the live roster. */
export function buildLineageTree(agents: AgentDTO[]): LineageNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string, AgentDTO[]>();
  for (const a of agents) {
    // A self-parent can never be a real child edge (it would make the node its own ancestor) —
    // guard it explicitly rather than relying on cycle detection to catch it, so the intent reads
    // directly at the point childrenOf is built.
    if (a.parentId && a.parentId !== a.id && byId.has(a.parentId)) {
      const list = childrenOf.get(a.parentId) ?? [];
      list.push(a);
      childrenOf.set(a.parentId, list);
    }
  }
  const visited = new Set<string>();
  // `orphaned` is always passed explicitly by the caller (true for a promoted root — dangling
  // parent, self-parent, or a cycle leftover; false for a genuinely reachable child). Children are
  // filtered against `visited` (populated depth-first, parent before child) so a back-edge into an
  // already-visited ancestor — the shape every 2+-node cycle produces once one member is promoted
  // to root — is silently dropped instead of recursing forever.
  const build = (agent: AgentDTO, orphaned: boolean): LineageNode => {
    visited.add(agent.id);
    const kids = (childrenOf.get(agent.id) ?? [])
      .filter((c) => !visited.has(c.id))
      .sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return { agent, orphaned, children: kids.map((child) => build(child, false)) };
  };
  const roots = agents
    .filter((a) => !a.parentId || a.parentId === a.id || !byId.has(a.parentId))
    .map((a) => build(a, !!a.parentId));
  // Cycle leftovers: every node in a 2+-node parentId cycle has a parentId that DOES resolve to a
  // live agent (so it's excluded from `roots` above) but is never reached by recursion from a real
  // root (every node in the cycle is only ever reached from another node in the same cycle) — walk
  // once more and promote whatever `build` never visited, badged the same as a dangling parent.
  for (const a of agents) {
    if (!visited.has(a.id)) roots.push(build(a, true));
  }
  return roots;
}
