import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { adjacentPlanPath, isOverviewDoc, planDocKind, PlanMarkdown, PlanMarkdownLoading, resetPlanScroll, safePlanIndex } from "./TaskDetail";
import { BLOCK_REGISTRY, parseMeta } from "./PlanBlocks";

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

test("parseMeta reads key values and quoted values", () => {
  expect(parseMeta('tone=decision id=\"source of truth\" bare surface=browser')).toEqual({
    tone: "decision",
    id: "source of truth",
    surface: "browser",
  });
});

test("PlanMarkdown dispatches registered visual plan blocks", () => {
  const html = renderToStaticMarkup(<PlanMarkdown content={"```callout tone=decision id=source-of-truth\nUse the event journal.\n```"} />);

  expect(html).toContain('data-block-id="source-of-truth"');
  expect(html).toContain("DECISION"); // the callout tone label — a real block, not a code fence
  expect(html).toContain("Use the event journal.");
});

test("PlanMarkdown keeps normal code fences on the syntax highlighter path", () => {
  const html = renderToStaticMarkup(<PlanMarkdown content={"```ts\nconst ok = true;\n```"} />);

  expect(html).toContain("language-ts");
  expect(html).toContain("const");
  expect(BLOCK_REGISTRY.ts).toBeUndefined();
});

test("PlanMarkdown renders every fixture block through a real block component", () => {
  const fixture = readFileSync(new URL("./blocks/__fixtures__/example-plan.md", import.meta.url), "utf8");
  const html = renderToStaticMarkup(<PlanMarkdown content={fixture} />);

  // Blocks are implemented now — nothing may fall back to the old placeholder stubs,
  // and each fixture block must mount as a dispatched block host.
  expect(html).not.toContain("stub]");
  expect((html.match(/data-block-id=/g) ?? []).length).toBeGreaterThanOrEqual(7);
});

test("PlanMarkdownLoading visibly reports that plan documents are loading", () => {
  const html = renderToStaticMarkup(<PlanMarkdownLoading />);

  expect(html).toContain('role="status"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Loading plan documents");
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
