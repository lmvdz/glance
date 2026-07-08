import { expect, test, describe } from 'bun:test';
import { applyPublish } from './PageContext';
import type { PageContext } from './PageContext';

// applyPublish is the pure reducer PageContextScope drives via useEffect — tested here without
// mounting React at all (this repo's webapp tests avoid a DOM/testing-library dependency; the
// pure logic is what actually needs covering).

const EMPTY = { current: null, activeKey: null };

const ctx = (viewId: PageContext['viewId']): PageContext => ({ viewId, title: viewId, entities: [] });

describe('applyPublish', () => {
  test('a fresh publish becomes the live context, keyed to its publisher', () => {
    const next = applyPublish(EMPTY, 'scope-1', ctx('fleet'));
    expect(next.current?.viewId).toBe('fleet');
    expect(next.activeKey).toBe('scope-1');
  });

  test('a later publish from a different scope wins outright (last-write-wins)', () => {
    const afterFirst = applyPublish(EMPTY, 'scope-1', ctx('fleet'));
    const afterSecond = applyPublish(afterFirst, 'scope-2', ctx('tasks'));
    expect(afterSecond.current?.viewId).toBe('tasks');
    expect(afterSecond.activeKey).toBe('scope-2');
  });

  test('the active scope retracting (unmount) clears the store', () => {
    const afterPublish = applyPublish(EMPTY, 'scope-1', ctx('graph'));
    const afterRetract = applyPublish(afterPublish, 'scope-1', null);
    expect(afterRetract).toEqual(EMPTY);
  });

  test('a STALE scope retracting must never clobber a fresher publish — the whole point of keying', () => {
    // scope-1 (an old view, e.g. Fleet) is mid-unmount while scope-2 (the new view, e.g. Tasks)
    // has already published. scope-1's cleanup fires after — it must be a no-op.
    const afterFirst = applyPublish(EMPTY, 'scope-1', ctx('fleet'));
    const afterSecond = applyPublish(afterFirst, 'scope-2', ctx('tasks'));
    const afterStaleRetract = applyPublish(afterSecond, 'scope-1', null);
    expect(afterStaleRetract).toEqual(afterSecond);
    expect(afterStaleRetract.current?.viewId).toBe('tasks');
  });

  test('retracting a key that was never active is a no-op', () => {
    const afterPublish = applyPublish(EMPTY, 'scope-1', ctx('capabilities'));
    const result = applyPublish(afterPublish, 'never-published', null);
    expect(result).toEqual(afterPublish);
  });
});
