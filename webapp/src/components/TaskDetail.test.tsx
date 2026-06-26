import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { adjacentPlanPath, isOverviewDoc, planDocKind, PlanMarkdown, resetPlanScroll, safePlanIndex } from "./TaskDetail";

test("PlanMarkdown renders plan markdown with prose/table styling", () => {
  const html = renderToStaticMarkup(<PlanMarkdown content={"# Overview\n\n| A | B |\n| - | - |\n| 1 | 2 |"} />);

  expect(html).toContain('class="prose prose-sm');
  expect(html).toContain("prose-table:text-sm");
  expect(html).toContain("<h1>Overview</h1>");
  expect(html).toContain("<table>");
});

test("PlanMarkdown uses a light code-block background outside dark mode", () => {
  const html = renderToStaticMarkup(<PlanMarkdown content={"```ts\nconst ok = true;\n```"} />);

  expect(html).toContain("prose-pre:bg-gray-50");
  expect(html).toContain("dark:prose-pre:bg-gray-950");
  expect(html).not.toContain(" prose-pre:bg-gray-950 ");
});

test("isOverviewDoc only accepts 00-overview.md", () => {
  expect(isOverviewDoc("00-overview.md")).toBe(true);
  expect(isOverviewDoc("overview.md")).toBe(false);
  expect(isOverviewDoc("DESIGN.md")).toBe(false);
});

test("planDocKind labels overview, concern, and supporting docs", () => {
  expect(planDocKind("00-overview.md", false)).toBe("overview");
  expect(planDocKind("01-api.md", true)).toBe("concern");
  expect(planDocKind("DESIGN.md", false)).toBe("doc");
});

test("safePlanIndex falls back instead of returning an out-of-range document index", () => {
  const docs = [{ path: "00-overview.md" }, { path: "01-api.md" }, { path: "02-ui.md" }];

  expect(safePlanIndex(docs, "01-api.md")).toBe(1);
  expect(safePlanIndex(docs, "stale-document.md")).toBe(0);
  expect(safePlanIndex([], "00-overview.md")).toBe(-1);
});

test("adjacentPlanPath clamps prev/next at document boundaries", () => {
  const docs = [{ path: "00-overview.md" }, { path: "01-api.md" }, { path: "02-ui.md" }];

  expect(adjacentPlanPath(docs, "01-api.md", 1)).toBe("02-ui.md");
  expect(adjacentPlanPath(docs, "02-ui.md", 1)).toBeNull();
  expect(adjacentPlanPath(docs, "00-overview.md", -1)).toBeNull();
  expect(adjacentPlanPath(docs, "stale-document.md", 1)).toBe("01-api.md");
});

test("resetPlanScroll uses scrollTop instead of browser-specific scrollTo overloads", () => {
  const pane = { scrollTop: 42 };

  resetPlanScroll(pane);

  expect(pane.scrollTop).toBe(0);
  expect(() => resetPlanScroll(null)).not.toThrow();
});
