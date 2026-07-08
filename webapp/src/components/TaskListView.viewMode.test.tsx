import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewModeToggle } from "./TaskListView";

// D4 (CANVAS-AND-PAGE-CHAT.md): the LIST|CANVAS segmented control. Kept pure (props-only, no
// TaskContext) so it SSR-renders standalone here without a TaskProvider/useSquad websocket stack —
// same "pull the context-free piece out for SSR-render coverage" pattern TaskProperties.test.tsx
// uses for CategoryChip. The stateful wiring (persistence, the real keyboard binding, CategoryCanvas
// mounting) is covered live via the scratch-daemon screenshot pass, not simulated clicks — this
// repo's webapp tests avoid a DOM/testing-library dependency (see PageContext.test.ts).

test("both segments render, LIST and CANVAS", () => {
  const html = renderToStaticMarkup(<ViewModeToggle mode="list" onChange={() => {}} />);
  expect(html).toContain(">List<");
  expect(html).toContain(">Canvas<");
});

test("LIST active: aria-pressed marks List true and Canvas false — never both", () => {
  const html = renderToStaticMarkup(<ViewModeToggle mode="list" onChange={() => {}} />);
  const listBtn = html.split(">List<")[0].split("<button").pop() ?? "";
  const canvasBtn = html.split(">Canvas<")[0].split("<button").pop() ?? "";
  expect(listBtn).toContain('aria-pressed="true"');
  expect(canvasBtn).toContain('aria-pressed="false"');
});

test("CANVAS active: aria-pressed flips — the toggle is a controlled, single-source-of-truth state", () => {
  const html = renderToStaticMarkup(<ViewModeToggle mode="canvas" onChange={() => {}} />);
  const listBtn = html.split(">List<")[0].split("<button").pop() ?? "";
  const canvasBtn = html.split(">Canvas<")[0].split("<button").pop() ?? "";
  expect(listBtn).toContain('aria-pressed="false"');
  expect(canvasBtn).toContain('aria-pressed="true"');
});

test("the control is a labeled group, not two floating buttons — a11y group semantics", () => {
  const html = renderToStaticMarkup(<ViewModeToggle mode="list" onChange={() => {}} />);
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-label="Task view"');
});
