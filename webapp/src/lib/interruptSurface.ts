/**
 * interruptSurface — what is allowed to reach you when you are not looking at the room.
 *
 * `04-beyond.html` puts a notification outside the app at real size and spends the whole screen on
 * one idea: *"one sentence, what happens if you do nothing, two actions and a reply. Three conditions
 * earned it."* The conditions are the product, not the delivery.
 *
 * `src/leaving-the-app.ts` implements exactly that — three conditions that must hold AT ONCE, a
 * mandatory nine-minute wait because most things that look blocking at minute zero are gone by minute
 * nine, and a review afterwards because a gate whose decisions are never checked drifts, and the
 * direction it drifts is always toward sending more.
 *
 * It is now wired, and OFF by default: `GLANCE_INTERRUPT=1` turns it on, and web push additionally
 * needs a device to have subscribed, so somebody who never opted in still receives nothing. This
 * screen's first job is to say which of those two states it is in, because a gate that declined and a
 * gate nothing asks produce the same "0 sent" and mean opposite things.
 *
 * Its second job is the review. A gate keeps its licence to interrupt people only by being checked
 * afterwards, and it can only be checked if saying so is one tap.
 */

export interface GateHealth {
  sent: number;
  cancelledByDelay: number;
  reviewed: number;
  worthIt: number;
  sentence: string;
}

export interface AwaitingReview {
  id: string;
  question: string;
  sentAt: number;
}

export interface InterruptState {
  health?: GateHealth;
  /** Sends nobody has judged yet. The gate keeps its licence by being checked. */
  awaitingReview?: AwaitingReview[];
  /** True when the needs-you gate is actually consulted before anything is sent. */
  wired: boolean;
  /** What DOES leave the app today, named. */
  leaves: string[];
  recoveryDelayMs: number;
}

/** The three conditions, in the order the gate checks them, with why each one exists. */
export const CONDITIONS: Array<{ condition: string; because: string }> = [
  {
    condition: 'No rule can settle it',
    because: 'If the fleet has been told what to do here, telling you is telling you something you already decided.',
  },
  {
    condition: 'It blocks work that would otherwise be moving',
    because: 'A question nothing is waiting on can wait.',
  },
  {
    condition: 'One sentence can answer it',
    because: 'Anything needing a screen is not a notification, it is an appointment — and pretending otherwise wastes the interruption.',
  },
];

export const ALL_THREE =
  'All three have to hold at once. Two out of three does not leave the building, because two out of three is how a gate starts drifting toward sending more.';

/** The wait, in the terms that justify it. */
export function delaySentence(recoveryDelayMs: number): string {
  const minutes = Math.round(recoveryDelayMs / 60_000);
  return `Then it waits ${minutes} minutes. Most things that look blocking at minute zero are settled by minute ${minutes} — by a retry, by a sibling finishing, by the agent finding another way. Sending immediately optimises for the system’s confidence rather than your evening.`;
}

/**
 * The headline.
 *
 * When the gate is not wired, that IS the headline — ahead of any statistics, because "0 sent" from
 * an unwired gate and "0 sent" from a gate that considered and declined are the same number meaning
 * opposite things.
 */
export function interruptHeadline(state: InterruptState): string {
  if (!state.wired) {
    return 'Nothing about work waiting on you ever leaves this app. The gate that would decide is built and is not connected to anything — so if you walk away from a stopped unit, nothing follows you.';
  }
  return state.health?.sentence ?? 'Nothing has been recorded about interruptions yet.';
}

/** Said only when it is true, and said as a defect rather than as a setting. */
export function unwiredNote(state: InterruptState): string | undefined {
  if (state.wired) return undefined;
  return 'That is a gap, not a policy. The conditions below are the ones it would apply, and they are worth reading anyway — they are the standard anything reaching you is held to, and the reason this is not simply switched on is that switching it on without them is how a product starts buzzing people.';
}

/** What genuinely does leave, so the page is not read as "nothing ever reaches me". */
export function leavesSentence(leaves: readonly string[]): string {
  if (leaves.length === 0) return 'Nothing leaves this app at all. Every device subscription you have is unused.';
  return `What does leave: ${leaves.join(', ')}. Nothing else — and none of it is about work waiting on you.`;
}

/**
 * Whether the gate has evidence it is calibrated.
 *
 * Unreviewed sends are the thing to say out loud: a gate whose sends are never reviewed has no
 * evidence it is behaving, and no evidence of a problem is not evidence of no problem.
 */
export function calibrationLine(health: GateHealth | undefined): string | undefined {
  if (!health || health.sent === 0) return undefined;
  const unreviewed = health.sent - health.reviewed;
  if (unreviewed > 0) {
    return `${unreviewed} of ${health.sent} interruptions were never reviewed. A gate whose sends are never checked has no evidence it is calibrated, and no evidence of a problem is not evidence of no problem.`;
  }
  return `Every one of the ${health.sent} was reviewed afterwards, and you said ${health.worthIt} ${health.worthIt === 1 ? 'was' : 'were'} worth it.`;
}

/** The ask, for a send nobody has judged yet. Named so it reads as a question, not a survey. */
export function reviewPrompt(item: AwaitingReview, now: number): string {
  const mins = Math.max(1, Math.round((now - item.sentAt) / 60_000));
  return `${item.question} — sent ${mins} minute${mins === 1 ? '' : 's'} ago. Was interrupting you right?`;
}

/** Why the ask exists, said once beneath the list rather than on every row. */
export const WHY_REVIEW =
  'Answering this is the only thing keeping the gate honest. A gate whose sends are never checked drifts, and the direction it drifts is always toward sending more.';
