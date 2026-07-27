/**
 * docSurface — reading a plan, and what happened to what you wrote on it.
 *
 * `06-other-side.html` names the zone this exists for: **WHAT HAPPENED TO WHAT YOU WROTE**, and it
 * draws the answer as a lifecycle in one line — *"written 15:45:31 · sent 15:51:02 · received and read
 * back by Wren."* Three different states, three different amounts of certainty, and the difference
 * between them is the entire value of the surface. A comment that was written and never sent looks
 * exactly like one that was acted on, if all you render is the comment.
 *
 * The two screens this replaces both had the data and neither had the distinction. The design-review
 * view showed "Design Review N/M resolved" over a progress bar; the plan-detail view showed a
 * comments rail with a resolve tick. Resolved-vs-open is one bit where there are three facts, and the
 * missing one — *did anybody ever receive this* — is the one that costs you an afternoon.
 */

export interface DocComment {
  id: string;
  body: string;
  author: string;
  createdAt: number;
  resolvedAt?: number;
  /** Present once the comment was pushed to the agent working on it. */
  sentAt?: number;
  /** Present once an agent said something back about it. */
  acknowledgedAt?: number;
  heading?: string;
  quote?: string;
}

export type WroteState = 'written' | 'sent' | 'acknowledged' | 'resolved';

/** Which of the three-plus-one states this comment is actually in. Never inferred from resolved alone. */
export function wroteState(comment: DocComment): WroteState {
  if (comment.resolvedAt) return 'resolved';
  if (comment.acknowledgedAt) return 'acknowledged';
  if (comment.sentAt) return 'sent';
  return 'written';
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The lifecycle line, in the reference's own shape.
 *
 * The `written` case is the one that matters: it says outright that nobody has seen it, because a
 * comment sitting unsent looks identical to one being worked on unless the surface says so.
 */
export function whatHappenedToIt(comment: DocComment): string {
  const written = `written ${time(comment.createdAt)}`;
  switch (wroteState(comment)) {
    case 'resolved':
      return `${written} · settled ${time(comment.resolvedAt!)}`;
    case 'acknowledged':
      return `${written} · sent ${time(comment.sentAt!)} · read back ${time(comment.acknowledgedAt!)}`;
    case 'sent':
      return `${written} · sent ${time(comment.sentAt!)} · nobody has said anything back yet`;
    default:
      return `${written} · never sent. Nobody has seen this — it is a note to yourself until it goes somewhere.`;
  }
}

export const STATE_TONE: Record<WroteState, string> = {
  written: '#B4553A',
  sent: '#D9A03C',
  acknowledged: '#3E5C8A',
  resolved: '#3E7D57',
};

/**
 * The headline over a document's comments.
 *
 * Leads with anything unsent, because that is the only state where the reader is the blocker and does
 * not know it. "4 of 9 resolved" leads with progress, which is exactly the wrong end.
 */
export function commentsHeadline(comments: readonly DocComment[]): string {
  if (comments.length === 0) return 'Nothing has been written on this document. It has been read or it has not — there is no way to tell those apart from here.';
  const unsent = comments.filter((comment) => wroteState(comment) === 'written');
  const open = comments.filter((comment) => !comment.resolvedAt);
  if (unsent.length > 0) {
    return `${unsent.length} thing${unsent.length === 1 ? '' : 's'} you wrote ${unsent.length === 1 ? 'has' : 'have'} never been sent to anyone. Until ${unsent.length === 1 ? 'it goes' : 'they go'} somewhere ${unsent.length === 1 ? 'it is a note' : 'they are notes'} to yourself.`;
  }
  if (open.length === 0) return `Everything written here is settled. ${comments.length} thing${comments.length === 1 ? '' : 's'}, all of them answered.`;
  return `${open.length} of ${comments.length} still open, and all of them have reached somebody.`;
}

/**
 * Whether this plan is ready to be built, as a sentence rather than a gate light.
 *
 * The old screen offered "Create implementation session" the moment N/M hit zero and called it a
 * gate, while being advisory-only. Saying a thing is a gate when nothing enforces it is worse than
 * having no gate: the reader relaxes on a promise the system never made.
 */
export function readinessLine(comments: readonly DocComment[]): string {
  const open = comments.filter((comment) => !comment.resolvedAt);
  if (comments.length === 0) return 'Nothing has been raised against this plan. That is not agreement — it is silence, and nobody has said which.';
  if (open.length > 0) return `${open.length} thing${open.length === 1 ? '' : 's'} still open against this plan. Nothing stops you starting anyway; this is a reading, not a lock.`;
  return 'Everything raised against this plan has been settled. Nothing here prevents starting it — nothing here ever did.';
}

/** Group by the section they were written against, keeping unanchored ones visible rather than lost. */
export function byHeading(comments: readonly DocComment[]): Array<{ heading: string; comments: DocComment[] }> {
  const groups = new Map<string, DocComment[]>();
  for (const comment of comments) {
    const key = comment.heading ?? '';
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  return [...groups.entries()]
    .map(([heading, list]) => ({ heading: heading || 'not anchored to any section', comments: list }))
    // Unanchored last: they are the hardest to act on and should not head the list.
    .sort((a, b) => Number(a.heading.startsWith('not anchored')) - Number(b.heading.startsWith('not anchored')));
}
