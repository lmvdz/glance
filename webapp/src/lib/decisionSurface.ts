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

// -------------------------------------------------------------------------------------------
// Supersede composer (DecisionsPanel's "record a replacement" action) — the UI's half of the
// human lane the server already ships (`POST /api/features/:id/decisions/supersede`,
// src/server.ts). The philosophy this exists to honor: a decision is never edited and never
// deleted, only replaced by a new one that supersedes it. So there is no "edit"/"delete" path
// anywhere on this surface — correcting a decision means writing its replacement.
// -------------------------------------------------------------------------------------------

/**
 * The UI's OWN pre-flight refusal for a replacement's text — checked before any request is ever
 * built, so an empty or whitespace-only submission never reaches the network at all. The server's
 * own `text and supersedes (decision id) required` 400 (src/server.ts) exists as a backstop for a
 * client that skips this check, not as the primary UX. Returns the reason to show the person, or
 * `undefined` when the text is fine to send.
 */
export function validateSupersedeText(text: string): string | undefined {
  if (!text.trim()) return 'A replacement needs its own words — write what actually replaces this decision before recording it.';
  return undefined;
}

/**
 * House-voice mapping from a failed supersede attempt to what a person should read. The route's
 * three 409 causes (src/server.ts) are each already a specific sentence — "supersedes target ...
 * not found", "... was already superseded — supersede the current decision instead", "an identical
 * decision is already current — no change" — so a 409 is surfaced VERBATIM rather than collapsed
 * into one generic "conflict" message; that server text already IS the "steer to what's current"
 * copy this UI owes the person, and re-wording it risks drifting from what the server actually did.
 * 400/404/anything-else fall back to an honest, specific sentence only for the rare case the server
 * sent no body text at all (a network failure short-circuited before a response reached the client).
 */
export function supersedeFailureMessage(status: number | undefined, serverMessage: string | undefined): string {
  const trimmed = serverMessage?.trim();
  if (status === 409) return trimmed || 'This decision changed since the page loaded — reload to see what is current before superseding it again.';
  if (status === 404) return trimmed || 'This feature could not be found — it may have been archived or deleted since the page loaded.';
  if (status === 400) return trimmed || 'The replacement needs its own text and a decision to replace — nothing was recorded.';
  return trimmed || 'The replacement was not recorded — the server never confirmed the write, so nothing changed.';
}

/** What `submitSupersede` hands back — `ok:false` always carries a `message` (the exact house-voice
 *  reason, ready to render); `ok:true` always carries the server's own `decision` record, never one
 *  fabricated client-side, so a caller can never move a decision to history before the write lands. */
export interface SupersedeSubmitResult {
  ok: boolean;
  decision?: TaskDecision;
  message?: string;
}

export interface SupersedeSubmitInput {
  text: string;
  decisionId: string;
  /** The actual network call, injected — see the module doc below for why. */
  postSupersede: (input: { decisionId: string; text: string }) => Promise<TaskDecision>;
}

/**
 * The supersede composer's submit path, factored out as a plain, framework-free function — the
 * same discipline `useVoiceDispatcher.ts`'s `dispatchPromptAgent` uses, for the same reason: this
 * package has no DOM/hook-render test harness (no happy-dom/jsdom, no @testing-library/react), so
 * the ordering this function pins — validate locally FIRST and never touch the network on empty/
 * whitespace text; on a rejection, translate the server's status+message into house voice; on
 * success, hand back the server's OWN decision rather than a locally-guessed one — has to be
 * testable without a React render. `postSupersede` is injected so a test double and the real
 * `apiJson`-backed call are interchangeable, and this exercises the EXACT code the composer runs.
 */
export async function submitSupersede(input: SupersedeSubmitInput): Promise<SupersedeSubmitResult> {
  const reason = validateSupersedeText(input.text);
  if (reason) return { ok: false, message: reason };
  try {
    const decision = await input.postSupersede({ decisionId: input.decisionId, text: input.text.trim() });
    return { ok: true, decision };
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? (error as { status?: unknown }).status : undefined;
    const message = error instanceof Error ? error.message : undefined;
    return { ok: false, message: supersedeFailureMessage(typeof status === 'number' ? status : undefined, message) };
  }
}
