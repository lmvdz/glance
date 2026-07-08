import { expect, test, describe } from "bun:test";
import { reconcileSelectedTaskId, initialTasksListMode, TASKS_VIEW_STORAGE_KEY } from "./TaskContext";

test("reconcileSelectedTaskId does not auto-select a task on reload", () => {
  expect(reconcileSelectedTaskId(null, [{ id: "task-1" }])).toBeNull();
});

test("reconcileSelectedTaskId keeps valid selections and clears stale ones", () => {
  const tasks = [{ id: "task-1" }, { id: "task-2" }];

  expect(reconcileSelectedTaskId("task-2", tasks)).toBe("task-2");
  expect(reconcileSelectedTaskId("missing", tasks)).toBeNull();
});

// D4/D8 (CANVAS-AND-PAGE-CHAT.md): the LIST|CANVAS toggle persists to
// localStorage['omp.tasks.view'] mirroring 'omp.workbench.collapsed', DEFAULT LIST — canvas is
// opt-in, a red-team guard against a prettier-but-slower default. `initialTasksListMode` is the one
// place that rule lives, mirrored on the same pure-function pattern as ThemeContext's
// `initialTheme` (pure logic tested without mounting React/localStorage).
describe("initialTasksListMode (D4 persisted view mode, D8 default-LIST guard)", () => {
  test("no persisted value → LIST, the documented default", () => {
    expect(initialTasksListMode(null)).toBe("list");
  });

  test("a persisted 'canvas' choice round-trips", () => {
    expect(initialTasksListMode("canvas")).toBe("canvas");
  });

  test("an explicit persisted 'list' stays list", () => {
    expect(initialTasksListMode("list")).toBe("list");
  });

  test("garbage/stale persisted values fall back to LIST, never silently become 'canvas'", () => {
    expect(initialTasksListMode("")).toBe("list");
    expect(initialTasksListMode("CANVAS")).toBe("list"); // not an exact match
    expect(initialTasksListMode("grid")).toBe("list"); // a stale/foreign value from some other feature
  });

  test("the persisted key matches the documented convention", () => {
    expect(TASKS_VIEW_STORAGE_KEY).toBe("omp.tasks.view");
  });
});
