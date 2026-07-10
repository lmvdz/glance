import type { AgentDTO } from './dto';

/** Human-facing label for an agent's PR-mode `prState`. Local-mode agents have no `prState`. */
export function prStateBadgeLabel(prState: NonNullable<AgentDTO['prState']>): string {
  switch (prState) {
    case 'draft':
    case 'open':
      return 'awaiting merge';
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed — unmerged';
  }
}

/** Tailwind badge classes for an agent's PR-mode `prState`, matching the existing badge palette. */
export function prStateBadgeClass(prState: NonNullable<AgentDTO['prState']>): string {
  switch (prState) {
    case 'draft':
    case 'open':
      return 'bg-amber-100 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400';
    case 'merged':
      return 'bg-emerald-100 font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400';
    case 'closed':
      return 'bg-red-100 font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-400';
  }
}

/** Tailwind badge classes for an agent's lifecycle `status`, matching the roster row's badge palette
 *  (border+bg+text triad; `starting`/`idle`/`working`'s working-adjacent states fall through to blue). */
export function agentStatusBadgeClass(status: AgentDTO['status']): string {
  switch (status) {
    case 'working':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400';
    case 'error':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400';
    case 'input':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400';
    case 'stopped':
      return 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400';
    default:
      return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400';
  }
}

/** Per-mode Land button label, shared between ActiveWorkPane and AssistantChat. */
export function landButtonLabel(agent: Pick<AgentDTO, 'prState' | 'landReady'>): string {
  if (agent.prState === 'merged') return 'Merged ✓';
  if (agent.prState) return 'Merge PR';
  if (agent.landReady) return 'Land ✓';
  return 'Land';
}

/**
 * The independent validator (Epic 3) explicitly rejected this change — a `veto` verdict on the
 * DTO. It is a *semantic* rejection that stands even when the deterministic proof is green, so it
 * must never read as "ready to land": every surface that shows a land decision derives it from here
 * so they can't drift. `abstain`/`skipped` are non-verdicts (no criteria, or judge unreachable) and
 * are deliberately NOT treated as a veto.
 */
export function isVetoed(agent: Pick<AgentDTO, 'validation'>): boolean {
  return agent.validation?.verdict === 'veto';
}

/**
 * True on a validator verdict that must read as a HOLD, never "safe to land" — a `veto` (semantic
 * rejection) or an `inconclusive` (eap-borrows follow-up 7: the land diff couldn't be COMPUTED, an
 * environmental git fault, distinct from a genuinely empty diff). Both can coexist with
 * `landReady:true`: the land attempt that produced the verdict doesn't clear the staged flag on a
 * blocked/retryable outcome — only a successful land does. Every surface that gates a "ready to land" /
 * "Land" affordance on `landReady` must exclude both, not just `veto` — a bare `verdict !== 'veto'`
 * check silently reads an `inconclusive` hold as a pass (the fail-open this helper closes).
 */
export function isValidatorHeld(agent: Pick<AgentDTO, 'validation'>): boolean {
  const v = agent.validation?.verdict;
  return v === 'veto' || v === 'inconclusive';
}

/** A rendered pill for the independent-validator verdict, or `null` when there's no verdict worth
 *  showing (`skipped` = no declared criteria to judge against). Title carries the judge's rationale. */
export function validationBadge(agent: Pick<AgentDTO, 'validation'>): { label: string; cls: string; title: string } | null {
  const v = agent.validation;
  if (!v || v.verdict === 'skipped') return null;
  // Cross-lineage review: a same-lineage (self-graded) verdict is a weaker signal and says so; a
  // genuine cross-vendor review is called out positively. Unknown lineage adds nothing (honest).
  const lineageNote =
    v.sameLineage === true
      ? `\n⚠ same-lineage review (${v.reviewerLineage ?? '?'} reviewing ${v.authorLineage ?? '?'}) — weaker signal`
      : v.sameLineage === false
        ? `\n✓ cross-lineage review (${v.reviewerLineage ?? '?'} reviewing ${v.authorLineage ?? '?'})`
        : '';
  const title = (v.rationale || 'Independent validator verdict') + lineageNote;
  switch (v.verdict) {
    case 'veto':
      return { label: 'vetoed', cls: 'bg-red-100 font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-400', title };
    case 'pass':
      return { label: 'validated', cls: 'bg-emerald-100 font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400', title };
    case 'abstain':
      return { label: 'unjudged', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', title };
    case 'inconclusive':
      // eap-borrows follow-up 7: the land diff couldn't be COMPUTED (a git fault), so the declared
      // criteria were never evaluated — a retryable hold, NOT a pass and NOT a veto. Amber like a
      // held state so it never reads as "ready to land".
      return { label: 'inconclusive', cls: 'bg-amber-100 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400', title };
  }
}

/** Run-end self-confidence as a pill. Below the daemon's default floor (0.4) a run is capped to
 *  propose-only, so the pill turns amber and says so — the reason an agent can be verified yet held.
 *  `null` until a run has finished (no confidence yet). */
export function confidenceBadge(agent: Pick<AgentDTO, 'confidence'>): { label: string; cls: string; title: string } | null {
  if (agent.confidence == null) return null;
  const pct = Math.round(agent.confidence * 100);
  const low = agent.confidence < 0.4; // mirrors backend confidenceFloor() default
  return low
    ? { label: `conf ${pct}% · propose-only`, cls: 'bg-amber-100 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400', title: 'Below the confidence floor — authority is capped to assist (propose-only); land is held for a human.' }
    : { label: `conf ${pct}%`, cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300', title: 'Run-end self-confidence' };
}
