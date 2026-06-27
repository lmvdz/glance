import { afterEach, expect, test } from "bun:test";
import { focusTaskSearch, TASK_SEARCH_INPUT_ID } from "./jump";

// The webapp test env has no DOM (component tests use react-dom/server). Stub a minimal
// `document` so the helper's lookup/focus logic is exercised without a full DOM.
const origDoc = (globalThis as { document?: unknown }).document;
afterEach(() => {
  (globalThis as { document?: unknown }).document = origDoc;
});

test("focusTaskSearch focuses + selects the task-search input when it's mounted", () => {
  let focused = false;
  let selected = false;
  const el = { focus: () => { focused = true; }, select: () => { selected = true; } };
  (globalThis as { document?: unknown }).document = {
    getElementById: (id: string) => (id === TASK_SEARCH_INPUT_ID ? el : null),
  };
  expect(focusTaskSearch()).toBe(true);
  expect(focused).toBe(true);
  expect(selected).toBe(true);
});

test("focusTaskSearch no-ops gracefully (returns false) when the input isn't in the DOM", () => {
  (globalThis as { document?: unknown }).document = { getElementById: () => null };
  expect(focusTaskSearch()).toBe(false);
});

test("focusTaskSearch returns false when there's no document at all (SSR/no-DOM)", () => {
  (globalThis as { document?: unknown }).document = undefined;
  expect(focusTaskSearch()).toBe(false);
});
