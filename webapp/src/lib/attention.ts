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
