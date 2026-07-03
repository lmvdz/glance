import type { AgentDTO, FeatureDTO, FeatureStage, ProjectDTO } from "./dto";
import type { Project, Task } from "../types";

const PROJECT_COLORS = ["bg-emerald-500", "bg-blue-500", "bg-purple-500", "bg-amber-500", "bg-gray-400"];

function repoName(repo: string): string {
  return repo.split(/[\\/]/).filter(Boolean).at(-1) || repo || "glance";
}

function shortCode(name: string): string {
  const initials = name.split(/[^a-z0-9]+/i).filter(Boolean).map((part) => part[0]).join("");
  return (initials || name.slice(0, 4)).slice(0, 4).toUpperCase();
}

function projectForRepo(repo: string, index = 0): Project {
  const name = repoName(repo);
  return { id: repo, name, shortCode: shortCode(name), colorClass: PROJECT_COLORS[index % PROJECT_COLORS.length] };
}

export function projectsByTeam(projects: ProjectDTO[], features: FeatureDTO[] = []): Record<string, Project[]> {
  const repos = projects.length ? projects.map((project) => project.repo) : [...new Set(features.map((feature) => feature.repo))];
  return { "OMP SQUAD": repos.map((repo, index) => projectForRepo(repo, index)) };
}

function taskStatus(feature: FeatureDTO, agents: AgentDTO[]): Task["status"] {
  if (feature.stage === "done" || feature.stage === "landed") return "done";
  if (feature.divergent || feature.stage === "diverged" || agents.some((agent) => agent.status === "working" || agent.status === "input" || agent.status === "starting")) return "active";
  return "todo";
}

function taskCategory(feature: FeatureDTO): Task["category"] {
  const text = `${feature.title} ${feature.planDir ?? ""}`.toLowerCase();
  if (/ui|web|frontend|react|css|dashboard/.test(text)) return "frontend";
  if (/db|sql|data|store|schema|migration/.test(text)) return "database";
  if (/ci|deploy|git|land|worktree|ops|infra/.test(text)) return "devops";
  if (/api|server|auth|backend|route/.test(text)) return "backend";
  return "mcp";
}

function priority(feature: FeatureDTO): Task["priority"] {
  if (feature.blocked || feature.divergent || feature.stage === "diverged") return "High";
  if (feature.stage === "in-progress" || feature.stage === "review") return "Medium";
  return "Low";
}

function duration(feature: FeatureDTO): string {
  if (feature.workflowProgress) return `${feature.workflowProgress.done}/${feature.workflowProgress.total}`;
  if (feature.agentIds.length) return `${feature.agentIds.length}a`;
  return feature.issueIdentifiers?.length ? `${feature.issueIdentifiers.length}i` : "plan";
}

function stageLabel(stage: FeatureStage): string {
  return stage.replace(/-/g, " ").toUpperCase();
}

function sourceForFeature(feature: FeatureDTO) {
  if (feature.planDir) return { type: "plan" as const, label: feature.planDir, path: feature.planDir, issueIdentifiers: feature.issueIdentifiers };
  if (feature.issueIdentifiers?.length) return { type: "issue" as const, label: feature.issueIdentifiers.join(", "), issueIdentifiers: feature.issueIdentifiers };
  if (feature.agentIds.length) return { type: "agent" as const, label: feature.agentIds.join(", ") };
  return { type: feature.persisted ? "persisted" as const : "manual" as const, label: feature.persisted ? "persisted feature" : "manual feature" };
}

function fallbackDescription(feature: FeatureDTO, agents: AgentDTO[]): string {
  const lines = [`Repo: ${feature.repo}`];
  if (feature.planDir) lines.push(`Plan: ${feature.planDir}`);
  if (feature.issueIdentifiers?.length) lines.push(`Issues: ${feature.issueIdentifiers.join(", ")}`);
  if (agents.length) lines.push(`Agents: ${agents.map((agent) => `${agent.name} (${agent.status})`).join(", ")}`);
  if (feature.workflowStage) lines.push(`Workflow: ${feature.workflowStage}`);
  if (feature.blocked) lines.push("Blocked: yes");
  if (feature.divergent) lines.push("Diverged: yes");
  return lines.join("\n");
}

export function taskFromFeature(feature: FeatureDTO, agents: AgentDTO[], project: Project): Task {
  const activeAgents = agents.filter((agent) => feature.agentIds.includes(agent.id) || agent.featureId === feature.id);
  const done = feature.workflowProgress?.done ?? 0;
  const total = feature.workflowProgress?.total ?? 0;
  return {
    // STABLE identity: always the feature id. The Plane identifier used to be preferred here,
    // but it loads async — the id flipped between renders and reconcileSelectedTaskId cleared
    // every click-selection (the "clicking a task does nothing" bug). Tracker id is display-only.
    id: feature.id,
    displayId: feature.issueIdentifiers?.[0],
    sourceId: feature.id,
    planDir: feature.planDir,
    title: feature.title,
    category: taskCategory(feature),
    duration: duration(feature),
    status: taskStatus(feature, activeAgents),
    priority: priority(feature),
    description: feature.description ?? fallbackDescription(feature, activeAgents),
    acceptanceCriteria: feature.acceptanceCriteria ?? (total ? [{ id: `${feature.id}-workflow`, text: `Workflow progress ${done} / ${total}`, completed: done >= total, source: "workflow" }] : []),
    contextBundle: feature.contextBundle ?? {
      spec: feature.planDir ?? "live feature",
      criteria: total ? `${done} / ${total} workflow steps` : `${feature.issueIdentifiers?.length ?? 0} linked issues`,
      prerequisites: feature.blocked ? "blocked" : "no known blockers",
      decisions: feature.workflowStage ?? stageLabel(feature.stage).toLowerCase(),
      downstream: activeAgents.length ? `${activeAgents.length} active agents` : "no active agents",
    },
    decisions: feature.decisions ?? [],
    relationships: feature.relationships ?? (feature.issueIdentifiers ?? []).slice(1).map((identifier) => ({ id: identifier, targetId: identifier, targetTitle: identifier, type: "issue" })),
    properties: {
      status: stageLabel(feature.stage),
      priority: priority(feature) ?? null,
      assignee: activeAgents.map((agent) => agent.name).join(", ") || null,
      project,
      estimate: duration(feature),
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt,
    },
    tags: [feature.stage, repoName(feature.repo), ...(feature.blocked ? ["blocked"] : []), ...(feature.divergent ? ["diverged"] : []), ...(feature.readiness?.blockers ?? []), ...activeAgents.map((agent) => agent.status)],
    proofProvenance: { source: sourceForFeature(feature), worktrees: feature.worktrees ?? [], proof: feature.proof, readiness: feature.readiness, candidates: feature.planRevisionCandidates ?? [] },
  };
}

/** A real tracker identifier, e.g. "OMPSQ-306" — worth showing as a handle. */
const PLANE_ID_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * The readable secondary handle for a task row. Prefer a real Plane ticket id
 * (now carried as displayId — task.id is the stable feature id); otherwise the
 * plan's directory slug (the thing the operator actually recognizes); otherwise
 * null — a synthetic feature UUID like "plan:repo:plans/x" or a bare hash is
 * noise, not a handle, so the row simply leads with its human title instead.
 */
export function taskRef(task: Pick<Task, "id" | "displayId" | "planDir">): string | null {
  if (task.displayId && PLANE_ID_RE.test(task.displayId)) return task.displayId;
  if (PLANE_ID_RE.test(task.id)) return task.id;
  if (task.planDir) return task.planDir.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  return null;
}

export function tasksFromSquad(features: FeatureDTO[], agents: AgentDTO[], projects: ProjectDTO[]): Task[] {
  const projectMap = new Map(projects.map((project, index) => [project.repo, projectForRepo(project.repo, index)]));
  return features.map((feature, index) => taskFromFeature(feature, agents, projectMap.get(feature.repo) ?? projectForRepo(feature.repo, index)));
}
