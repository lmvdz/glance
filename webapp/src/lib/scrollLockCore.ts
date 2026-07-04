/**
 * Pure, DOM-free decision logic behind the astryx-derived scroll-lock hooks
 * (`hooks/chat/useChatStreamScroll.ts`, `hooks/chat/useChatNewMessages.ts`).
 *
 * Extracted so the algorithm — synthetic-scroll filtering, the lock/unlock
 * state machine, and the rAF spring step — is unit-testable under `bun test`
 * without a DOM. No jsdom/happy-dom exists in this repo (see DESIGN.md "Test
 * substrate" decision): DOM emulators return zero layout metrics, so they
 * can't exercise a spring driven by real `scrollHeight`/`offsetHeight`
 * numbers anyway. The hooks call these functions; DOM behavior itself is
 * covered by scripted manual flows.
 *
 * Known accepted degradations (carried over from upstream, not fixed here):
 * - `scrollend` is unsupported on older engines, so there is no automatic
 *   re-lock when the user scrolls back near the bottom — the "jump to
 *   latest" pill still works as a manual re-lock.
 * - Discrete, very large height jumps (e.g. a whole tool-call block landing
 *   in one WS frame) can outrun the spring in a single tick — matches
 *   upstream astryx issue #2282.
 */

// =============================================================================
// Scroll-event classification
// =============================================================================

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  offsetHeight: number;
}

export type ScrollClassification = "synthetic" | "user-up" | "user-down" | "unchanged";

/**
 * Classify a scroll event against the previous metrics snapshot.
 *
 * A change in `scrollHeight` or `offsetHeight` since the last event means
 * the scroll was caused by content resize (streaming growth, a `<details>`
 * toggle, a panel collapsing) rather than user intent — browsers (notably
 * Chrome) fire `scroll` events for these. Those are classified `synthetic`
 * and must never change lock state. Otherwise, direction of `scrollTop`
 * movement distinguishes `user-up` (unlocks) from `user-down`/`unchanged`
 * (no-op).
 */
export function classifyScrollEvent(previous: ScrollMetrics, current: ScrollMetrics): ScrollClassification {
  if (current.scrollHeight !== previous.scrollHeight || current.offsetHeight !== previous.offsetHeight) {
    return "synthetic";
  }
  if (current.scrollTop < previous.scrollTop) return "user-up";
  if (current.scrollTop > previous.scrollTop) return "user-down";
  return "unchanged";
}

// =============================================================================
// Lock-state transition
// =============================================================================

export type LockEvent =
  | { type: "scroll"; classification: ScrollClassification }
  | { type: "scrollend"; distanceFromBottom: number; lockThreshold: number }
  | { type: "wheel-up" }
  | { type: "touch-move" }
  | { type: "explicit-lock" }
  | { type: "explicit-unlock" };

/**
 * `(state, event) -> state` for the lock/unlock machine.
 *
 * - `scroll` with `user-up` unlocks; any other classification is a no-op
 *   (in particular `synthetic` never touches lock state).
 * - `scrollend` re-locks only when settled within `lockThreshold` px of the
 *   bottom (astryx default: 10px) — otherwise the state is unchanged. It
 *   never unlocks.
 * - `wheel-up`/`touch-move` are the fast-path interrupts callers should only
 *   emit while a spring animation is actually running (mirrors upstream:
 *   these fire ahead of the `scroll` event so the animation can be
 *   interrupted before the direction check catches up).
 * - `explicit-lock`/`explicit-unlock` back the hook's `lock()`/`unlock()`
 *   public API.
 */
export function nextLockState(locked: boolean, event: LockEvent): boolean {
  switch (event.type) {
    case "scroll":
      return event.classification === "user-up" ? false : locked;
    case "scrollend":
      return event.distanceFromBottom <= event.lockThreshold ? true : locked;
    case "wheel-up":
    case "touch-move":
      return false;
    case "explicit-lock":
      return true;
    case "explicit-unlock":
      return false;
    default:
      return locked;
  }
}

// =============================================================================
// Spring step
// =============================================================================

export interface SpringParams {
  /** How quickly the animation settles. */
  damping: number;
  /** How fast the animation accelerates. */
  stiffness: number;
  /** Higher = slower animation. */
  mass: number;
}

export interface SpringState {
  position: number;
  velocity: number;
}

export interface SpringStepResult extends SpringState {
  /** True when the spring has converged onto `target` and should stop ticking. */
  settled: boolean;
}

/**
 * One rAF tick of the scroll-follow spring: `(position, velocity, target,
 * dt) -> {position, velocity}`.
 *
 * `dt` is normalized to 60fps ticks (1.0 == one 16.67ms frame) so variable
 * frame timing doesn't change the perceived speed. Settles (stops ticking)
 * once the position is within 0.5px of target and velocity has decayed
 * below 0.1 — matching upstream's thresholds.
 *
 * `target` can be smaller than `position` (a front-trimmed transcript
 * shrinks `scrollHeight`, e.g. the 800-entry cap evicting old turns) — the
 * diff simply goes negative and the spring converges from the other
 * direction; no special-casing needed, no NaN/oscillation.
 */
export function springStep(state: SpringState, target: number, dt: number, params: SpringParams): SpringStepResult {
  const diff = target - state.position;

  if (Math.abs(diff) < 0.5 && Math.abs(state.velocity) < 0.1) {
    return { position: target, velocity: 0, settled: true };
  }

  const velocity = (params.damping * state.velocity + params.stiffness * diff) / params.mass;
  const position = state.position + velocity * dt;
  return { position, velocity, settled: false };
}
