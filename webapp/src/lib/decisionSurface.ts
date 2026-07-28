/**
 * decisionSurface — the feature's decision ledger and acceptance criteria, read on the surface a
 * person actually reaches by opening a task (DocSurface).
 *
 * A live UI audit found both were fully wired server-side — `FeatureDecision[]` and
 * `acceptanceCriteria` come back on `GET /api/features`, are writable via `PATCH /api/features/:id`,
 * and supersession has its own verb (`POST /api/features/:id/decisions/supersede`) — and rendered
 * NOWHERE. Clicking a feature landed on a plan-doc comment thread that showed none of it. A
 * purpose-built formatter, `deltaBullets()` in intervene.ts, already existed for the model-delta slice
 * and had zero callers.
 *
 * Ledger semantics (src/types.ts's `FeatureDecision` doc, "invalidate, never delete, never coexist"):
 * a decision with no `supersededBy` is CURRENT; one WITH a `supersededBy` is HISTORY — it stays on the
 * record forever, it just stopped being the answer a future agent should inherit. Rendering `decisions`
 * flat would silently un-invalidate a reversed call the instant two contradictory entries sat side by
 * side with no way to tell which one is real, which is the exact failure the supersede verb exists to
 * prevent. The split below is the whole point of this surface, not a filter of convenience.
 */

import type { TaskDecision } from '../types';

export interface DecisionSplit {
  current: TaskDecision[];
  superseded: TaskDecision[];
}

const byRecency = (a: TaskDecision, b: TaskDecision) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity);

/** Named explicitly (blind-review hardening) rather than a bare `d.supersededBy` truthiness check
 *  at each call site: an empty-string `supersededBy` must read as "not superseded", never as a
 *  dangling/self-referential pointer that happens to be falsy-but-present. `Boolean(x?.length)`
 *  makes that reading the same everywhere this predicate is used, not just where someone remembered. */
export function isSuperseded(decision: Pick<TaskDecision, 'supersededBy'>): boolean {
  return Boolean(decision.supersededBy?.length);
}

/**
 * Current decisions (no `supersededBy`) and superseded ones (history), each newest-first. A decision
 * with no `createdAt` (a record predating the field, or a plan-derived one) sinks to the end of its
 * group rather than being guessed into "just now" — an unknown age is not the same fact as a fresh one.
 *
 * Junk-graph safe by construction: this is a flat filter over `supersededBy`, never a lookup against
 * other decisions' ids. A `supersededBy` that names a decision not present on the feature, or names
 * itself, still marks the decision historical and it still appears exactly once in `superseded` —
 * there is no id-resolution step that could throw on a dangling pointer or silently drop a self-
 * referential one.
 */
export function splitDecisions(decisions: readonly TaskDecision[]): DecisionSplit {
  return {
    current: decisions.filter((d) => !isSuperseded(d)).sort(byRecency),
    superseded: decisions.filter((d) => isSuperseded(d)).sort(byRecency),
  };
}

/** Above this many superseded decisions, history collapses behind a disclosure — still one click away,
 *  never hidden outright, but not competing with the CURRENT ledger for the reader's first look. */
export const SUPERSEDED_INLINE_MAX = 2;

export function shouldCollapseSuperseded(supersededCount: number): boolean {
  return supersededCount > SUPERSEDED_INLINE_MAX;
}

const SOURCE_LABEL: Record<NonNullable<TaskDecision['source']>, string> = {
  plan: 'plan',
  human: 'human',
  agent: 'agent',
  'model-delta': 'model delta',
};

/** The small provenance label beside a decision. An absent `source` (decisions recorded before the
 *  field existed) reads as "recorded" — an honest unknown, never a fabricated source. */
export function decisionSourceLabel(source: TaskDecision['source']): string {
  return source ? SOURCE_LABEL[source] : 'recorded';
}

/** "3h ago" / "2d ago" style age, or undefined when there is no `createdAt` to read — the caller must
 *  not show an age it does not have (see `decisionSourceLabel`'s same discipline). */
export function decisionAge(createdAt: number | undefined, now = Date.now()): string | undefined {
  if (!createdAt) return undefined;
  const diff = Math.max(0, now - createdAt);
  if (diff < 60_000) return 'moments ago';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** House voice for a feature that has genuinely never had a decision recorded against it — matches
 *  QuietRoom's "first visit, not a quiet morning" register: state what is true (no history exists yet),
 *  not just that the list is empty. */
export function decisionsEmptyState(): string {
  return "Nothing has been decided here yet — this is a first visit, not a quiet stretch. Whatever the plan, a person, or an agent settles on collects here as it happens, and nothing recorded is ever removed, only superseded.";
}

/** House voice for a feature with no declared acceptance criteria — an absence, not a checklist that
 *  happens to be empty, so it says so rather than rendering a bare "0 of 0". */
export function criteriaEmptyState(): string {
  return "No acceptance criteria are declared for this feature — that is an absence, not a checklist waiting to be filled. Nothing here is being measured against anything yet.";
}

/** Plain-sentence rollup for the acceptance-criteria header — "3 of 5 met", not a progress bar the
 *  reader has to interpret. */
export function criteriaHeadline(criteria: readonly { completed: boolean }[]): string {
  if (criteria.length === 0) return criteriaEmptyState();
  const done = criteria.filter((c) => c.completed).length;
  if (done === criteria.length) return `All ${criteria.length} met.`;
  return `${done} of ${criteria.length} met.`;
}
