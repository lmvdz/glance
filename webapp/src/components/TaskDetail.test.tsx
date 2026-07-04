import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { adjacentPlanPath, fullTimelineStale, isOverviewDoc, LifecycleTimeline, planDocKind, PlanMarkdown, PlanMarkdownLoading, resetPlanScroll, safePlanIndex, StatusPill } from "./TaskDetail";
import { BLOCK_REGISTRY, parseMeta } from "./PlanBlocks";
import type { TransitionEntry } from "../lib/dto";

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

test("PlanMarkdown keeps normal code fences on the (lazy) syntax highlighter path", () => {
  const html = renderToStaticMarkup(<PlanMarkdown content={"```ts\nconst ok = true;\n```"} />);

  // Prism loads lazily (it was ~500KB of the main bundle) — a static render shows the
  // plain <pre> fallback with the code intact; highlighting hydrates on the client.
  expect(html).toContain("const ok = true;");
  expect(html).toContain("font-mono");
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

test("StatusPill renders the status text with a status-colored badge", () => {
  const html = renderToStaticMarkup(<StatusPill status="error" />);

  expect(html).toContain(">error<");
  expect(html).toContain("border-red-200");
});

function transition(from: TransitionEntry["from"], to: TransitionEntry["to"], extra: Partial<TransitionEntry> = {}): TransitionEntry {
  return { agentId: "a1", from, to, reason: "restart", at: 1000, ...extra };
}

test("LifecycleTimeline renders nothing when the agent DTO predates the transitions field", () => {
  const html = renderToStaticMarkup(
    <LifecycleTimeline agent={{ id: "a1" }} isOpen={false} onToggle={() => {}} onLoadFull={() => {}} />,
  );

  expect(html).toBe("");
});

// #lifecycle-truth webapp audit finding 2: an empty tail on a DTO that DOES support the
// `transitions` field (freshly reattached/restored agent, capped tail not yet populated) must still
// render the strip chrome — hiding it also hid the only path (Load full history) to the durable
// history that actually exists in transitions.jsonl.
test("LifecycleTimeline still renders the strip chrome with a placeholder when the tail is empty but supported", () => {
  const collapsedHtml = renderToStaticMarkup(
    <LifecycleTimeline agent={{ id: "a1", transitions: [] }} isOpen={false} onToggle={() => {}} onLoadFull={() => {}} />,
  );
  expect(collapsedHtml).toContain("Lifecycle");
  expect(collapsedHtml).toContain(">0<");

  const openHtml = renderToStaticMarkup(
    <LifecycleTimeline agent={{ id: "a1", transitions: [] }} isOpen onToggle={() => {}} onLoadFull={() => {}} />,
  );
  expect(openHtml).toContain("No recent transitions");
  expect(openHtml).toContain("Load full history");
});

test("LifecycleTimeline shows a collapsed toggle with a count when transitions exist", () => {
  const agent = { id: "a1", transitions: [transition("idle", "working")] };
  const html = renderToStaticMarkup(<LifecycleTimeline agent={agent} isOpen={false} onToggle={() => {}} onLoadFull={() => {}} />);

  expect(html).toContain("Lifecycle");
  expect(html).toContain(">1<");
  expect(html).not.toContain("Load full history");
});

test("LifecycleTimeline expands entries with cause/denied detail when open", () => {
  const agent = {
    id: "a1",
    transitions: [
      transition("working", "error", { reason: "fail", cause: { error: "boom" } }),
      transition("idle", "input", { denied: true }),
    ],
  };
  const html = renderToStaticMarkup(<LifecycleTimeline agent={agent} isOpen onToggle={() => {}} onLoadFull={() => {}} />);

  expect(html).toContain("boom");
  expect(html).toContain(">denied<");
  expect(html).toContain("Load full history");
});

test("LifecycleTimeline prefers fullEntries over the capped tail and hides the load button once loaded", () => {
  const agent = { id: "a1", transitions: [transition("idle", "working")] };
  const fullEntries = [transition("starting", "idle"), transition("idle", "working"), transition("working", "input")];
  const html = renderToStaticMarkup(
    <LifecycleTimeline agent={agent} isOpen fullEntries={fullEntries} onToggle={() => {}} onLoadFull={() => {}} />,
  );

  // count badge still reflects the capped tail length (unaffected by fullEntries)
  expect(html).toContain(">1<");
  expect(html).not.toContain("Load full history");
  expect((html.match(/font-mono/g) ?? []).length).toBe(3);
});

// #lifecycle-truth webapp audit finding 1: fullTimelines was populated once by "Load full history"
// and never invalidated, so a live transition landing after that click silently vanished from the
// strip until a full remount. fullTimelineStale() is the pure predicate TaskDetail's invalidation
// effect uses to evict the stale cache entry.
describe("fullTimelineStale", () => {
  test("is false when the live tail has no entry newer than the cached fetch", () => {
    const cachedAsOf = 2000;
    const liveTail = [transition("idle", "working", { at: 1000 }), transition("working", "idle", { at: 2000 })];
    expect(fullTimelineStale(cachedAsOf, liveTail)).toBe(false);
  });

  test("is true once a live transition lands after the cached fetch's newest entry", () => {
    const cachedAsOf = 2000;
    const liveTail = [transition("working", "idle", { at: 2000 }), transition("idle", "error", { at: 3000, reason: "fail" })];
    expect(fullTimelineStale(cachedAsOf, liveTail)).toBe(true);
  });

  test("is false for an undefined or empty live tail (nothing new to invalidate against)", () => {
    expect(fullTimelineStale(2000, undefined)).toBe(false);
    expect(fullTimelineStale(2000, [])).toBe(false);
  });
});
