import type { AgentDTO, FeatureDTO, IssueRef } from "./dto";

/** A project = a repo, with rollups for the drill-down sidebar. */
export interface Project {
  repo: string;
  name: string;
  featureCount: number;
  agentCount: number;
  /** Agents in this repo waiting on a human (status input|error) — drives the attention dot. */
  waiting: number;
}

function basename(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Group features + agents by repo into Projects, sorted attention-first then by name. Pure —
 * unit-tested in projects.test.ts. The source of the sidebar's project list.
 */
export function groupProjects(features: FeatureDTO[], agents: AgentDTO[]): Project[] {
  const byRepo = new Map<string, Project>();
  const get = (repo: string): Project => {
    let p = byRepo.get(repo);
    if (!p) {
      p = { repo, name: basename(repo), featureCount: 0, agentCount: 0, waiting: 0 };
      byRepo.set(repo, p);
    }
    return p;
  };
  for (const f of features) get(f.repo).featureCount++;
  for (const a of agents) {
    const p = get(a.repo);
    p.agentCount++;
    if (a.status === "input" || a.status === "error") p.waiting++;
  }
  return [...byRepo.values()].sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name));
}

export interface FeatureTasks {
  feature: FeatureDTO;
  tasks: IssueRef[];
}

/**
 * Bucket a project's open issues under the feature (plan dir) that references them via
 * `issueIdentifiers`; issues no feature claims fall into `unplanned`. Pure — unit-tested.
 */
export function groupTasks(features: FeatureDTO[], issues: IssueRef[]): { byFeature: FeatureTasks[]; unplanned: IssueRef[] } {
  const claimed = new Set<string>();
  const byFeature = features.map((feature) => {
    const ids = new Set((feature.issueIdentifiers ?? []).map((s) => s.toUpperCase()));
    const tasks = ids.size ? issues.filter((i) => i.identifier && ids.has(i.identifier.toUpperCase())) : [];
    for (const t of tasks) claimed.add(t.id);
    return { feature, tasks };
  });
  const unplanned = issues.filter((i) => !claimed.has(i.id));
  return { byFeature, unplanned };
}
