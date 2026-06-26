// SPDX-License-Identifier: AGPL-3.0-or-later
// omp-graph agent overlay helpers for the force-graph (original).
import { ACCENT, type GraphNode, type ThemeColors } from "./graphConstants";
import type { AgentMarker } from "@/lib/graph-types";

/** Empty fallback when no agent overlay is provided. */
export const EMPTY_AGENTS: ReadonlyMap<string, readonly AgentMarker[]> = new Map();

/** Ring/badge colour for an agent status (overlay layer), resolved via theme. */
export function agentRingColor(status: string, t: ThemeColors): string {
  switch (status) {
    case "working":
      return ACCENT;
    case "input":
      return t.statusInProgress;
    case "error":
      return t.statusCancelled;
    case "starting":
      return t.statusPlanned;
    default:
      return t.labelDimmed;
  }
}

/** Node tooltip text, appending a one-line agent summary when present. */
export function agentTip(
  node: GraphNode,
  agents: ReadonlyMap<string, readonly AgentMarker[]>,
): string {
  const base = node.taskRef + " · " + node.title;
  const list = agents.get(node.id);
  if (!list || list.length === 0) return base;
  const counts = new Map<string, number>();
  for (const a of list) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  const summary = [...counts.entries()].map(([s, c]) => c + " " + s).join(", ");
  return base + " — " + summary;
}
