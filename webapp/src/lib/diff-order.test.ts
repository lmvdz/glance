import { describe, expect, test } from 'bun:test';
import {
  classifyLayer,
  LAYER_CONFIG_SCHEMA,
  LAYER_LIB,
  LAYER_SERVER_MANAGER,
  LAYER_UI,
  orderDiffs,
  pathOrder,
  storyOrder,
} from './diff-order';
import type { AgentFileDiff } from '../components/chat/DiffReviewPanel';

function diff(file: string, text: string): AgentFileDiff {
  return { file, diff: text };
}

describe('classifyLayer', () => {
  test('config/schema: config dirs, schema dirs, migrations, json/yaml', () => {
    expect(classifyLayer('src/config.ts')).toBe(LAYER_CONFIG_SCHEMA);
    expect(classifyLayer('src/schema/http-body.ts')).toBe(LAYER_CONFIG_SCHEMA);
    expect(classifyLayer('migrations/0001_init.sql')).toBe(LAYER_CONFIG_SCHEMA);
    expect(classifyLayer('package.json')).toBe(LAYER_CONFIG_SCHEMA);
    expect(classifyLayer('config/app.yaml')).toBe(LAYER_CONFIG_SCHEMA);
  });

  test('UI: components/pages/views dirs and .tsx/.jsx files', () => {
    expect(classifyLayer('webapp/src/components/IntervenceView.tsx')).toBe(LAYER_UI);
    expect(classifyLayer('webapp/src/pages/Home.tsx')).toBe(LAYER_UI);
    expect(classifyLayer('src/views/Widget.jsx')).toBe(LAYER_UI);
  });

  test('server/manager: server.ts, squad-manager.ts, manager.ts, server/ dirs', () => {
    expect(classifyLayer('src/server.ts')).toBe(LAYER_SERVER_MANAGER);
    expect(classifyLayer('src/squad-manager.ts')).toBe(LAYER_SERVER_MANAGER);
    expect(classifyLayer('src/server/routes.ts')).toBe(LAYER_SERVER_MANAGER);
  });

  test('lib: /lib/ directories', () => {
    expect(classifyLayer('webapp/src/lib/attention.ts')).toBe(LAYER_LIB);
    expect(classifyLayer('src/lib/util.ts')).toBe(LAYER_LIB);
  });

  test('unmatched bare modules default to LAYER_LIB, never server/manager or UI by accident', () => {
    expect(classifyLayer('src/attention.ts')).toBe(LAYER_LIB);
    expect(classifyLayer('src/comprehension-fog.ts')).toBe(LAYER_LIB);
  });
});

describe('pathOrder', () => {
  test('sorts lexically by file path', () => {
    const diffs = [diff('b.ts', ''), diff('a.ts', ''), diff('c.ts', '')];
    expect(pathOrder(diffs).map((d) => d.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  test('does not mutate the input array', () => {
    const diffs = [diff('b.ts', ''), diff('a.ts', '')];
    const copy = [...diffs];
    pathOrder(diffs);
    expect(diffs).toEqual(copy);
  });
});

describe('storyOrder: definition-before-use property', () => {
  test('a file defining a symbol orders before a file that uses it (same layer, no other signal)', () => {
    const helper = diff('src/helper.ts', 'export function helperFn() {\n  return 1;\n}');
    const consumer = diff('src/consumer.ts', "import { helperFn } from './helper';\nconst x = helperFn();");
    const unrelated = diff('src/unrelated.ts', 'const y = 2;');
    // Deliberately scrambled input order — helper is defined LAST in the array.
    const ordered = storyOrder([consumer, unrelated, helper]);
    expect(ordered.map((d) => d.file)).toContain('src/helper.ts');
    const idxHelper = ordered.findIndex((d) => d.file === 'src/helper.ts');
    const idxConsumer = ordered.findIndex((d) => d.file === 'src/consumer.ts');
    expect(idxHelper).toBeLessThan(idxConsumer);
  });

  test('a chain of three files orders definer-before-user transitively', () => {
    const a = diff('src/a.ts', 'export function fromA() { return 1; }');
    const b = diff('src/b.ts', "import { fromA } from './a';\nexport function fromB() { return fromA() + 1; }");
    const c = diff('src/c.ts', "import { fromB } from './b';\nconst z = fromB();");
    const ordered = storyOrder([c, a, b]); // scrambled
    const idx = (f: string) => ordered.findIndex((d) => d.file === f);
    expect(idx('src/a.ts')).toBeLessThan(idx('src/b.ts'));
    expect(idx('src/b.ts')).toBeLessThan(idx('src/c.ts'));
  });

  test('every input file appears exactly once in the output', () => {
    const files = [diff('src/a.ts', 'const x = 1;'), diff('src/b.ts', 'const y = 2;'), diff('src/c.ts', 'const z = 3;')];
    const ordered = storyOrder(files);
    expect(ordered.map((d) => d.file).sort()).toEqual(files.map((d) => d.file).sort());
  });
});

describe('storyOrder: layer precedence', () => {
  test('files with zero symbol relationship are still ordered config/schema -> lib -> server/manager -> UI', () => {
    const ui = diff('webapp/src/components/Widget.tsx', 'const widget = 1;');
    const server = diff('src/server.ts', 'const s = 1;');
    const lib = diff('src/lib/util.ts', 'const u = 1;');
    const config = diff('src/config.ts', 'const c = 1;');
    // Deliberately reverse-layer input order.
    const ordered = storyOrder([ui, server, lib, config]);
    expect(ordered.map((d) => d.file)).toEqual(['src/config.ts', 'src/lib/util.ts', 'src/server.ts', 'webapp/src/components/Widget.tsx']);
  });

  test('layer precedence trumps a cross-layer definition — a UI file defining a symbol never pulls an earlier-layer user out of place', () => {
    // The UI file "defines" fromUi; the lib file "uses" it. Despite that def-before-use signal,
    // cross-layer edges are never considered — lib still comes before UI, layer wins.
    const ui = diff('webapp/src/components/Widget.tsx', 'export function fromUi() { return 1; }');
    const lib = diff('src/lib/util.ts', 'const x = fromUi();');
    const ordered = storyOrder([ui, lib]);
    expect(ordered.map((d) => d.file)).toEqual(['src/lib/util.ts', 'webapp/src/components/Widget.tsx']);
  });
});

describe('storyOrder: cycle fallback', () => {
  test('a mutual dependency (a cycle) falls back to the original input order, unchanged', () => {
    // a.ts defines foo, uses bar; b.ts defines bar, uses foo — a same-layer 2-cycle.
    const a = diff('src/a.ts', 'export function foo() { return bar(); }');
    const b = diff('src/b.ts', 'export function bar() { return foo(); }');
    const input = [b, a]; // deliberately b-before-a
    const ordered = storyOrder(input);
    expect(ordered.map((d) => d.file)).toEqual(['src/b.ts', 'src/a.ts']);
  });

  test('a 3-cycle also falls back to input order for the whole group', () => {
    const a = diff('src/a.ts', 'export function A() { return B(); }');
    const b = diff('src/b.ts', 'export function B() { return C(); }');
    const c = diff('src/c.ts', 'export function C() { return A(); }');
    const input = [c, b, a];
    expect(storyOrder(input).map((d) => d.file)).toEqual(['src/c.ts', 'src/b.ts', 'src/a.ts']);
  });
});

describe('storyOrder: trivial and edge inputs', () => {
  test('0 or 1 files pass through unchanged', () => {
    expect(storyOrder([])).toEqual([]);
    const single = [diff('a.ts', 'const x = 1;')];
    expect(storyOrder(single)).toEqual(single);
  });

  test('does not mutate the input array', () => {
    const diffs = [diff('b.ts', 'const y = 1;'), diff('a.ts', 'const x = 1;')];
    const copy = [...diffs];
    storyOrder(diffs);
    expect(diffs).toEqual(copy);
  });

  test('a file with no diff text (undefined) is still ordered without throwing', () => {
    expect(() => storyOrder([{ file: 'a.ts' }, { file: 'b.ts', diff: 'const x = 1;' }])).not.toThrow();
  });
});

describe('orderDiffs: mode dispatch', () => {
  test("'path' mode is a lexical sort regardless of content", () => {
    const diffs = [diff('z.ts', 'export function z1() {}'), diff('a.ts', 'z1();')];
    expect(orderDiffs(diffs, 'path').map((d) => d.file)).toEqual(['a.ts', 'z.ts']);
  });

  test("'story' mode applies the definition-before-use + layer ordering", () => {
    const helper = diff('src/lib/helper.ts', 'export function helperFn() { return 1; }');
    const consumer = diff('src/lib/consumer.ts', 'const x = helperFn();');
    const ordered = orderDiffs([consumer, helper], 'story');
    expect(ordered.map((d) => d.file)).toEqual(['src/lib/helper.ts', 'src/lib/consumer.ts']);
  });
});
