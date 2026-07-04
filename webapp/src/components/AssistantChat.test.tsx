import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMetaBar, ChatMessagesViewport, ComposerSendButton, ComposerStats, DiffReviewPanel, GateWidget, RunStatusHeader, TodoPanel, TranscriptEntryView, TranscriptTimeline, chatWidthFromClientX, deriveSuggestionChips, detectedPlanDirs, normalizeAssistantSessions, runStatusLabel } from "./AssistantChat";
import { ScrollToLatestPill } from "./chat/ScrollToLatestPill";
import type { AgentDTO, PendingRequest, TodoPhaseDTO, TranscriptEntry } from "../lib/dto";

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
  expect(html).toContain("Bash"); // human tool name, not the raw "bash"
  expect(html).toContain("Ran ps -ef");
  expect(html).toContain("UID PID CMD");
  expect(html).toContain("exit 0");
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
  expect(html).toContain("<details data-chat-message");
  expect(html).toContain('open=""');
  expect(html).toContain("Thinking");
  expect(html).toContain("streaming");
  expect(html).toContain("running processes");
});

test("TranscriptEntryView is memoized (same entry identity renders identical markup twice)", () => {
  const entry: TranscriptEntry = {
    id: "a1",
    kind: "assistant",
    text: "Done. Tightened the UI.",
    ts: 1,
    status: "ok",
  };

  const first = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  const second = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(second).toBe(first);
  expect((TranscriptEntryView as unknown as { $$typeof?: symbol }).$$typeof?.toString()).toContain("react.memo");
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

test("data-chat-message is stamped on every TranscriptEntryView kind", () => {
  const kinds: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "hi", ts: 1, status: "ok" },
    { id: "a1", kind: "assistant", text: "hello", ts: 2, status: "ok" },
    { id: "th1", kind: "thinking", text: "pondering", ts: 3, status: "ok" },
    { id: "to1", kind: "tool", text: "▸ bash: ls", ts: 4, status: "ok", tool: { callId: "to1", name: "bash", argsText: "{}" } },
    { id: "sy1", kind: "system", text: "note", ts: 5, status: "ok" },
  ];

  for (const entry of kinds) {
    const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
    expect(html).toContain("data-chat-message");
  }
});

test("data-chat-message is stamped on the workflow stage-marker branch of the tool kind", () => {
  const entry: TranscriptEntry = { id: "stage1", kind: "tool", text: "▸ stage: implement", ts: 1, status: "ok", format: "stage" };
  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("data-chat-message");
  expect(html).toContain("implement");
});

test("data-chat-message is stamped on GateWidget (both the options and free-text branches)", () => {
  const withOptions: PendingRequest = { id: "p1", source: "ui", kind: "gate", title: "Pick one", options: ["yes", "no"], createdAt: 1 };
  const optionsHtml = renderToStaticMarkup(<GateWidget request={withOptions} onAnswer={() => {}} />);
  expect(optionsHtml).toContain("data-chat-message");
  expect(optionsHtml).toContain("Pick one");

  const freeText: PendingRequest = { id: "p2", source: "ui", kind: "gate", title: "Type a reply", createdAt: 1 };
  const freeTextHtml = renderToStaticMarkup(<GateWidget request={freeText} onAnswer={() => {}} />);
  expect(freeTextHtml).toContain("data-chat-message");
  expect(freeTextHtml).toContain("Type a reply");
});

test("data-chat-message is stamped on DiffReviewPanel", () => {
  const html = renderToStaticMarkup(<DiffReviewPanel diffs={[{ file: "a.ts", status: "M" }]} />);
  expect(html).toContain("data-chat-message");
});

test("a gate appearing mid-transcript still carries data-chat-message (detection must catch it while scrolled up)", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "waiting",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    pending: [{ id: "req-1", source: "tool", kind: "gate", title: "Approve this?", createdAt: 1 }],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "unknown",
    availableActions: ["answer"],
  };
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "Do the thing", ts: 1, status: "ok" },
    { id: "sys1", kind: "system", text: "Waiting for approval", ts: 2, status: "ok", pending: { action: "created", requestId: "req-1" } },
  ];

  const html = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} messages={[]} agent={agent} expanded onToggle={() => {}} onAnswer={() => {}} />,
  );
  expect(html).toContain("Approve this?");
  // Both the system entry and the gate widget it triggers must be detectable.
  expect((html.match(/data-chat-message/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test("ScrollToLatestPill renders only when visible and carries an accessible label", () => {
  const hidden = renderToStaticMarkup(<ScrollToLatestPill visible={false} onClick={() => {}} />);
  expect(hidden).toBe("");

  const shown = renderToStaticMarkup(<ScrollToLatestPill visible onClick={() => {}} />);
  expect(shown).toContain("New messages");
  expect(shown).toContain('aria-label="Jump to latest messages"');
});

test("ComposerSendButton shows send when the agent isn't running, and disables it without input", () => {
  const disabled = renderToStaticMarkup(<ComposerSendButton isStopShown={false} stopPending={false} canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(disabled).toContain('aria-label="Send message"');
  expect(disabled).toContain("disabled");
  expect(disabled).not.toContain("Stop");

  const enabled = renderToStaticMarkup(<ComposerSendButton isStopShown={false} stopPending={false} canSend onSend={() => {}} onStop={() => {}} />);
  expect(enabled).toContain('aria-label="Send message"');
  expect(enabled).not.toContain("disabled");
});

test("ComposerSendButton swaps to a stop affordance while the agent is running, and debounces into a disabled stopping state", () => {
  const running = renderToStaticMarkup(<ComposerSendButton isStopShown stopPending={false} canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(running).toContain('aria-label="Stop"');
  expect(running).not.toContain('aria-label="Send message"');
  expect(running).not.toContain("disabled");

  const pending = renderToStaticMarkup(<ComposerSendButton isStopShown stopPending canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(pending).toContain("Stopping");
  expect(pending).toContain("disabled");
});

test("ChatMessagesViewport's scroll container is an announced log region, aria-busy only while an entry is running", () => {
  const runningEntries: TranscriptEntry[] = [{ id: "e1", kind: "assistant", text: "working…", ts: 1, status: "running" }];
  const settledEntries: TranscriptEntry[] = [{ id: "e2", kind: "assistant", text: "done", ts: 1, status: "ok" }];

  const running = renderToStaticMarkup(
    <ChatMessagesViewport
      hasTranscript
      transcriptEntries={runningEntries}
      messages={[]}
      agentDiffs={[]}
      workExpanded={false}
      onToggleWork={() => {}}
      visibleMessages={[]}
      isLoading={false}
      toggleReaction={() => {}}
    />,
  );
  expect(running).toContain('role="log"');
  expect(running).toContain('aria-live="polite"');
  expect(running).toContain('aria-busy="true"');
  expect(running).toContain('tabindex="0"');

  const settled = renderToStaticMarkup(
    <ChatMessagesViewport
      hasTranscript
      transcriptEntries={settledEntries}
      messages={[]}
      agentDiffs={[]}
      workExpanded={false}
      onToggleWork={() => {}}
      visibleMessages={[]}
      isLoading={false}
      toggleReaction={() => {}}
    />,
  );
  expect(settled).toContain('aria-busy="false"');
});

test("each transcript entry is wrapped in an <article> naming its sender", () => {
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "hi", ts: 1, status: "ok" },
    { id: "a1", kind: "assistant", text: "hello", ts: 2, status: "ok" },
  ];
  const html = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} messages={[]} expanded onToggle={() => {}} />,
  );
  expect(html).toContain('<article aria-label="Message from you">');
  expect(html).toContain('<article aria-label="Message from glance">');
});

test("attach and mic buttons are gone from the composer's rendered subtree (no more misleading no-ops)", () => {
  // The composer's send/stop control no longer ships alongside decorative attach/mic buttons;
  // ComposerSendButton is the sole action rendered in that slot.
  const html = renderToStaticMarkup(<ComposerSendButton isStopShown={false} stopPending={false} canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(html).not.toContain('aria-label="Attach file"');
  expect(html).not.toContain('aria-label="Voice input"');
});

test("a running assistant entry with an unclosed table header holds it back until the separator arrives", () => {
  const entry: TranscriptEntry = {
    id: "a1",
    kind: "assistant",
    text: "First paragraph settled.\n\n| a | b |",
    ts: 1,
    status: "running",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("First paragraph settled");
  // Lone table header without its separator row is held back — no raw `|` table markup leaks.
  expect(html).not.toContain("<table>");
  expect(html).not.toContain("| a | b |");
});

test("a running assistant entry with a trailing unclosed emphasis marker auto-closes rather than leaking raw asterisks", () => {
  const entry: TranscriptEntry = {
    id: "a1b",
    kind: "assistant",
    text: "First paragraph settled.\n\nThis is **unclosed",
    ts: 1,
    status: "running",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("First paragraph settled");
  // The trailing unclosed ** is auto-closed rather than rendered as literal asterisks.
  expect(html).not.toContain("**unclosed");
  expect(html).toContain("<strong>unclosed</strong>");
});

test("a completed assistant entry renders full raw text in one pass, untrimmed", () => {
  const entry: TranscriptEntry = {
    id: "a2",
    kind: "assistant",
    text: "Done. Trailing unclosed **bold stays as authored.",
    ts: 1,
    status: "ok",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  // Completed entries are never trimmed — remark renders the malformed markdown as-is.
  expect(html).toContain("Trailing unclosed");
});

test("the settled markdown prefix is memoized: identical settled text renders identical markup across renders with a growing tail", () => {
  const base = "Settled paragraph one.\n\nSettled paragraph two.\n\n";
  const entryA: TranscriptEntry = { id: "a3", kind: "assistant", text: base + "gro", ts: 1, status: "running" };
  const entryB: TranscriptEntry = { id: "a3", kind: "assistant", text: base + "growing tail", ts: 1, status: "running" };

  const htmlA = renderToStaticMarkup(<TranscriptEntryView entry={entryA} />);
  const htmlB = renderToStaticMarkup(<TranscriptEntryView entry={entryB} />);

  // Both renders share the identical settled-prefix markup; only the tail differs.
  expect(htmlA).toContain("Settled paragraph one");
  expect(htmlA).toContain("Settled paragraph two");
  expect(htmlB).toContain("Settled paragraph one");
  expect(htmlB).toContain("Settled paragraph two");
  expect(htmlB).toContain("growing tail");
});
