export interface Project {
  id: string;
  name: string;
  shortCode: string;
  colorClass: string;
}

export interface TaskDecision {
  id: string;
  text: string;
  source?: "plan" | "human" | "agent";
  createdAt?: number;
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
  id: string;
  sourceId?: string;
  /** plans/<name>/ directory when this task is a plan — the readable handle the list shows. */
  planDir?: string;
  title: string;
  category: 'frontend' | 'devops' | 'backend' | 'mcp' | 'database';
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
