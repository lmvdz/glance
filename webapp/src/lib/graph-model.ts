import type { AgentDTO, FeatureDTO } from "./dto";
import type { EdgeType, TaskGraphEdge, TaskGraphSlim } from "./graph-types";

/** The engine-ready projection of the fleet. */
export interface GraphModel {
  nodes: TaskGraphSlim[];
  edges: TaskGraphEdge[];
  /** featureId -> agents currently on that feature (overlay layer). */
  agentsByFeature: Map<string, AgentDTO[]>;
  /** Agents with no resolvable feature — surfaced as a top-bar count, not nodes. */
  unassigned: AgentDTO[];
  /** Sub-stage overrides for hollow rendering (pre-execution stages). */
  stageMap: Map<string, string>;
}

/** Compact, stable label from a feature id ("plan:<repo>:<dir>" / "agent:<id>"). */
function shortId(id: string): string {
  const parts = id.split(":");
  const tail = parts[parts.length - 1] ?? id;
  return tail.length > 10 ? tail.slice(0, 10) : tail;
}

function basename(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Project the live fleet into the force-graph's input shape: `FeatureDTO`
 * nodes, dependency/relation edges, and an agent overlay bucketed by feature.
 * Pure — call it whenever `features`/`agents` change.
 *
 * ponytail: `depends_on` edges come only from `IssueRef.blockedBy` carried by
 * live agents (the only place issue relations reach the wire). Ceiling: misses
 * deps among dormant issues. Upgrade path: fetch the Plane issue graph and index
 * every blocked_by relation for the active project.
 */
export function buildGraphModel(features: FeatureDTO[], agents: AgentDTO[]): GraphModel {
  const featureIds = new Set(features.map((f) => f.id));

  const nodes: TaskGraphSlim[] = features.map((f) => ({
    id: f.id,
    title: f.title,
    taskRef: f.issueIdentifiers?.[0] ?? shortId(f.id),
    status: f.stage,
    tags: [basename(f.repo), ...(f.planDir ? [basename(f.planDir)] : [])],
  }));

  // identifier index from features (issueIdentifiers carries Plane identifiers)
  const byIdentifier = new Map<string, string>();
  for (const f of features) for (const id of f.issueIdentifiers ?? []) byIdentifier.set(id, f.id);
  // id/identifier index from live agents' issues (blockedBy uses issue ids)
  const byIssueRef = new Map<string, string>();
  for (const a of agents) {
    if (!a.featureId || !featureIds.has(a.featureId) || !a.issue) continue;
    if (a.issue.id) byIssueRef.set(a.issue.id, a.featureId);
    if (a.issue.identifier) byIssueRef.set(a.issue.identifier, a.featureId);
  }
  const resolveFeature = (issueKey: string): string | undefined =>
    byIssueRef.get(issueKey) ?? byIdentifier.get(issueKey);

  const edges: TaskGraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (src: string, tgt: string, type: EdgeType) => {
    if (src === tgt || !featureIds.has(src) || !featureIds.has(tgt)) return;
    const key = `${type}:${src}->${tgt}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ sourceTaskId: src, targetTaskId: tgt, edgeType: type });
  };

  // depends_on: blocked feature -> blocker feature, from agents' issue.blockedBy
  for (const a of agents) {
    const iss = a.issue;
    if (!iss?.blockedBy?.length) continue;
    const blocked =
      a.featureId && featureIds.has(a.featureId)
        ? a.featureId
        : iss.identifier
          ? resolveFeature(iss.identifier)
          : undefined;
    if (!blocked) continue;
    for (const blockerKey of iss.blockedBy) {
      const blocker = resolveFeature(blockerKey);
      if (blocker) addEdge(blocked, blocker, "depends_on");
    }
  }

  // relates_to: features sharing a planDir (or repo) -> star to the group's first member
  const groups = new Map<string, string[]>();
  for (const f of features) {
    const key = f.planDir ? `${f.repo}::${f.planDir}` : `repo::${f.repo}`;
    const arr = groups.get(key) ?? [];
    arr.push(f.id);
    groups.set(key, arr);
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const hub = ids[0];
    for (let i = 1; i < ids.length; i++) addEdge(ids[i], hub, "relates_to");
  }

  // agent overlay buckets
  const agentsByFeature = new Map<string, AgentDTO[]>();
  const unassigned: AgentDTO[] = [];
  for (const a of agents) {
    if (a.featureId && featureIds.has(a.featureId)) {
      const arr = agentsByFeature.get(a.featureId) ?? [];
      arr.push(a);
      agentsByFeature.set(a.featureId, arr);
    } else {
      unassigned.push(a);
    }
  }

  // hollow sub-stage: pre-execution stages render hollow like piyaz "plannable"
  const stageMap = new Map<string, string>();
  for (const f of features) {
    if (f.stage === "planned" || f.stage === "issues-created") stageMap.set(f.id, "plannable");
  }

  return { nodes, edges, agentsByFeature, unassigned, stageMap };
}
