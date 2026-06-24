import type { AgentStatus, FeatureStage } from "./dto";

export const STAGE_LABEL: Record<FeatureStage, string> = {
  planned: "Planned",
  "issues-created": "Issues created",
  "in-progress": "In progress",
  review: "Review",
  diverged: "Diverged",
  landed: "Landed",
  done: "Done",
};

/** CSS custom-property for a feature stage's glyph color. */
export function stageColorVar(stage: string): string {
  switch (stage) {
    case "done":
    case "landed":
      return "var(--color-glyph-done)";
    case "review":
      return "var(--color-glyph-review)";
    case "in-progress":
      return "var(--color-glyph-progress)";
    case "issues-created":
    case "planned":
      return "var(--color-glyph-planned)";
    case "diverged":
      return "var(--color-glyph-cancelled)";
    default:
      return "var(--color-glyph-draft)";
  }
}

export const AGENT_LABEL: Record<AgentStatus, string> = {
  starting: "Starting",
  working: "Working",
  idle: "Idle",
  input: "Needs input",
  error: "Error",
  stopped: "Stopped",
};

/** CSS custom-property for an agent status color (ring / badge / pill). */
export function agentColorVar(status: AgentStatus): string {
  switch (status) {
    case "working":
      return "var(--color-accent)";
    case "input":
      return "var(--color-progress)";
    case "error":
      return "var(--color-cancelled)";
    case "starting":
      return "var(--color-planned)";
    case "idle":
      return "var(--color-text-muted)";
    default:
      return "var(--color-text-faint)";
  }
}

/** Attention priority: does this agent demand the operator right now? */
export function isAttention(status: AgentStatus): boolean {
  return status === "input" || status === "error";
}
