import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettledMarkdown } from "./SettledMarkdown";

const MERMAID_FENCE = "```mermaid\ngraph TD;\nA-->B;\n```";

test("a mermaid fence in the streaming tail renders as plain code, not a diagram", () => {
  // No trailing blank line after the fence, so the whole thing sits in the
  // unsettled tail per findSettledBoundary — the settled prefix is empty.
  const html = renderToStaticMarkup(
    <SettledMarkdown text={MERMAID_FENCE} status="running" />,
  );

  expect(html).toContain(">mermaid</span>"); // CodeBlock's language label
  expect(html).not.toContain('data-block-id');
});

test("a mermaid fence in the settled prefix renders as a diagram block", () => {
  const text = `${MERMAID_FENCE}\n\nmore text\n\nfinal tail`;
  const html = renderToStaticMarkup(<SettledMarkdown text={text} status="running" />);

  expect(html).toContain('data-block-id');
  expect(html).not.toContain("<pre");
});

test("a mermaid fence in a completed entry renders as a diagram block", () => {
  const html = renderToStaticMarkup(<SettledMarkdown text={MERMAID_FENCE} status="ok" />);

  expect(html).toContain('data-block-id');
  expect(html).not.toContain("<pre");
});

test("a questions fence in chat renders as plain code, not the questions form", () => {
  const text = '```questions\n{"questions":[{"id":"q1","prompt":"Pick one","options":["a","b"]}]}\n```';
  const html = renderToStaticMarkup(<SettledMarkdown text={text} status="ok" />);

  expect(html).toContain(">questions</span>"); // CodeBlock's language label
  expect(html).not.toContain('data-block-id');
});

test("block-level code in chat does not nest a div inside a pre", () => {
  const html = renderToStaticMarkup(
    <SettledMarkdown text={"```ts\nconst ok = true;\n```"} status="ok" />,
  );

  // ChatPre unwraps CodeBlock's own `<div>` chrome instead of re-wrapping it in
  // a `<pre>`, so the invalid `<pre><div>` nesting never appears.
  expect(html).not.toContain("<pre><div");
  expect(html.trimStart().startsWith("<div")).toBe(true);
});

test("a javascript: link inside a chat callout body stays inert", () => {
  const text = '```callout tone=decision id=chat-link\n[click me](javascript:alert(1))\n```';
  const html = renderToStaticMarkup(<SettledMarkdown text={text} status="ok" />);

  expect(html).toContain('data-block-id="chat-link"');
  expect(html).not.toContain("javascript:alert");
});

test("a wireframe fence in chat sanitizes hostile HTML in the fence body", () => {
  // Now that chat makes fence bodies agent-reachable, a wireframe body is
  // untrusted the same way a callout/columns body is. `WireframeBlock`
  // sanitizes through `lib/sanitize`; this pins that the hostile parts never
  // reach rendered output, regardless of which sanitizer path runs them.
  const text =
    '```wireframe id=wf-hostile\n' +
    '<div class="wf-card">Hello<script>alert(1)</script>' +
    '<img src="x.png" onerror="alert(1)">' +
    '<a href="javascript:alert(1)">click</a></div>\n' +
    '```';
  const html = renderToStaticMarkup(<SettledMarkdown text={text} status="ok" />);

  expect(html).toContain('data-block-id="wf-hostile"');
  expect(html).toContain("Hello");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("alert(1)");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("javascript:alert");
});

test("the settled prefix is decoupled from tail-only changes across WS frames", () => {
  // No jsdom in this suite (see OrgSettings.test.tsx), so we assert the
  // precondition for React.memo to skip work in a real mounted tree: the
  // settled-prefix output is byte-identical across frames that only change
  // the unsettled tail, which is what `MemoSettled` relies on to avoid
  // remounting per WS frame.
  const settledPrefix = "settled paragraph one\n\nsettled paragraph two\n\n";
  const htmlA = renderToStaticMarkup(<SettledMarkdown text={`${settledPrefix}tail one`} status="running" />);
  const htmlB = renderToStaticMarkup(<SettledMarkdown text={`${settledPrefix}tail two`} status="running" />);
  const settledHtmlA = htmlA.split("tail")[0];
  const settledHtmlB = htmlB.split("tail")[0];
  expect(settledHtmlA).toBe(settledHtmlB);
});
