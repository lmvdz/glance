import type { AgentDTO } from './dto';

/**
 * Reference A ("riptide") shows a task as a pipeline of typed sessions — Research / Design /
 * Structure / Plan / Implementation rows. There is NO server-truth enum for this today: confirmed
 * by direct read of src/types.ts, src/workflow/types.ts and dto.ts — `AgentKind` is a runtime
 * backend discriminator ("omp-operator"|"flue-service"|"workflow"), NodeKind is DOT shape-semantics
 * (start/exit/agent/prompt/command/human/conditional/parallel/merge/wait), and there is no
 * `routing.mode` or `spawnKind` field anywhere in the codebase. "Research"/"Plan"/"Implement" exist
 * only as free-text workflow-node LABELS in the bundled .fabro graphs (e.g.
 * workflows/research-plan-implement/workflow.fabro), which the executor copies onto the spawned
 * agent's `name`.
 *
 * So this is a best-effort, HONEST classifier: match the live workflow node's label (if the run has
 * progressed and journaled a graph), else the agent's own name, against the phase words the shipped
 * workflows actually use. Anything that doesn't match falls back to "Session" — never guessed into
 * a specific phase. This fallback is not a placeholder to remove later; it's the correct behavior
 * for the (common) case of a plain non-workflow agent or a workflow whose author used novel labels.
 */
export type SessionType = 'Research' | 'Design' | 'Structure' | 'Plan' | 'Implementation' | 'Verify' | 'Session';

const TYPE_PATTERNS: ReadonlyArray<readonly [RegExp, SessionType]> = [
  [/research/i, 'Research'],
  [/design/i, 'Design'],
  [/structur/i, 'Structure'],
  [/\bplan\b|planning/i, 'Plan'],
  [/implement/i, 'Implementation'],
  [/verify|verification/i, 'Verify'],
];

/** The subset of AgentDTO this classifier reads — kept narrow so callers (and tests) can pass a
 *  fixture without constructing a full AgentDTO. */
export type SessionTypeSource = Pick<AgentDTO, 'name' | 'workflowGraph' | 'workflowState'>;

/** Classify one agent/session into a task-pipeline type chip. The spawn-time NAME wins: the chip
 *  answers "what kind of session is this?", not "what phase is it in right now" (verified live: a
 *  research session mid-Verify-node read as VERIFY when the node label won, conflating type with
 *  phase — the status chip already covers liveness). The current workflow node's label is the
 *  fallback for agents whose names carry no phase word at all. */
export function deriveSessionType(agent: SessionTypeSource): SessionType {
  const fromName = matchType(agent.name ?? '');
  if (fromName) return fromName;
  const currentNodeId = agent.workflowState?.currentNode;
  const nodeLabel = currentNodeId ? agent.workflowGraph?.nodes.find((node) => node.id === currentNodeId)?.label : undefined;
  return (nodeLabel && matchType(nodeLabel)) || 'Session';
}

function matchType(signal: string): SessionType | null {
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(signal)) return type;
  }
  return null;
}

/** Tone bucket per session type for the kit StatusChip — ember (the agent/active role in the
 *  kit's tone map) for every real derived phase, neutral for the untyped fallback so it visually
 *  reads as "less specific" rather than dressing a guess up as knowledge. */
export function sessionTypeTone(type: SessionType): 'ember' | 'neutral' {
  return type === 'Session' ? 'neutral' : 'ember';
}
