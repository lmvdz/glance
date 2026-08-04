import type { VoiceCallTranscriptEntryDTO } from '../api';
import type { ChannelCardRegister } from '../channelTimeline';

/**
 * transcript.ts — pure logic for the call's conversation pane (concern 11,
 * plans/voice-orchestrated-room-integration/11-voice-transcript-in-thread.md).
 *
 * Product decision (2026-07-28, recorded in the concern doc): the voice conversation renders in a
 * CALL-SCOPED pane, opened from the voice-call card's door — never interleaved into the main
 * channel timeline. `#fleet` (and any room's main timeline) gets no turns, ever. Everything else
 * follows `lib/voice/roomCall.ts`'s own discipline: pure functions, honest about what is known and
 * what is only a claim, and a view-model the component renders without re-deriving anything.
 */

/** Turns collapse by `(role, turn)` — the SAME key the daemon's own `transcript()` read already
 *  collapses by (see `fetchVoiceCallTranscript`'s doc). Named so both the merge below and any future
 *  caller spell the key identically. */
export function transcriptTurnKey(entry: Pick<VoiceCallTranscriptEntryDTO, 'role' | 'turn'>): string {
  return `${entry.role}\0${entry.turn}`;
}

/** Chronological order for a set of turns just read fresh (a full REST fetch). The server already
 *  collapses duplicates by `(role, turn)`; this only orders them, by `at` — never by array position,
 *  since a live-merged entry (see `mergeLiveTurn`) may have been spliced in out of fetch order. */
export function sortTranscriptTurns(entries: readonly VoiceCallTranscriptEntryDTO[]): VoiceCallTranscriptEntryDTO[] {
  return [...entries].sort((a, b) => a.at - b.at || a.turn - b.turn);
}

/**
 * Merges one live-pushed turn into an already-sorted list — the "streaming caption replaced in
 * place" behaviour the concern doc names explicitly: a NON-final turn for `(role, turn)` becomes a
 * new row once, and every later push for the SAME key (partial→partial, or partial→final) replaces
 * that row in place rather than appending a new one. A key never seen before is inserted in
 * chronological position by `at`, matching what a full re-fetch would have produced anyway — so a
 * poll landing right after a live push can never visibly reorder anything.
 */
export function mergeLiveTurn(entries: readonly VoiceCallTranscriptEntryDTO[], incoming: VoiceCallTranscriptEntryDTO): VoiceCallTranscriptEntryDTO[] {
  const key = transcriptTurnKey(incoming);
  const index = entries.findIndex((entry) => transcriptTurnKey(entry) === key);
  if (index >= 0) {
    const next = entries.slice();
    next[index] = incoming;
    return next;
  }
  return sortTranscriptTurns([...entries, incoming]);
}

/**
 * The register for a turn's own text — mirrors `decisionDoorModel`'s "always claim" rule in
 * `roomCall.ts` for the SAME reason: the agent's spoken words are its own account, recorded because
 * the call happened, not because anything checked they are true. A human caller's turn carries NO
 * register at all — same precedent as `channelTimeline.ts`'s `VOICE_KINDS` gate, which only ever
 * applies a register to agent-authored text, never to a room member's own words.
 */
export function transcriptTurnRegister(role: VoiceCallTranscriptEntryDTO['role']): ChannelCardRegister | undefined {
  return role === 'assistant' ? 'claim' : undefined;
}

export function transcriptTurnSpeakerLabel(role: VoiceCallTranscriptEntryDTO['role']): string {
  return role === 'assistant' ? 'Agent' : 'You';
}

/** What to show for one turn's body — honest about redaction rather than rendering an empty line
 *  that reads as "nothing was said". Mirrors `retentionNotice`'s own discipline in `roomCall.ts`. */
export function transcriptTurnBody(entry: Pick<VoiceCallTranscriptEntryDTO, 'text' | 'redacted'>): string {
  if (entry.redacted) return 'Not recorded — this call’s retention does not keep full turns.';
  return entry.text ?? '';
}

/** A gap marker's copy, when one is stamped on a turn (`gapBefore`, the daemon's own honest "some
 *  journal records were missed before this one" signal — see `voice-call-projection.ts`'s doc). */
export function transcriptGapCopy(gapBefore: { missingCount: number }): string {
  return gapBefore.missingCount === 1 ? '1 turn was missed here — the record has a gap.' : `${gapBefore.missingCount} turns were missed here — the record has a gap.`;
}

/** Whether consecutive turns should visually group under one speaker header — same-role, same-
 *  redaction-state runs with nothing else between them, matching the timeline's own `groupLifecycleRuns`
 *  precedent (fold consecutive same-shape events into one visual run rather than repeating chrome). */
export function transcriptTurnStartsNewGroup(entries: readonly VoiceCallTranscriptEntryDTO[], index: number): boolean {
  if (index === 0) return true;
  const previous = entries[index - 1]!;
  const current = entries[index]!;
  return previous.role !== current.role || Boolean(previous.gapBefore) !== Boolean(current.gapBefore) || Boolean(current.gapBefore);
}

/** The empty-state sentence — distinct reasons read differently: a call that produced no speech yet
 *  is not the same fact as a call that never bound this channel, or one whose retention is `off`. */
export function transcriptEmptyCopy(input: { hasBinding: boolean; retentionOff: boolean; loading: boolean }): string {
  if (input.loading) return 'Reading the conversation…';
  if (!input.hasBinding) return 'No call has run in this thread yet, so there is no conversation to show.';
  if (input.retentionOff) return 'This call is not recording, so no turns are kept.';
  return 'Nothing has been said yet.';
}
