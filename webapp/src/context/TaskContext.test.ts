import { expect, test } from "bun:test";
import { reconcileSelectedTaskId } from "./TaskContext";

test("reconcileSelectedTaskId does not auto-select a task on reload", () => {
  expect(reconcileSelectedTaskId(null, [{ id: "task-1" }])).toBeNull();
});

test("reconcileSelectedTaskId keeps valid selections and clears stale ones", () => {
  const tasks = [{ id: "task-1" }, { id: "task-2" }];

  expect(reconcileSelectedTaskId("task-2", tasks)).toBe("task-2");
  expect(reconcileSelectedTaskId("missing", tasks)).toBeNull();
});
