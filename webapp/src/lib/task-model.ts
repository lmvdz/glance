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

function projectForRepo(repo: string, index = 0, pathMissing = false): Project {
  const name = repoName(repo);
  return { id: repo, name, shortCode: shortCode(name), colorClass: PROJECT_COLORS[index % PROJECT_COLORS.length], ...(pathMissing ? { pathMissing: true } : {}) };
}

export function projectsByTeam(projects: ProjectDTO[], features: FeatureDTO[] = []): Record<string, Project[]> {
  if (projects.length) {
    // `exists === false` (daemon statted the path, it's gone) → pathMissing; absent (older daemon)
    // reads as healthy.
    return { "OMP SQUAD": projects.map((project, index) => projectForRepo(project.repo, index, project.exists === false)) };
  }
  const repos = [...new Set(features.map((feature) => feature.repo))];
  return { "OMP SQUAD": repos.map((repo, index) => projectForRepo(repo, index)) };
}

function taskStatus(feature: FeatureDTO, agents: AgentDTO[]): Task["status"] {
  if (feature.stage === "done" || feature.stage === "landed") return "done";
  if (feature.divergent || feature.stage === "diverged" || agents.some((agent) => agent.status === "working" || agent.status === "input" || agent.status === "starting")) return "active";
  return "todo";
}

/**
 * Derivation order: operator override wins outright; otherwise a regex over title+planDir;
 * otherwise the honest 'other' fallback. 'other' replaces a prior silent 'mcp' default — the
 * regex never actually produces 'mcp' (nothing routes there), so 'mcp' stays a real bucket a
 * human can still pick via the override, but nothing falls into it by accident anymore.
 */
function taskCategory(feature: FeatureDTO): Task["category"] {
  if (feature.category) return feature.category;
  const text = `${feature.title} ${feature.planDir ?? ""}`.toLowerCase();
  if (/ui|web|frontend|react|css|dashboard/.test(text)) return "frontend";
  if (/db|sql|data|store|schema|migration/.test(text)) return "database";
  if (/ci|deploy|git|land|worktree|ops|infra/.test(text)) return "devops";
  if (/api|server|auth|backend|route/.test(text)) return "backend";
  return "other";
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
    categoryOverride: feature.category,
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
  const identifier = issueIdentifier(task);
  if (identifier) return identifier;
  if (task.planDir) return task.planDir.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  return null;
}

/**
 * The genuine Plane issue identifier for a task, distinct from `taskRef`'s broader fallback (which
 * also accepts a plan-dir slug as a handle). Used for the task-detail header's issue-id chip — that
 * chip should only ever show a real tracker id, never a plan-dir name dressed up as one.
 */
export function issueIdentifier(task: Pick<Task, "id" | "displayId">): string | null {
  if (task.displayId && PLANE_ID_RE.test(task.displayId)) return task.displayId;
  if (PLANE_ID_RE.test(task.id)) return task.id;
  return null;
}

/**
 * Repo paths reach the client from three places (the project registry, an agent's `repo`, a feature's
 * `repo`) and only collapse if they are spelled identically. The server keys `ProjectDTO.id` on a
 * normalized path; a feature carrying `"/srv/app/"` would miss the lookup, get a project whose id is the
 * raw string, and then never match `currentProject.id` — so its task would silently vanish from the
 * scoped list. Mirrors the server's `normalizeRepoPath`. Found by cross-lineage review (grok-4.5).
 */
export function normalizeRepoKey(repo: string): string {
  const trimmed = repo.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : repo.trim();
}

export function tasksFromSquad(features: FeatureDTO[], agents: AgentDTO[], projects: ProjectDTO[]): Task[] {
  const projectMap = new Map(projects.map((project, index) => [normalizeRepoKey(project.repo), projectForRepo(normalizeRepoKey(project.repo), index)]));
  return features.map((feature, index) => taskFromFeature(feature, agents, projectMap.get(normalizeRepoKey(feature.repo)) ?? projectForRepo(normalizeRepoKey(feature.repo), index)));
}

/**
 * The project the workspace is pointed at. The operator's EXPLICIT choice wins; a stale id (project
 * un-registered, or its repo drained of agents and features) falls back to the first project — which
 * `projects()` sorts busiest-first — rather than stranding the workspace on nothing.
 *
 * `currentProject` used to be `selectedTask?.properties.project ?? projects[0]`: derived, never
 * settable. Nothing in the UI could switch projects, and the sidebar rows only toggled a disclosure.
 * Pure + exported so the fallback rule is unit-tested.
 */
export function resolveCurrentProject(projects: Project[], selectedId: string | null): Project | null {
  const selected = projects.find((project) => project.id === selectedId);
  // A selection whose repo path is GONE is never honored — not even a persisted one (live finding
  // 2026-07-15: localStorage kept default-loading a deleted `~/sui/omp-graph`, and everything
  // downstream — console agents, voice dispatches — died against it). There is nothing to inspect
  // in a project with no directory, so falling to the first healthy project loses nothing.
  if (selected && !selected.pathMissing) return selected;
  return projects.find((project) => !project.pathMissing) ?? selected ?? projects[0] ?? null;
}

/**
 * Tasks belonging to the current project — what "switching projects" means. With no project at all
 * (a fresh daemon, nothing registered) every task passes, so an empty workspace shows its work rather
 * than hiding it.
 *
 * The FLEET is deliberately not scoped this way: a blocked or errored agent in another repo must never
 * be hidden by a project filter (the Needs-you-is-pinned invariant, one level up). Pure + exported.
 */
export function tasksForProject(tasks: Task[], project: Project | null): Task[] {
  if (!project) return tasks;
  return tasks.filter((task) => task.properties.project.id === project.id);
}
