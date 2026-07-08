import { afterEach, expect, test } from "bun:test";
import { focusTaskSearch, jumpToTaskSearch, TASK_SEARCH_INPUT_ID } from "./jump";
import type { AppView } from "../context/TaskContext";

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

// jumpToTaskSearch is the ⌘K/Ctrl+K handler's decision logic. The search box now only
// mounts on the Tasks view (WorkbenchPane's isTaskScopedView), so this preserves the
// "works from anywhere" keybinding contract by switching views first when needed.
test("jumpToTaskSearch focuses immediately when already on the Tasks view", () => {
  let focusCalls = 0;
  let scheduleCalls = 0;
  let setViewCalls: AppView[] = [];
  jumpToTaskSearch(
    "tasks",
    (v) => setViewCalls.push(v),
    () => { focusCalls += 1; return true; },
    () => { scheduleCalls += 1; },
  );
  expect(focusCalls).toBe(1);
  expect(scheduleCalls).toBe(0);
  expect(setViewCalls).toEqual([]);
});

test("jumpToTaskSearch switches to the Tasks view first, then focuses on the next scheduled tick, from any other view", () => {
  const nonTaskViews: AppView[] = ["attention", "active", "cockpit", "review", "automation"];
  for (const view of nonTaskViews) {
    let setViewCalls: AppView[] = [];
    let scheduledFn: (() => void) | undefined;
    let focusCalls = 0;
    jumpToTaskSearch(
      view,
      (v) => setViewCalls.push(v),
      () => { focusCalls += 1; return true; },
      (fn) => { scheduledFn = fn; },
    );
    // View switch happens synchronously; focus is deferred to the scheduled tick, not
    // called immediately — the input isn't in the DOM until that render lands.
    expect(setViewCalls).toEqual(["tasks"]);
    expect(focusCalls).toBe(0);
    expect(typeof scheduledFn).toBe("function");
    scheduledFn!();
    expect(focusCalls).toBe(1);
  }
});

test("jumpToTaskSearch defaults to a real focus + a real scheduler when not overridden (smoke)", () => {
  (globalThis as { document?: unknown }).document = { getElementById: () => null };
  // Called with only the required args — should not throw, and (since there's no
  // requestAnimationFrame/DOM in this test env) falls back to setTimeout.
  expect(() => jumpToTaskSearch("attention", () => {})).not.toThrow();
});
