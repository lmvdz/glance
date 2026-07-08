import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryCanvasView } from "./CategoryCanvas";
import type { Task } from "../types";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    category: overrides.category ?? "frontend",
    duration: "1a",
    status: overrides.status ?? "active",
    description: "",
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    contextBundle: { spec: "plans/x", criteria: "", prerequisites: "", decisions: "", downstream: "" },
    decisions: [],
    relationships: [],
    properties: { status: "In Progress", priority: null, assignee: null, project: { id: "p", name: "p", shortCode: "P", colorClass: "" }, estimate: null },
    tags: overrides.tags ?? [],
    proofProvenance: { source: { type: "manual", label: "manual" }, worktrees: [], candidates: [] },
    ...overrides,
  };
}

const noop = () => {};

test("idle: renders all canonical categories, including empty ones (dimmed via reduced opacity)", () => {
  const tasks = [task({ id: "a", category: "frontend" }), task({ id: "b", category: "backend" })];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={tasks} selectedCategoryId={null} onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("Frontend");
  expect(html).toContain("Backend");
  expect(html).toContain("Database"); // present with zero tasks — still rendered, per D6
  expect(html).toContain("select a category to see its plans");
});

test("idle: a category with concentrated needs-you work renders an ember indicator dot", () => {
  const tasks = [
    task({ id: "a", category: "database", tags: ["blocked"] }),
    task({ id: "b", category: "database", tags: ["input"] }),
    task({ id: "c", category: "frontend" }),
  ];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={tasks} selectedCategoryId={null} onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  // aria-label carries the needs-you count for the concentrated category
  expect(html).toContain("Database: 2 open, 2 needs you");
  expect(html).toContain("Frontend: 1 open");
  expect(html).not.toContain("Frontend: 1 open, ");
});

test("selected: breadcrumb appears, siblings recede (aria-current on the selected node only)", () => {
  const tasks = [task({ id: "a", category: "backend", title: "Ship the API" }), task({ id: "b", category: "frontend" })];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={tasks} selectedCategoryId="backend" onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("All categories");
  expect(html).toContain('aria-current="true"');
  expect(html).toContain("Ship the API"); // satellite chip rendered
});

test("selected category with no plans yet shows its own calm sub-empty-state, not the ring's", () => {
  const tasks = [task({ id: "a", category: "frontend" })];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={tasks} selectedCategoryId="devops" onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("No plans yet in DevOps.");
});

test("dense: more than 24 plans in the selected category renders the +N more overflow chip", () => {
  const many = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, category: "frontend", title: `Task ${i}` }));
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={many} selectedCategoryId="frontend" onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("+7 more");
});

test("zero open across every category renders the calm one-liner instead of a dimmed ring", () => {
  const doneOnly = [task({ id: "a", category: "frontend", status: "done" })];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={doneOnly} selectedCategoryId={null} onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("Nothing open, in any category.");
  expect(html).not.toContain('data-testid="category-canvas"');
});

test("empty tasks array (nothing at all) also renders the calm empty state, not a crash", () => {
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={[]} selectedCategoryId={null} onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("Nothing open, in any category.");
});

test("two non-empty categories: both render (D6 centered pair) without crashing on the angle math", () => {
  const tasks = [task({ id: "a", category: "frontend" }), task({ id: "b", category: "backend" })];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={tasks} selectedCategoryId={null} onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("Frontend");
  expect(html).toContain("Backend");
});

test("satellite chips carry a StatusChip for needs-you plans", () => {
  const tasks = [task({ id: "a", category: "backend", title: "Blocked thing", tags: ["blocked"] })];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={tasks} selectedCategoryId="backend" onSelectCategory={noop} onSelectTask={noop} onBack={noop} />,
  );
  expect(html).toContain("NEEDS YOU");
});

test("reducedMotion=true renders with no CSS transition/animation declarations on nodes", () => {
  const tasks = [task({ id: "a", category: "backend", title: "Ship it" })];
  const html = renderToStaticMarkup(
    <CategoryCanvasView tasks={tasks} selectedCategoryId="backend" onSelectCategory={noop} onSelectTask={noop} onBack={noop} reducedMotion />,
  );
  expect(html).not.toContain("cubic-bezier");
});
