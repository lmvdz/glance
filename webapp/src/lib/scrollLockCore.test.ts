import { expect, test } from "bun:test";
import { classifyScrollEvent, nextLockState, springStep, type SpringParams, type SpringState } from "./scrollLockCore";

const SPRING: SpringParams = { damping: 0.7, stiffness: 0.05, mass: 1.25 };

// =============================================================================
// classifyScrollEvent
// =============================================================================

test("classifyScrollEvent: scrollHeight growing with scrollTop unchanged is synthetic, not user intent", () => {
  const previous = { scrollTop: 400, scrollHeight: 1000, offsetHeight: 500 };
  const current = { scrollTop: 400, scrollHeight: 1200, offsetHeight: 500 };
  expect(classifyScrollEvent(previous, current)).toBe("synthetic");
});

test("classifyScrollEvent: offsetHeight changing (panel resize) is also synthetic", () => {
  const previous = { scrollTop: 400, scrollHeight: 1000, offsetHeight: 500 };
  const current = { scrollTop: 400, scrollHeight: 1000, offsetHeight: 480 };
  expect(classifyScrollEvent(previous, current)).toBe("synthetic");
});

test("classifyScrollEvent: scrollTop decreasing with stable metrics is user-up", () => {
  const previous = { scrollTop: 400, scrollHeight: 1000, offsetHeight: 500 };
  const current = { scrollTop: 350, scrollHeight: 1000, offsetHeight: 500 };
  expect(classifyScrollEvent(previous, current)).toBe("user-up");
});

test("classifyScrollEvent: scrollTop increasing with stable metrics is user-down", () => {
  const previous = { scrollTop: 350, scrollHeight: 1000, offsetHeight: 500 };
  const current = { scrollTop: 400, scrollHeight: 1000, offsetHeight: 500 };
  expect(classifyScrollEvent(previous, current)).toBe("user-down");
});

test("classifyScrollEvent: no change at all is unchanged", () => {
  const metrics = { scrollTop: 400, scrollHeight: 1000, offsetHeight: 500 };
  expect(classifyScrollEvent(metrics, { ...metrics })).toBe("unchanged");
});

// =============================================================================
// nextLockState
// =============================================================================

test("nextLockState: a synthetic scroll classification never changes lock state", () => {
  expect(nextLockState(true, { type: "scroll", classification: "synthetic" })).toBe(true);
  expect(nextLockState(false, { type: "scroll", classification: "synthetic" })).toBe(false);
});

test("nextLockState: user-up unlocks", () => {
  expect(nextLockState(true, { type: "scroll", classification: "user-up" })).toBe(false);
});

test("nextLockState: user-down leaves lock state alone", () => {
  expect(nextLockState(true, { type: "scroll", classification: "user-down" })).toBe(true);
  expect(nextLockState(false, { type: "scroll", classification: "user-down" })).toBe(false);
});

test("nextLockState: wheel-up unlocks", () => {
  expect(nextLockState(true, { type: "wheel-up" })).toBe(false);
});

test("nextLockState: touch-move unlocks", () => {
  expect(nextLockState(true, { type: "touch-move" })).toBe(false);
});

test("nextLockState: scrollend within the lock threshold re-locks", () => {
  expect(nextLockState(false, { type: "scrollend", distanceFromBottom: 6, lockThreshold: 10 })).toBe(true);
});

test("nextLockState: scrollend right at the lock threshold re-locks (inclusive boundary)", () => {
  expect(nextLockState(false, { type: "scrollend", distanceFromBottom: 10, lockThreshold: 10 })).toBe(true);
});

test("nextLockState: scrollend beyond the lock threshold leaves the unlocked state alone", () => {
  expect(nextLockState(false, { type: "scrollend", distanceFromBottom: 40, lockThreshold: 10 })).toBe(false);
});

test("nextLockState: scrollend never unlocks an already-locked state", () => {
  expect(nextLockState(true, { type: "scrollend", distanceFromBottom: 500, lockThreshold: 10 })).toBe(true);
});

test("nextLockState: explicit lock/unlock set state directly", () => {
  expect(nextLockState(false, { type: "explicit-lock" })).toBe(true);
  expect(nextLockState(true, { type: "explicit-unlock" })).toBe(false);
});

// =============================================================================
// springStep
// =============================================================================

test("springStep: converges toward target and terminates (settled) within a bounded number of ticks", () => {
  let state: SpringState = { position: 0, velocity: 0 };
  const target = 1000;
  let settled = false;
  let ticks = 0;
  const MAX_TICKS = 2000;

  while (!settled && ticks < MAX_TICKS) {
    const result = springStep(state, target, 1, SPRING);
    state = { position: result.position, velocity: result.velocity };
    settled = result.settled;
    ticks++;
  }

  expect(settled).toBe(true);
  expect(state.position).toBeCloseTo(target, 1);
  expect(ticks).toBeLessThan(MAX_TICKS);
});

test("springStep: a front-trimmed transcript (target shrinks below current position) converges from the other direction without NaN or oscillation blowup", () => {
  // Position starts near the (larger) old bottom; the transcript cap evicts
  // old entries, shrinking scrollHeight so the new target is below position.
  let state: SpringState = { position: 900, velocity: 0 };
  const target = 200;
  let settled = false;
  let ticks = 0;
  const MAX_TICKS = 2000;
  const seenPositions: number[] = [];

  while (!settled && ticks < MAX_TICKS) {
    const result = springStep(state, target, 1, SPRING);
    expect(Number.isFinite(result.position)).toBe(true);
    expect(Number.isFinite(result.velocity)).toBe(true);
    seenPositions.push(result.position);
    state = { position: result.position, velocity: result.velocity };
    settled = result.settled;
    ticks++;
  }

  expect(settled).toBe(true);
  expect(state.position).toBeCloseTo(target, 1);
  // No oscillation blowup: once within a small band of the target, later
  // positions never shoot far back out past the starting distance.
  const startDistance = Math.abs(900 - target);
  for (const position of seenPositions) {
    expect(Math.abs(position - target)).toBeLessThanOrEqual(startDistance + 1);
  }
});

test("springStep: reports settled=true immediately when already at rest on target", () => {
  const result = springStep({ position: 500, velocity: 0 }, 500, 1, SPRING);
  expect(result.settled).toBe(true);
  expect(result.position).toBe(500);
  expect(result.velocity).toBe(0);
});

test("springStep: a larger dt (slow frame) still moves monotonically closer to target on the first tick", () => {
  const result = springStep({ position: 0, velocity: 0 }, 1000, 3, SPRING);
  expect(result.position).toBeGreaterThan(0);
  expect(result.position).toBeLessThanOrEqual(1000);
});
