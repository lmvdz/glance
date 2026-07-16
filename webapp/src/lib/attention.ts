/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Operator-attention client (plans/comprehension/01-attention-substrate.md). Mirrors
// `src/attention.ts`'s `AttentionKind`/event shape server-side — deliberately NOT the same
// identifier as `dto.ts`'s existing `AttentionEvent` (an unrelated agent-notify signal); see that
// file's own naming note. Concern 02's viewport observers (`IntersectionObserver` + visibility
// gate) and concern 08's "surprised me" chip both call `reportAttention` — this file only owns the
// pure decision logic and the wire call, never DOM wiring.

import { apiJson, jsonInit } from './api';

// Named `OperatorAttentionKind`, not the bare `AttentionKind` — that identifier already exists
// twice in this package (`insights.ts`'s fleet-badge kinds, an unrelated concept) and colliding a
// THIRD time here would make every future grep/import ambiguous.
export type OperatorAttentionKind = 'diff-viewed' | 'answer-read' | 'debrief-heard' | 'pr-reviewed' | 'surprise';

/** What a client may report. `viewerId`/`at` are deliberately absent — the daemon stamps both
 *  server-side (comprehension concern 01's tenant-scoping rule); sending them here would just be
 *  silently ignored (`AttentionEventBodySchema` strips unknown/unlisted fields). */
export interface AttentionReport {
  kind: OperatorAttentionKind;
  repo: string;
  file?: string;
  agentId?: string;
  answerId?: string;
  prNumber?: number;
}

/**
 * Fire-and-forget: attention is a best-effort telemetry signal, and a network hiccup or a 400/429
 * from the daemon must never surface as a broken view (DESIGN.md "Privacy posture" row treats this
 * the same as every other non-critical background report). Callers never await this and never see
 * a rejection.
 */
export function reportAttention(evt: AttentionReport): void {
  apiJson('/api/attention', jsonInit('POST', evt)).catch(() => {
    // Swallowed on purpose — see module doc.
  });
}

/** Five-minute floor (DESIGN.md "Seen semantics" row: "a 40-file diff must not be 'seen' by a
 *  2-second tab flick", and the inverse — a file genuinely re-visited after 5 minutes IS a new
 *  signal worth another event, not silence forever). */
const FLOOR_MS = 5 * 60 * 1000;

/**
 * Pure floor predicate: `true` when `key` was last emitted (per `state`) more than `FLOOR_MS`
 * before `now`, or was never emitted at all. Does NOT mutate `state` — the caller records its own
 * emission (`state[key] = now`) only after actually calling `reportAttention`, so a dropped/failed
 * emit never falsely floors the next legitimate one. Concern 02 keys the observer's floor by
 * `(agentId,file)`, not a content hash, so the 4s working-poll re-render never re-triggers it.
 */
export function shouldEmit(state: Record<string, number>, key: string, now: number): boolean {
  const last = state[key];
  return last === undefined || now - last >= FLOOR_MS;
}

// =================================================================================================
// diff-viewed (concern 02): IntervenceView's per-file IntersectionObserver decision logic. Kept
// pure and DOM-free here so it's unit-tested without a browser — the component only wires the
// observer and calls these; DESIGN.md's "Seen semantics" row's three guards (50% intersection,
// visible tab, 5-min floor) are ALL decided here, never in IntervenceView.tsx.
// =================================================================================================

/** Minimum IntersectionObserver ratio for a diff section to count as "seen" — a sliver at the
 *  viewport's top/bottom edge is not "seen" (DESIGN.md: binary viewport entry, not dwell time). */
export const DIFF_VIEWPORT_THRESHOLD = 0.5;

/** Floor-state key for one (agentId,file) pair. NOT a content hash — the 4s working-poll re-fetches
 *  the same file's diff text on an unchanged DOM node, and that must never look like a fresh key.
 *  NUL-separated like the daemon's seen-map key (`${repo}\0${file}`): no path can contain `\0`, so
 *  two distinct pairs can never collide into one key. */
export function diffViewedKey(agentId: string, file: string): string {
  return `${agentId}\0${file}`;
}

/**
 * Whether an IntersectionObserver callback firing for one file section should emit `diff-viewed`.
 * `false` whenever ANY of: the tab isn't the visible one (`document.visibilityState`), the section
 * hasn't cleared the 50% intersection threshold, or the (agentId,file) 5-minute floor hasn't
 * elapsed. Does not mutate `state` — same contract as `shouldEmit`: the caller only records the
 * emission after actually calling `reportAttention`.
 */
export function shouldEmitDiffViewed(args: {
  state: Record<string, number>;
  agentId: string;
  file: string;
  intersectionRatio: number;
  visibilityState: string;
  now: number;
}): boolean {
  const { state, agentId, file, intersectionRatio, visibilityState, now } = args;
  if (visibilityState !== 'visible') return false;
  if (intersectionRatio < DIFF_VIEWPORT_THRESHOLD) return false;
  return shouldEmit(state, diffViewedKey(agentId, file), now);
}

// =================================================================================================
// pr-reviewed (concern 02): click-through to the PR emits one `pr-reviewed` event plus a
// `diff-viewed`-equivalent per file in the currently loaded diff set (DESIGN.md's "pr-reviewed"
// row). The per-file events still respect the same floor as the viewport observer — a file already
// marked seen minutes ago by scrolling doesn't get double-counted just because the operator also
// clicked through to the PR — so a click-through and a real scroll can never double-report the
// same (agentId,file) pair inside one floor window.
// =================================================================================================

/**
 * Builds the events a PR-link click-through should send, and which floor keys to mark once they're
 * actually sent. Pure: takes the current floor `state` and returns data, never mutates or calls
 * `reportAttention` itself — IntervenceView.tsx sends `events` and then stamps `markKeys` into its
 * own floor-state ref, mirroring the `shouldEmit`/record-after-send contract everywhere else here.
 */
export function prReviewedEvents(args: {
  state: Record<string, number>;
  repo: string;
  agentId: string;
  prNumber?: number;
  files: string[];
  now: number;
}): { events: AttentionReport[]; markKeys: string[] } {
  const { state, repo, agentId, prNumber, files, now } = args;
  const events: AttentionReport[] = [{ kind: 'pr-reviewed', repo, agentId, prNumber }];
  const markKeys: string[] = [];
  for (const file of files) {
    const key = diffViewedKey(agentId, file);
    if (shouldEmit(state, key, now)) {
      events.push({ kind: 'diff-viewed', repo, agentId, file });
      markKeys.push(key);
    }
  }
  return { events, markKeys };
}

// =================================================================================================
// answer-read (concern 02): CLI display paths call the daemon directly (src/index.ts); this webapp
// helper is called by the ⌘K palette when an answer row is selected (CommandPalette.tsx, wired by
// concern 10). DESIGN.md's "answer-read / debrief-heard" row: client-side explicit acks only, never
// a GET/poll hook.
// =================================================================================================

/** Report an answer as read from an explicit webapp display path (concern 10's future wiring point). */
export function reportAnswerRead(repo: string, answerId: string): void {
  reportAttention({ kind: 'answer-read', repo, answerId });
}
