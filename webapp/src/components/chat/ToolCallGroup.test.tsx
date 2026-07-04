import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCallGroup, ToolCallRow, groupToolRuns } from "./ToolCallGroup";
import type { TranscriptEntry } from "../../lib/dto";

const toolEntry = (overrides: Partial<TranscriptEntry> & { id: string }): TranscriptEntry => ({
  kind: "tool",
  text: `▸ bash: ${overrides.id}`,
  ts: 1,
  status: "ok",
  tool: { callId: overrides.id, name: "bash", argsText: JSON.stringify({ command: `echo ${overrides.id}` }) },
  ...overrides,
});

test("groupToolRuns passes a singleton tool entry through unchanged", () => {
  const entries: TranscriptEntry[] = [toolEntry({ id: "t1" })];
  const items = groupToolRuns(entries);
  expect(items).toEqual([{ type: "entry", entry: entries[0] }]);
});

test("groupToolRuns groups a run of consecutive tool entries", () => {
  const entries: TranscriptEntry[] = [toolEntry({ id: "t1" }), toolEntry({ id: "t2" }), toolEntry({ id: "t3" })];
  const items = groupToolRuns(entries);
  expect(items).toEqual([{ type: "group", entries }]);
});

test("groupToolRuns splits runs around non-tool entries and keeps entry identity", () => {
  const t1 = toolEntry({ id: "t1" });
  const t2 = toolEntry({ id: "t2" });
  const user: TranscriptEntry = { kind: "user", text: "go", ts: 2, status: "ok" };
  const t3 = toolEntry({ id: "t3" });
  const items = groupToolRuns([t1, t2, user, t3]);
  expect(items).toEqual([
    { type: "group", entries: [t1, t2] },
    { type: "entry", entry: user },
    { type: "entry", entry: t3 },
  ]);
  // Same object references, not clones — memoization upstream depends on this.
  expect((items[0] as { entries: TranscriptEntry[] }).entries[0]).toBe(t1);
});

test("groupToolRuns treats stage-marker dividers as run breaks, not groupable tool calls", () => {
  const t1 = toolEntry({ id: "t1" });
  const stage: TranscriptEntry = { kind: "tool", text: "▸ stage: implement", ts: 2, status: "ok", format: "stage" };
  const t2 = toolEntry({ id: "t2" });
  const items = groupToolRuns([t1, stage, t2]);
  expect(items).toEqual([
    { type: "entry", entry: t1 },
    { type: "entry", entry: stage },
    { type: "entry", entry: t2 },
  ]);
});

test("groupToolRuns handles an entirely empty or non-tool list", () => {
  expect(groupToolRuns([])).toEqual([]);
  const user: TranscriptEntry = { kind: "user", text: "hi", ts: 1, status: "ok" };
  expect(groupToolRuns([user])).toEqual([{ type: "entry", entry: user }]);
});

test("ToolCallGroup collapses to the latest call plus an N-previous-steps toggle", () => {
  const entries: TranscriptEntry[] = [
    toolEntry({ id: "t1" }),
    toolEntry({ id: "t2" }),
    toolEntry({ id: "t3" }),
  ];
  const html = renderToStaticMarkup(<ToolCallGroup entries={entries} />);
  expect(html).toContain("2 previous steps");
  expect(html).toContain("echo t3"); // latest call's command is visible
  expect(html).not.toContain("echo t1"); // older calls are collapsed away
  expect(html).not.toContain("echo t2");
  expect(html).toContain('role="button"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('tabindex="0"');
});

test("ToolCallGroup with a single previous step uses singular phrasing", () => {
  const entries: TranscriptEntry[] = [toolEntry({ id: "t1" }), toolEntry({ id: "t2" })];
  const html = renderToStaticMarkup(<ToolCallGroup entries={entries} />);
  expect(html).toContain("1 previous step");
  expect(html).not.toContain("1 previous steps");
});

test("ToolCallGroup auto-expands when the run contains a running entry, showing every call", () => {
  const entries: TranscriptEntry[] = [
    toolEntry({ id: "t1" }),
    toolEntry({ id: "t2", status: "running" }),
  ];
  const html = renderToStaticMarkup(<ToolCallGroup entries={entries} />);
  expect(html).toContain("echo t1");
  expect(html).toContain("echo t2");
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("Hide previous steps");
});

test("ToolCallGroup stamps data-chat-message once on the group root, not on every buried row", () => {
  const entries: TranscriptEntry[] = [toolEntry({ id: "t1" }), toolEntry({ id: "t2" })];
  const html = renderToStaticMarkup(<ToolCallGroup entries={entries} />);
  expect((html.match(/data-chat-message/g) ?? []).length).toBe(1);
});

test("ToolCallRow standalone (run length 1 path) keeps carrying its own data-chat-message", () => {
  const html = renderToStaticMarkup(<ToolCallRow entry={toolEntry({ id: "t1" })} />);
  expect(html).toContain("data-chat-message");
  expect(html).toContain("Ran echo t1");
});

test("ToolCallRow inside a group omits data-chat-message when told to", () => {
  const html = renderToStaticMarkup(<ToolCallRow entry={toolEntry({ id: "t1" })} stampChatMessage={false} />);
  expect(html).not.toContain("data-chat-message");
});
