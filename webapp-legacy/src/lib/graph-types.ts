// Engine contract types — decoupled from omp-squad's src/types.ts so the lifted
// piyaz force-graph compiles without Next/Drizzle deps. Field names match piyaz's
// TaskGraphSlim/TaskGraphEdge so the engine needs only import-path swaps.

export type EdgeType = "depends_on" | "relates_to";

/** A node fed to the force engine. */
export interface TaskGraphSlim {
  id: string;
  title: string;
  taskRef: string;
  status: string;
  tags: string[];
  /** Derived sub-stage override (e.g. "plannable"/"ready") for hollow rendering. */
  state?: string;
}

/** An edge fed to the force engine. */
export interface TaskGraphEdge {
  sourceTaskId: string;
  targetTaskId: string;
  edgeType: EdgeType;
}

/** Minimal agent shape the renderer needs for the overlay layer. */
export interface AgentMarker {
  status: string;
}
