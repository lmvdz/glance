export interface Project {
  id: string;
  name: string;
  shortCode: string;
  colorClass: string;
}

export interface TaskDecision {
  id: string;
  text: string;
  source?: "plan" | "human" | "agent" | "model-delta";
  createdAt?: number;
  /** Evidence anchors for a `source:"model-delta"` decision (repo-relative `file` or `file:start-end`). */
  evidence?: string[];
}

export interface TaskRelationship {
  id: string;
  targetId: string;
  targetTitle: string;
  type?: "issue" | "blocks" | "depends-on" | "related";
  url?: string;
}

export interface TaskPlanAnnotation {
  planPath: string;
  lineStart?: number;
  lineEnd?: number;
  quote?: string;
}


export interface TaskComment {
  id: string;
  text: string;
  timestamp: string;
  author?: string;
  urgent?: boolean;
  resolvedAt?: number;
  kind?: "comment" | "plan-annotation";
  subject?: string;
  annotation?: TaskPlanAnnotation;
}


export interface TaskProofProvenance {
  source: { type: "plan" | "persisted" | "issue" | "agent" | "manual"; label: string; path?: string; issueIdentifiers?: string[] };
  worktrees: import("./lib/dto").FeatureWorktreeStatusDTO[];
  proof?: import("./lib/dto").FeatureProofAggregateDTO;
  readiness?: import("./lib/dto").FeatureReadinessDTO;
  candidates: import("./lib/dto").PlanRevisionCandidateDTO[];
}

export interface Task {
  /** STABLE identity — always the feature id (selection depends on it never changing across renders). */
  id: string;
  /** Human tracker handle (e.g. "OMPSQ-306") when a Plane ticket is linked — display only, loads async. */
  displayId?: string;
  sourceId?: string;
  /** plans/<name>/ directory when this task is a plan — the readable handle the list shows. */
  planDir?: string;
  title: string;
  /** Effective category — `categoryOverride` if set, else a regex-derived bucket over
   *  title+planDir, else the honest 'other' fallback (never a silent default). */
  category: 'frontend' | 'devops' | 'backend' | 'mcp' | 'database' | 'other';
  /** The raw operator override behind `category` (mirrors `FeatureDTO.category`), if one is set.
   *  `undefined` means "no override — category is derived"; the editable chip uses this to show
   *  whether Auto or a manual pin is in effect. */
  categoryOverride?: Task['category'];
  duration: string;
  status: 'todo' | 'active' | 'done';
  dueDate?: string;
  priority?: 'Low' | 'Medium' | 'High';
  description: string;
  acceptanceCriteria: { id: string; text: string; completed: boolean; source?: "plan" | "ticket" | "workflow" | "manual" }[];
  contextBundle: { spec: string; criteria: string; prerequisites: string; decisions: string; downstream: string };
  decisions: TaskDecision[];
  relationships: TaskRelationship[];
  properties: {
    status: string;
    priority: string | null;
    assignee: string | null;
    project: Project;
    estimate: string | null;
    createdAt?: number;
    updatedAt?: number;
  };
  tags: string[];
  comments?: TaskComment[];
  proofProvenance?: TaskProofProvenance;
}
