import { expect, test } from 'bun:test';
import { railFooterContext } from './WorkbenchPane';
import type { AppView } from '../context/TaskContext';

// Taste-review nit 1: the expanded rail's task-scoped block only renders on Tasks, so every other
// view used to leave the middle area an empty void below four short nav rows. railFooterContext is
// the pure per-view copy for the calm footer-anchored line that closes that "intentional vs empty"
// gap — one line, no new panel.

const zero = { needsYouCount: 0, packCount: 0, catalogCount: 0 };

test('tasks renders nothing — the task-scoped block already fills the rail there', () => {
  expect(railFooterContext('tasks', zero)).toBe('');
});

test('fleet: nothing needs you reads as an explicit all-clear, not a blank', () => {
  expect(railFooterContext('fleet', zero)).toBe('All clear — nothing needs you');
});

test('fleet: singular vs plural agrees with needsYouCount', () => {
  expect(railFooterContext('fleet', { ...zero, needsYouCount: 1 })).toBe('1 agent needs you');
  expect(railFooterContext('fleet', { ...zero, needsYouCount: 3 })).toBe('3 agents need you');
});

test('graph gets a fixed one-liner describing what lives there', () => {
  expect(railFooterContext('omp-graph', zero)).toBe('Fleet activity, cost, and lineage over time');
});

test('capabilities reports trusted packs and catalog size, singular/plural-safe', () => {
  expect(railFooterContext('capabilities', { ...zero, packCount: 1, catalogCount: 5 })).toBe('1 trusted pack · 5 in the catalog');
  expect(railFooterContext('capabilities', { ...zero, packCount: 4, catalogCount: 0 })).toBe('4 trusted packs · 0 in the catalog');
});

test('daily gets a fixed one-liner naming its two signals', () => {
  expect(railFooterContext('daily', zero)).toBe('Adoption counters and the friction ledger');
});

test('org and intervene and review each get a short, non-empty line', () => {
  const routedInto: AppView[] = ['org', 'intervene', 'review'];
  for (const view of routedInto) {
    expect(railFooterContext(view, zero).length).toBeGreaterThan(0);
  }
});
