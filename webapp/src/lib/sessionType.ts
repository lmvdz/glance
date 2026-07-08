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

/** Classify one agent/session into a task-pipeline type chip. Live node label wins over the static
 *  name (a long-running workflow's phase changes over its life; the name was set once at spawn). */
export function deriveSessionType(agent: SessionTypeSource): SessionType {
  const currentNodeId = agent.workflowState?.currentNode;
  const nodeLabel = currentNodeId ? agent.workflowGraph?.nodes.find((node) => node.id === currentNodeId)?.label : undefined;
  const signal = nodeLabel ?? agent.name ?? '';
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(signal)) return type;
  }
  return 'Session';
}

/** Tone bucket per session type, for StatusChip-style coloring — ember (agent-active) family for
 *  every real phase, neutral for the untyped fallback so it visually reads as "less specific". */
export function sessionTypeTone(type: SessionType): 'agent' | 'neutral' {
  return type === 'Session' ? 'neutral' : 'agent';
}
