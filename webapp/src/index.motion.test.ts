import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Taste-review nit 2: the ⌘K palette's entrance (`.palette-rise`) must (a) only animate
// GPU-cheap properties (opacity/transform, never layout-triggering props like top/width), and
// (b) be fully neutralized under prefers-reduced-motion, per brand.md's Motion section ("always
// prefers-reduced-motion-safe"). These are source invariants worth locking down directly since
// there's no DOM/CSSOM render harness in this repo to exercise them at runtime.
const css = readFileSync(join(import.meta.dir, 'index.css'), 'utf8');

test('the palette-rise keyframe exists and only touches opacity/transform', () => {
  const match = css.match(/@keyframes palette-rise\s*{([\s\S]*?)\n}/);
  expect(match).not.toBeNull();
  const body = match![1];
  expect(body).toContain('opacity');
  expect(body).toContain('transform');
  // No other CSS properties inside the keyframe body (a colon precedes any property name).
  const declaredProps = [...body.matchAll(/(\w[\w-]*)\s*:/g)].map((m) => m[1]);
  for (const prop of declaredProps) {
    expect(['opacity', 'transform']).toContain(prop);
  }
});

test('.palette-rise is a ~150ms entrance using the brand micro-interaction easing', () => {
  const match = css.match(/\.palette-rise\s*{([\s\S]*?)}/);
  expect(match).not.toBeNull();
  expect(match![1]).toContain('150ms');
  expect(match![1]).toContain('cubic-bezier(0.22, 1, 0.36, 1)');
});

test('.palette-rise is neutralized under prefers-reduced-motion, alongside the other entrances', () => {
  const match = css.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?)}\s*}/);
  expect(match).not.toBeNull();
  const block = match![1];
  expect(block).toContain('.palette-rise');
  expect(block).toContain('animation: none');
});
