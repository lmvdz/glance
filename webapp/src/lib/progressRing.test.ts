/**
 * progressRing.test.ts — pure ring-geometry math (kit/ProgressRing.tsx). DOM-free (bun:test).
 */

import { expect, test, describe } from 'bun:test';
import { ringPct, ringDashOffset, ringCircumference } from './progressRing';

describe('ringPct', () => {
  test('value/total, clamped to [0,1]', () => {
    expect(ringPct(0, 10)).toBe(0);
    expect(ringPct(5, 10)).toBe(0.5);
    expect(ringPct(10, 10)).toBe(1);
  });

  test('a total of 0 (or negative) reads as an empty ring, not NaN/Infinity', () => {
    expect(ringPct(0, 0)).toBe(0);
    expect(ringPct(3, 0)).toBe(0);
    expect(ringPct(3, -1)).toBe(0);
  });

  test('value exceeding total clamps to 1 rather than overshooting the ring', () => {
    expect(ringPct(15, 10)).toBe(1);
  });

  test('a negative value clamps to 0', () => {
    expect(ringPct(-3, 10)).toBe(0);
  });
});

describe('ringDashOffset', () => {
  test('0% filled ⇒ offset equals the full circumference (nothing drawn)', () => {
    expect(ringDashOffset(0, 100)).toBe(100);
  });

  test('100% filled ⇒ offset is 0 (fully drawn)', () => {
    expect(ringDashOffset(1, 100)).toBe(0);
  });

  test('50% filled ⇒ half the circumference remains as offset', () => {
    expect(ringDashOffset(0.5, 100)).toBe(50);
  });
});

describe('ringCircumference', () => {
  test('2 * pi * r', () => {
    expect(ringCircumference(10)).toBeCloseTo(62.8318, 3);
  });
});
