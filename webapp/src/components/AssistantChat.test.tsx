import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMetaBar, ComposerStats, DiffReviewPanel, RunStatusHeader, TodoPanel, TranscriptEntryView, TranscriptTimeline, chatWidthFromClientX, deriveSuggestionChips, detectedPlanDirs, normalizeAssistantSessions, runStatusLabel } from "./AssistantChat";
import type { AgentDTO, TodoPhaseDTO, TranscriptEntry } from "../lib/dto";

test("TranscriptEntryView renders human-first tool output with raw payload tucked away", () => {
  const entry: TranscriptEntry = {
    id: "tool-1",
    kind: "tool",
    text: "▸ bash: Checking processes",
    ts: 1,
    status: "ok",
    tool: {
      callId: "tool-1",
      name: "bash",
      argsText: JSON.stringify({ command: "ps -ef" }),
      partialText: JSON.stringify({ stdout: "running" }),
      resultText: JSON.stringify({ stdout: "UID PID CMD\\nlars 42 ps -ef", exitCode: 0 }),
    },
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("Tool");
  expect(html).toContain("Ran ps -ef");
  expect(html).toContain("UID PID CMD");
  expect(html).toContain("Exit 0");
  expect(html).toContain("Raw payload");
});

test("TranscriptEntryView renders foldable streaming thinking", () => {
  const entry: TranscriptEntry = {
    id: "think-1",
    kind: "thinking",
    text: "I need to inspect the running processes first.",
    ts: 1,
    status: "running",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("<details open");
  expect(html).toContain("Thinking");
  expect(html).toContain("streaming");
  expect(html).toContain("running processes");
});

test("TodoPanel renders persistent beautiful progress and can collapse", () => {
  const phases: TodoPhaseDTO[] = [{
    name: "Implementation",
    tasks: [
      { content: "Wire todo state", status: "completed" },
      { content: "Render sticky panel", status: "in_progress" },
      { content: "Polish spacing", status: "pending" },
    ],
  }];

  const expanded = renderToStaticMarkup(<TodoPanel phases={phases} collapsed={false} onToggle={() => {}} />);
  expect(expanded).toContain("Todo");
  expect(expanded).toContain("1/3");
  expect(expanded).toContain("Render sticky panel");
  expect(expanded).toContain("Polish spacing");

  const collapsed = renderToStaticMarkup(<TodoPanel phases={phases} collapsed={true} onToggle={() => {}} />);
  expect(collapsed).toContain("Render sticky panel");
  expect(collapsed).not.toContain("Polish spacing");
});

test("AgentMetaBar keeps only compact git branch status at the top", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "working",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    branch: "squad/chat",
    model: "openai/gpt-5.5",
    contextPct: 0.73,
    receipt: { toolCalls: 4, tokens: 12345, durationMs: 65_000 },
    pending: [],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "fresh",
    availableActions: ["prompt", "answer", "interrupt", "verify", "land", "set-mode"],
  };

  const html = renderToStaticMarkup(<AgentMetaBar agent={agent} changedFiles={2} />);
  expect(html).toContain("squad/chat · 2 changed");
  expect(html).not.toContain("openai/gpt-5.5");
});

test("ComposerStats renders ultra-compact context, tokens, tools, and time", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "working",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    contextPct: 0.777,
    contextWindow: 272_000,
    receipt: { toolCalls: 8, tokens: 500_200, durationMs: 1_959_000 },
    pending: [],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "unknown",
    availableActions: ["set-mode"],
  };

  const html = renderToStaticMarkup(<ComposerStats agent={agent} />);
  expect(html).toContain("77.7%/272.0K");
  expect(html).toContain("500.2K tok");
  expect(html).toContain("8 tools");
  expect(html).toContain("32m 39s");
});

test("RunStatusHeader labels live work with shimmer action", () => {
  const html = renderToStaticMarkup(<RunStatusHeader running elapsedMs={37_000} action="Thinking" expanded onToggle={() => {}} />);
  expect(html).toContain("Working for 37s");
  expect(html).toContain("Thinking");
  expect(html).toContain("shimmer");
  expect(runStatusLabel(false, 391_000)).toBe("Worked for 6m 31s");
});

test("TranscriptTimeline collapses completed work and keeps final summary visible", () => {
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "Make layout compact", ts: 1, status: "ok" },
    { id: "t1", kind: "thinking", text: "Inspecting files", ts: 2, status: "ok" },
    { id: "a1", kind: "assistant", text: "Done. Tightened the UI.", ts: 3, status: "ok" },
  ];

  const html = renderToStaticMarkup(
    <TranscriptTimeline
      entries={entries}
      messages={[]}
      now={3}
      diffs={[{ file: "webapp/src/index.css", status: "M", diff: "+ .shimmer" }]}
      expanded={false}
      onToggle={() => {}}
    />,
  );

  expect(html).toContain("Make layout compact");
  expect(html).toContain("Worked for");
  expect(html).not.toContain("Inspecting files");
  expect(html).toContain("Done. Tightened the UI.");
  expect(html).toContain("Review diff");
});

test("DiffReviewPanel renders compact changed-file access", () => {
  const html = renderToStaticMarkup(<DiffReviewPanel diffs={[{ file: "README.md", status: "M", diff: "+ compact chat" }]} />);
  expect(html).toContain("1 changed file");
  expect(html).toContain("README.md");
  expect(html).toContain("+ compact chat");
});

test("chatWidthFromClientX clamps dragged assistant width", () => {
  expect(chatWidthFromClientX(1200, 700)).toBe(500);
  expect(chatWidthFromClientX(1200, 1000)).toBe(320);
  expect(chatWidthFromClientX(1200, 100)).toBe(680);
});

test("normalizeAssistantSessions falls back when restored chat state is empty or stale", () => {
  expect(normalizeAssistantSessions([], 42)[0]).toMatchObject({ id: "default", title: "Initial conversation", updatedAt: 42 });
  expect(normalizeAssistantSessions([{ id: "s2", title: "Newer", messages: [], updatedAt: 2 }, { id: "s1", title: "Older", messages: [], updatedAt: 1 }])[0]?.id).toBe("s2");
  expect(normalizeAssistantSessions([{ id: "bad", messages: [], updatedAt: 1 }], 7)[0]).toMatchObject({ id: "default", updatedAt: 7 });
});

test("deriveSuggestionChips adapts to UI/UX chat context", () => {
  const suggestions = deriveSuggestionChips({
    messages: [{ role: "user", text: "I want to talk to the UI/UX designer agent about this flow.", timestamp: 1 }],
    transcriptEntries: [],
  });

  expect(suggestions.map((item) => item.label)).toContain("Surface UX blind spots");
  expect(suggestions.map((item) => item.label)).toContain("Ask the designer agent");
});

test("detectedPlanDirs finds plan files in tool payloads", () => {
  const entries: TranscriptEntry[] = [{
    id: "write-1",
    kind: "tool",
    text: "▸ write",
    ts: 1,
    status: "ok",
    tool: {
      callId: "write-1",
      name: "write",
      argsText: JSON.stringify({ path: "/repo/plans/live-plan/00-overview.md" }),
    },
  }];

  expect(detectedPlanDirs(entries)).toEqual(["plans/live-plan"]);
});
