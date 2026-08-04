import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

// `sanitizeHtml` sanitizes through DOMPurify, and DOMPurify's default export
// only becomes a working `.sanitize()` implementation when a browser-like
// `window`/`document` is present at import time (see WireframeBlock.tsx's
// `fallbackSanitize`, which exists precisely because DOMPurify throws
// otherwise). The rest of this package's suite deliberately runs with no DOM
// (see SettledMarkdown.test.tsx / OrgSettings.test.tsx), so install one just
// for this file's globals — via a real dynamic import, so `dompurify`'s
// module-level `createDOMPurify()` call runs after the globals exist — and
// remove them again in `afterAll` so no other test file inherits a DOM.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const domGlobals = {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  NodeFilter: dom.window.NodeFilter,
  HTMLElement: dom.window.HTMLElement,
  DocumentFragment: dom.window.DocumentFragment,
} as const;
Object.assign(globalThis, domGlobals);

const { sanitizeHtml, sanitizeStyle } = await import("./sanitize");

afterAll(() => {
  for (const key of Object.keys(domGlobals)) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

test("allowed tags, attributes, and svg content survive sanitization", () => {
  const html =
    '<div class="wf-card"><p>Hello <strong>world</strong></p>' +
    '<svg viewBox="0 0 24 24"><path d="M1 1 L2 2"/></svg></div>';
  const out = sanitizeHtml(html);

  expect(out).toContain("<strong>world</strong>");
  expect(out).toContain('class="wf-card"');
  expect(out).toContain("<svg");
  expect(out).toContain("<path");
});

test("script tags are stripped", () => {
  const out = sanitizeHtml('<div>safe</div><script>alert(1)</script>');

  expect(out).not.toContain("<script");
  expect(out).not.toContain("alert(1)");
  expect(out).toContain("safe");
});

test("style elements are stripped", () => {
  const out = sanitizeHtml('<div>safe</div><style>body{background:red}</style>');

  expect(out).not.toContain("<style");
  expect(out).not.toContain("background:red");
});

test("inline event-handler attributes are stripped", () => {
  const out = sanitizeHtml('<img src="x.png" onerror="alert(1)">');

  expect(out).not.toContain("onerror");
  expect(out).not.toContain("alert(1)");
});

test("javascript: URLs are neutralized", () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');

  expect(out).not.toContain("javascript:alert");
});

test("unsafe style declarations (url/expression/javascript) are scrubbed from style attributes", () => {
  const out = sanitizeHtml('<div style="color: red; background: url(javascript:alert(1))">x</div>');

  expect(out).not.toContain("url(javascript");
  expect(out).toContain("color: red");
});

test("sanitizeStyle strips unsafe declarations and keeps safe ones", () => {
  expect(sanitizeStyle("color: red; background: url(javascript:alert(1))")).toBe("color: red");
  expect(sanitizeStyle("width: expression(alert(1))")).toBe("");
  expect(sanitizeStyle("color: red; font-weight: 700")).toBe("color: red; font-weight: 700");
});
